import "server-only";
import { FieldValue, type DocumentReference, type DocumentSnapshot, type Transaction } from "firebase-admin/firestore";
import { fsdb } from "./admin";

/**
 * 「種類・対象ごとに1件」の記録（決済要確認・決済監視で共通）。同じ記録はくり返しても1件のまま、回数と最後の日時だけを更新する。
 *  reopen = "on_change" … 確認済みの後、内容（causeKey）が変わったときだけ未確認に戻す（決済要確認）
 *  reopen = "always"    … 確認済みの後に、もう一度起きたら未確認に戻す（決済監視：新しい障害として扱う）
 * 記録を待つのは timeoutMs まで（Firestore に接続できないときに、決済・Webhook の応答を止めない）。
 * 失敗・時間切れは例外にせず false を返す（呼び出し側がサーバーのログに残す）。
 */
type DedupeOpts = {
  causeKey: string;
  reopen: "on_change" | "always";
  now?: Date;
  /** 回数のほかに加算するフィールド（例：間引いた記録の、実際に観測した件数） */
  add?: Record<string, number>;
  /**
   * false：記録がすでにあれば回数（occurrences）を増やさない（最後の日時・内容の更新と、内容が変わったときの未確認への戻しは行う）。
   * 同じ観測を見分ける手がかり（通知の ID など）が無い呼び出しで、くり返しの確認のたびに回数が増えないようにする。既定は true（数える）
   */
  countRepeat?: boolean;
};

/**
 * 同じ観測（例：同じ Stripe の通知）を1回だけ数えるための印。記録とは別の文書（例：webhookEvents/{決済会社_通知ID}）の
 * 一覧の項目（field）に、記録の ID（id）を残す。記録の更新と印の追加は同じトランザクションで行う（両方か、どちらも無しか）。
 *  - 印の一覧に id がある → 記録済み。何も書かない（回数・確認済みの状態を変えない）
 *  - legacyKey が記録の recentOccurrenceKeys（以前の方式。新しくは追記しない）にある → 記録済みとして扱う（同上）
 *  - 印の文書が無い → 例外（OccurrenceMarkerMissing）。回数を増やさず、新しい観測とも決めつけない（呼び出し側が再試行する）
 * 一覧は古いものを消さない（件数で切り捨てない）。
 */
export type OccurrenceMarker = { ref: DocumentReference; field: string; id: string; legacyKey?: string };

/**
 * 今の記録（cur）から、書き込む内容を決める（upsertDedupedRecord・upsertDedupedRecordInTx で共通）。
 * 無ければ未確認で作成。あれば回数・最後の日時を更新し、確認済みなら reopen の規則で未確認に戻すかを決める。
 */
function dedupedWrite(cur: DocumentSnapshot, fields: Record<string, unknown>, opts: DedupeOpts): { create: Record<string, unknown> } | { update: Record<string, unknown> } | null {
  const now = opts.now ?? new Date();
  const add = opts.add ?? {};
  if (!cur.exists) return { create: { ...fields, ...add, causeKey: opts.causeKey, status: "OPEN", occurrences: 1, firstSeenAt: now, lastSeenAt: now, resolvedAt: null, resolvedBy: null } };
  const reopen = cur.get("status") === "RESOLVED" && (opts.reopen === "always" || cur.get("causeKey") !== opts.causeKey);
  const inc = Object.fromEntries(Object.entries(add).map(([k, v]) => [k, FieldValue.increment(v)]));
  return { update: { ...fields, ...inc, causeKey: opts.causeKey, ...(opts.countRepeat === false ? {} : { occurrences: FieldValue.increment(1) }), lastSeenAt: now, ...(reopen ? { status: "OPEN", resolvedAt: null, resolvedBy: null } : {}) } };
}

/**
 * 呼び出し側のトランザクションの中で記録する（決済記録などの更新と不可分にするため）。
 * cur は同じトランザクションで、書き込みの前に読んだ記録（tx.get(ref)）。書き込みは確定（コミット）したときだけ反映されるので、
 * トランザクションのやり直しで回数が増えることはない。失敗はトランザクション全体の失敗になる（例外は呼び出し側に伝わる）。
 */
export function upsertDedupedRecordInTx(tx: Transaction, ref: DocumentReference, cur: DocumentSnapshot, fields: Record<string, unknown>, opts: DedupeOpts): void {
  if (cur.ref.path !== ref.path) throw new Error("deduped record snapshot does not match the reference");
  writeDeduped(tx, ref, cur, fields, opts);
}

const stringsOf = (v: unknown): string[] => (Array.isArray(v) ? v.filter((k): k is string => typeof k === "string") : []);

function writeDeduped(tx: Transaction, ref: DocumentReference, cur: DocumentSnapshot, fields: Record<string, unknown>, opts: DedupeOpts): void {
  const w = dedupedWrite(cur, fields, opts);
  if (!w) return;
  if ("create" in w) tx.create(ref, w.create);
  else tx.update(ref, w.update);
}

export async function upsertDedupedRecord(
  ref: DocumentReference,
  fields: Record<string, unknown>,
  opts: DedupeOpts & {
    timeoutMs: number;
    /** 待つのをやめた後に、書き込みの結果が分かったときに呼ばれる（committed＝保存された、failed＝保存されなかった） */
    onSettledAfterTimeout?: (result: "committed" | "failed") => void;
    /** 同じ観測を1回だけ数えるための印（OccurrenceMarker）。省略すると、呼ばれるたびに数える */
    occurrenceMarker?: OccurrenceMarker;
  },
): Promise<DedupedRecordResult> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  try {
    const m = opts.occurrenceMarker;
    const work = fsdb().runTransaction(async (tx) => {
      // 書き込みの前にすべて読む（記録と、同じ観測の印の文書）
      const [cur, mark] = await Promise.all([tx.get(ref), m ? tx.get(m.ref) : Promise.resolve(null)]);
      if (!m || !mark) return writeDeduped(tx, ref, cur, fields, opts);
      if (!mark.exists) throw Object.assign(new Error("occurrence marker document is missing"), { name: "OccurrenceMarkerMissing" });
      const marked = stringsOf(mark.get(m.field));
      if (marked.includes(m.id)) return; // この観測は記録済み
      if (m.legacyKey && stringsOf(cur.exists ? cur.get("recentOccurrenceKeys") : undefined).includes(m.legacyKey)) return; // 以前の方式で記録済み
      writeDeduped(tx, ref, cur, fields, opts);
      tx.update(m.ref, { [m.field]: [...marked, m.id] });
    });
    // 時間切れの後も書き込みは止まらない（Firestore のトランザクションは中止できない）。結果だけを知らせ、未処理の例外にしない
    work.then(
      () => timedOut && opts.onSettledAfterTimeout?.("committed"),
      () => timedOut && opts.onSettledAfterTimeout?.("failed"),
    );
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        timedOut = true;
        reject(Object.assign(new Error("record timed out"), { name: "TimeoutError" }));
      }, opts.timeoutMs);
    });
    await Promise.race([work, timeout]);
    return { ok: true };
  } catch (e) {
    // 待つのをやめた（時間切れ）は「保存されたか不明」。書き込みが失敗した（例外）は「保存されていない」
    return timedOut ? { ok: false, error: "TimeoutError", unknown: true } : { ok: false, error: (e as Error)?.name ?? "Error", unknown: false };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * 記録の結果。unknown=true は、待つのをやめた（時間切れ）ので保存されたかどうか分からないこと（裏で書き込みが続き、後で保存されることがある）。
 * unknown=false は、書き込みが失敗して保存されていないこと。
 */
export type DedupedRecordResult = { ok: true } | { ok: false; error: string; unknown: boolean };
