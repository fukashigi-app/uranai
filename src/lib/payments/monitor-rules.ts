/**
 * 決済監視の規則（純粋な関数。単体テスト用に分けている）。
 *
 * 異常の記録（paymentAlerts）は「種類・対象ごとに1件」。くり返しは回数と最後の日時だけを更新する。
 * 監視の点検（runPaymentMonitor）が動いていない・失敗した・一部しか確認できなかったときは、決して「異常なし」と表示しない。
 */

export type PaymentAlertKind =
  | "webhook_signature_invalid"
  | "webhook_processing_failed"
  | "checkout_confirm_failed"
  | "refund_sync_failed"
  | "dispute_sync_failed"
  | "settlement_lock_failed"
  | "payment_review_record_failed"
  | "payment_api_5xx"
  | "checkout_stuck_processing"
  | "paid_without_entitlement"
  | "stripe_paid_not_confirmed"
  | "settlement_inconsistent"
  | "monitor_check_failed";

export const PAYMENT_ALERT_LABEL: Record<PaymentAlertKind, string> = {
  webhook_signature_invalid: "Stripe の Webhook の署名を確認できない通知が届いた（受け付けていません）",
  webhook_processing_failed: "Stripe の Webhook の処理に失敗した（Stripe が再送します）",
  checkout_confirm_failed: "決済の確定（戻り先・状態の確認）に失敗した",
  refund_sync_failed: "返金の反映に失敗した",
  dispute_sync_failed: "異議申し立て（チャージバック）の反映に失敗した",
  settlement_lock_failed: "精算の確定（調整の反映・繰越）に失敗した",
  payment_review_record_failed: "決済要確認の記録に失敗した",
  payment_api_5xx: "決済の API でサーバーのエラー（5xx）が起きた",
  checkout_stuck_processing: "確定待ちのまま一定時間を過ぎた注文がある",
  paid_without_entitlement: "決済の記録はあるが、占い権利が無い",
  stripe_paid_not_confirmed: "Stripe では支払い済みなのに、アプリで決済が確定していない",
  settlement_inconsistent: "確定済みの精算の金額と、取引に記録した支払った額が一致しない",
  monitor_check_failed: "監視の点検の一部が失敗した",
};

/** モード：テスト（Sandbox）・本番（Live）・不明（署名を確認できない通知など） */
export type AlertMode = "test" | "live" | "unknown";
export const ALERT_MODE_LABEL: Record<AlertMode, string> = { test: "テスト", live: "本番", unknown: "不明" };
export const alertModeOf = (livemode: unknown): AlertMode => (livemode === true ? "live" : livemode === false ? "test" : "unknown");

/** 確定待ち（PROCESSING）のまま、この時間を過ぎたら異常とする */
export const STUCK_PROCESSING_MINUTES = 60;
/** 点検でさかのぼる期間 */
export const MONITOR_LOOKBACK_DAYS = 7;
/** 最後の点検からこの時間を過ぎたら「監視が止まっている可能性」とする（毎日1回の点検を想定し、余裕を持たせる） */
export const MONITOR_STALE_HOURS = 26;
/** 点検のロックの有効期限（点検の時間の上限より長く。途中で止まっても、この時間が過ぎれば次の点検を開始できる） */
export const MONITOR_LOCK_TTL_MS = 5 * 60_000;
/** 決済の API の 5xx が1時間にこの回数以上なら「多発」 */
export const API_5XX_ALERT_THRESHOLD = 5;

/**
 * 署名を確認できない通知の記録の間引き（サーバーのインスタンスごと）。
 * 大量に届いても Firestore の同じ記録への書き込みが集中しないよう、書き込みはこの間隔に1回まで。
 * 間の通知はメモリ上で数え、次の書き込みでまとめて加算する（観測した件数）。インスタンスが終了すると未書き込みの分は失われるため、
 * 記録の件数は「少なくとも」の値で、正確な総数ではない。
 */
export const SIGNATURE_ALERT_FLUSH_MS = 60_000;
export type ThrottleState = { pending: number; lastFlushAt: number };
export const newThrottleState = (): ThrottleState => ({ pending: 0, lastFlushAt: Number.NEGATIVE_INFINITY });
/** 1件を数え、書き込む時なら書き込む件数（それまでの未書き込みの分を含む）を返す。書き込まない時は 0 */
export function throttleTick(state: ThrottleState, nowMs: number, intervalMs: number = SIGNATURE_ALERT_FLUSH_MS): number {
  state.pending = Math.min(state.pending + 1, Number.MAX_SAFE_INTEGER);
  if (nowMs - state.lastFlushAt < intervalMs) return 0;
  const n = state.pending;
  state.pending = 0;
  state.lastFlushAt = nowMs;
  return n;
}

/** Webhook の処理に失敗したときの異常の種類（通知の種類から） */
export function alertKindForWebhookEvent(type: string): PaymentAlertKind {
  if (type.startsWith("charge.dispute.")) return "dispute_sync_failed";
  if (type === "charge.refunded" || type === "charge.refund.updated" || type.startsWith("refund.")) return "refund_sync_failed";
  if (type.startsWith("checkout.session.")) return "checkout_confirm_failed";
  return "webhook_processing_failed";
}

/** 1時間ごとのまとめ（日本時間。例：2026-10-27T13）。署名を確認できない通知・5xx の回数を、時間ごとに1件にまとめる */
export function hourBucket(d: Date): string {
  const jst = new Date(d.getTime() + 9 * 3_600_000);
  return jst.toISOString().slice(0, 13);
}

export type MonitorRunStatus = {
  lastStartedAt: Date | null;
  lastFinishedAt: Date | null;
  /** ok … すべて確認して異常なし／issues … 異常あり／partial … 一部を確認できなかった／failed … 点検自体が失敗 */
  lastResult: "ok" | "issues" | "partial" | "failed" | null;
  /** 確認できなかった項目（Stripe の照合を実施していない・モードの違う注文など） */
  unchecked: string[];
  found: number;
  stripeMode: "test" | "live" | null;
  /** 最後に開始した点検が、まだ結果を書いていない（runId が最後の結果の runId と違う） */
  inProgress?: boolean;
};

export type MonitorHealth = { state: "never_run" | "running" | "stale" | "failed" | "partial" | "issues" | "ok"; message: string };

/**
 * 監視の状態の表示。点検が一度も無い・止まっている・失敗・一部だけ、のときは「異常なし」と言わない。
 * 「異常なし」は、最近の点検がすべての項目を確認でき、異常が見つからなかったときだけ。
 */
export function monitorHealth(s: MonitorRunStatus | null, now: Date, openAlerts: number): MonitorHealth {
  if (!s || !s.lastStartedAt) return { state: "never_run", message: "監視の点検がまだ一度も実行されていません。異常の有無は確認できていません。" };
  const startedAgoMs = now.getTime() - s.lastStartedAt.getTime();
  if (s.inProgress || !s.lastFinishedAt || s.lastFinishedAt < s.lastStartedAt) {
    if (startedAgoMs < MONITOR_LOCK_TTL_MS) return { state: "running", message: "監視の点検を実行中です。" };
    return { state: "failed", message: "前回の監視の点検が途中で止まりました。異常の有無は確認できていません。" };
  }
  if (now.getTime() - s.lastFinishedAt.getTime() > MONITOR_STALE_HOURS * 3_600_000) {
    return { state: "stale", message: `最後の監視の点検から${MONITOR_STALE_HOURS}時間以上たっています。監視が止まっている可能性があり、最近の異常の有無は確認できていません。` };
  }
  if (s.lastResult === "failed") return { state: "failed", message: "前回の監視の点検が失敗しました。異常の有無は確認できていません。" };
  if (s.lastResult === "partial" || s.unchecked.length) return { state: "partial", message: `前回の監視の点検では、確認できなかった項目があります（${s.unchecked.join("・") || "不明"}）。` };
  if (s.lastResult === "issues" || openAlerts > 0) return { state: "issues", message: `未確認の異常があります（${openAlerts}件）。` };
  return { state: "ok", message: "前回の監視の点検では、確認したすべての項目で異常は見つかりませんでした。" };
}
