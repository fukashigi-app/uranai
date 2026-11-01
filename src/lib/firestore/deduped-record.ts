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
   * 同じ観測（例：同じ Stripe の通知の ID）を1回だけ数えるためのキー。最近記録したキー（OCCURRENCE_KEYS_KEPT 件）に
   * 含まれていれば何も書かない（記録の後に処理が失敗して同じ通知が再送されても、別の通知と入れ替わりに届いても、回数を増やさない）。
   * 省略すると、呼ばれるたびに数える
   */
  occurrenceKey?: string;
};

/**
 * 今の記録（cur）から、書き込む内容を決める（upsertDedupedRecord・upsertDedupedRecordInTx で共通）。
 * 無ければ未確認で作成。あれば回数・最後の日時を更新し、確認済みなら reopen の規則で未確認に戻すかを決める。
 */
/** 同じ観測を見分けるために残すキーの数（同じ記録に、それより多くの通知が並んで届くことは想定しない） */
export const OCCURRENCE_KEYS_KEPT = 20;

function dedupedWrite(cur: DocumentSnapshot, fields: Record<string, unknown>, opts: DedupeOpts): { create: Record<string, unknown> } | { update: Record<string, unknown> } | null {
  const now = opts.now ?? new Date();
  const add = opts.add ?? {};
  const seen: unknown = cur.exists ? cur.get("recentOccurrenceKeys") : undefined;
  const recent = Array.isArray(seen) ? seen.filter((k): k is string => typeof k === "string") : [];
  if (opts.occurrenceKey && recent.includes(opts.occurrenceKey)) return null; // 同じ観測は記録済み
  const key = opts.occurrenceKey ? { recentOccurrenceKeys: [...recent, opts.occurrenceKey].slice(-OCCURRENCE_KEYS_KEPT) } : {};
  if (!cur.exists) return { create: { ...fields, ...add, ...key, causeKey: opts.causeKey, status: "OPEN", occurrences: 1, firstSeenAt: now, lastSeenAt: now, resolvedAt: null, resolvedBy: null } };
  const reopen = cur.get("status") === "RESOLVED" && (opts.reopen === "always" || cur.get("causeKey") !== opts.causeKey);
  const inc = Object.fromEntries(Object.entries(add).map(([k, v]) => [k, FieldValue.increment(v)]));
  return { update: { ...fields, ...inc, ...key, causeKey: opts.causeKey, occurrences: FieldValue.increment(1), lastSeenAt: now, ...(reopen ? { status: "OPEN", resolvedAt: null, resolvedBy: null } : {}) } };
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

function writeDeduped(tx: Transaction, ref: DocumentReference, cur: DocumentSnapshot, fields: Record<string, unknown>, opts: DedupeOpts): void {
  const w = dedupedWrite(cur, fields, opts);
  if (!w) return;
  if ("create" in w) tx.create(ref, w.create);
  else tx.update(ref, w.update);
}

export async function upsertDedupedRecord(
  ref: DocumentReference,
  fields: Record<string, unknown>,
  opts: DedupeOpts & { timeoutMs: number },
): Promise<{ ok: true } | { ok: false; error: string }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const work = fsdb().runTransaction(async (tx) => {
      writeDeduped(tx, ref, await tx.get(ref), fields, opts);
    });
    work.catch(() => undefined); // 時間切れの後に失敗しても、未処理の例外にしない
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(Object.assign(new Error("record timed out"), { name: "TimeoutError" })), opts.timeoutMs);
    });
    await Promise.race([work, timeout]);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: (e as Error)?.name ?? "Error" };
  } finally {
    if (timer) clearTimeout(timer);
  }
}
