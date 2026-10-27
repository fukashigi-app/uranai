import "server-only";
import { FieldValue, type DocumentReference } from "firebase-admin/firestore";
import { fsdb } from "./admin";

/**
 * 「種類・対象ごとに1件」の記録（決済要確認・決済監視で共通）。同じ記録はくり返しても1件のまま、回数と最後の日時だけを更新する。
 *  reopen = "on_change" … 確認済みの後、内容（causeKey）が変わったときだけ未確認に戻す（決済要確認）
 *  reopen = "always"    … 確認済みの後に、もう一度起きたら未確認に戻す（決済監視：新しい障害として扱う）
 * 記録を待つのは timeoutMs まで（Firestore に接続できないときに、決済・Webhook の応答を止めない）。
 * 失敗・時間切れは例外にせず false を返す（呼び出し側がサーバーのログに残す）。
 */
export async function upsertDedupedRecord(
  ref: DocumentReference,
  fields: Record<string, unknown>,
  opts: { causeKey: string; reopen: "on_change" | "always"; timeoutMs: number; now?: Date; /** 回数のほかに加算するフィールド（例：間引いた記録の、実際に観測した件数） */ add?: Record<string, number> },
): Promise<{ ok: true } | { ok: false; error: string }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const work = fsdb().runTransaction(async (tx) => {
      const cur = await tx.get(ref);
      const now = opts.now ?? new Date();
      const add = opts.add ?? {};
      if (!cur.exists) {
        tx.create(ref, { ...fields, ...add, causeKey: opts.causeKey, status: "OPEN", occurrences: 1, firstSeenAt: now, lastSeenAt: now, resolvedAt: null, resolvedBy: null });
        return;
      }
      const reopen = cur.get("status") === "RESOLVED" && (opts.reopen === "always" || cur.get("causeKey") !== opts.causeKey);
      const inc = Object.fromEntries(Object.entries(add).map(([k, v]) => [k, FieldValue.increment(v)]));
      tx.update(ref, { ...fields, ...inc, causeKey: opts.causeKey, occurrences: FieldValue.increment(1), lastSeenAt: now, ...(reopen ? { status: "OPEN", resolvedAt: null, resolvedBy: null } : {}) });
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
