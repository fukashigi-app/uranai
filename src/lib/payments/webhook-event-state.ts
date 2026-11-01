/**
 * Webhook の通知の処理状態（webhookEvents/{決済会社_イベントID} の state）。判定の規則だけ（Firestore・Stripe には接続しない）。
 *
 *  RECEIVED          … 受信して処理を始めた（処理中、または処理の途中で止まった。lastAttemptAt が古ければ止まったもの）
 *  PROCESSED         … 処理が完了した（processedAt と同時に記録する。processedAt がある記録は常に PROCESSED として扱う）
 *  RETRYABLE         … 処理が失敗した（500 を返した）。Stripe の再送・将来の手動の再実行で処理し直す
 *  FAILED_PERMANENT  … 再試行しても解消しないと判断できる異常（今は安全に判定できる場合が無いので使っていない）
 *  IGNORED_OTHER_ENV … 別の環境の通知として無視した（環境の識別は未実装のため、今は使っていない）
 *
 * 処理済みかどうかの判定（重複の排除・90日の削除）は、今までどおり processedAt だけで行う。state は状態の記録で、
 * 処理済みかどうかの判定には使わない（state だけを見て処理済みにしたり、処理をやめたりしない）。
 */
export const WEBHOOK_EVENT_STATES = ["RECEIVED", "PROCESSED", "RETRYABLE", "FAILED_PERMANENT", "IGNORED_OTHER_ENV"] as const;
export type WebhookEventState = (typeof WEBHOOK_EVENT_STATES)[number];

/**
 * 記録の状態。processedAt があれば PROCESSED（以前の記録には state が無い）。processedAt が無ければ記録の state、
 * 不明な値・項目が無い以前の記録は RECEIVED（処理が終わっていない）として扱う。
 */
export function webhookEventStateOf(d: { state?: unknown; processedAt?: unknown }): WebhookEventState {
  if (d.processedAt) return "PROCESSED";
  if (d.state === "RETRYABLE" || d.state === "FAILED_PERMANENT" || d.state === "IGNORED_OTHER_ENV") return d.state;
  return "RECEIVED";
}

/** 処理が終わっていない記録が、止まったとみなせるほど古いか（最後に処理を始めた時刻、無ければ作成の時刻から） */
export function isStaleUnfinished(d: { state?: unknown; processedAt?: unknown; lastAttemptAt?: Date | null; createdAt?: Date | null }, now: Date, staleMs: number): boolean {
  const st = webhookEventStateOf(d);
  if (st !== "RECEIVED" && st !== "RETRYABLE") return false;
  const at = d.lastAttemptAt ?? d.createdAt ?? null;
  return at !== null && now.getTime() - at.getTime() >= staleMs;
}

const ID_RE = /^[A-Za-z0-9_]{1,200}$/;
const idOrNull = (v: unknown) => (typeof v === "string" && ID_RE.test(v) ? v : null);
const idOfRef = (v: unknown) => idOrNull(typeof v === "string" ? v : v && typeof v === "object" ? (v as { id?: unknown }).id : null);

/** 保存する通知の情報（ID・モード・作成日時だけ。通知の本文・カード情報・個人情報は保存しない） */
export type StripeEventMeta = { objectId: string | null; chargeId: string | null; livemode: boolean | null; eventCreatedAt: Date | null };

/**
 * 署名を確認した Stripe の通知から、状態の記録に残す情報を取り出す（将来の手動の復旧・照合で対象を特定するため）。
 * chargeId：Charge の通知はその ID、返金（refund.*・charge.refund.updated）と異議申し立て（charge.dispute.*）は対象の Charge。
 * Checkout Session の通知には Charge が無いので null。値は形を確かめ、ID 以外は保存しない。
 */
export function stripeEventMeta(event: { type?: unknown; livemode?: unknown; created?: unknown; data?: { object?: unknown } }): StripeEventMeta {
  const obj = (event.data?.object ?? {}) as { id?: unknown; object?: unknown; charge?: unknown };
  const type = typeof event.type === "string" ? event.type : "";
  const objectId = idOrNull(obj.id);
  const chargeId = type.startsWith("charge.dispute.") || type.startsWith("refund.") || type === "charge.refund.updated" ? idOfRef(obj.charge) : type.startsWith("charge.") ? objectId : null;
  const created = typeof event.created === "number" && Number.isSafeInteger(event.created) && event.created > 0 ? new Date(event.created * 1000) : null;
  return { objectId, chargeId, livemode: typeof event.livemode === "boolean" ? event.livemode : null, eventCreatedAt: created };
}

/** 記録するエラーの名前（英数字と記号だけ。エラー文・秘密情報は含めない） */
export function webhookErrorNameOf(e: unknown): string {
  const n = (e as Error)?.name;
  return typeof n === "string" && /^[\w.\-]{1,60}$/.test(n) ? n : "Error";
}

/**
 * 処理が終わっていない通知の一覧（listUnfinishedWebhookEvents）の続きの位置。
 * 最後に読んだ記録の作成の時刻（秒・ナノ秒）と文書の ID だけを、外から中身を気にせず渡せる文字列にする
 * （文書の ID は「決済会社_通知の ID」で、個人情報・秘密情報は含まない）。
 */
export type WebhookEventCursor = { seconds: number; nanoseconds: number; id: string };

const DOC_ID_RE = /^[A-Za-z0-9_]{1,300}$/;

export function encodeWebhookEventCursor(c: WebhookEventCursor): string {
  return Buffer.from(JSON.stringify([c.seconds, c.nanoseconds, c.id]), "utf8").toString("base64url");
}

/** 形の正しくない続きの位置は null（呼び出し側は最初から読み直す。推測で位置を決めない） */
export function decodeWebhookEventCursor(s: unknown): WebhookEventCursor | null {
  if (typeof s !== "string" || s.length === 0 || s.length > 600) return null;
  try {
    const v: unknown = JSON.parse(Buffer.from(s, "base64url").toString("utf8"));
    if (!Array.isArray(v) || v.length !== 3) return null;
    const [seconds, nanoseconds, id] = v;
    if (!Number.isSafeInteger(seconds) || seconds < 0) return null;
    if (!Number.isSafeInteger(nanoseconds) || nanoseconds < 0 || nanoseconds > 999_999_999) return null;
    if (typeof id !== "string" || !DOC_ID_RE.test(id)) return null;
    return { seconds, nanoseconds, id };
  } catch {
    return null;
  }
}
