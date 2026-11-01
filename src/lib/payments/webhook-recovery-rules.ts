/**
 * Stripe の Webhook の通知の復旧（webhook-recovery.ts）の規則（Firestore・Stripe には接続しない）。
 *
 * 復旧の対象は、webhookEvents に記録があり、処理済み（processedAt）ではない通知だけ（署名を確認して受信した通知の ID）。
 * 処理は、Stripe API から通知を取り直し（events.retrieve）、Webhook と同じ処理（processStripeEvent。処理権・環境・冪等性）に渡す。
 * 自動の復旧（定期処理）は、次をすべて満たす通知だけを、1回の実行で決まった件数まで、時間の上限の中で処理する：
 *  - 最後に処理を始めてから RECOVERY_STALE_MS 以上たった、RECEIVED（途中で止まった）か RETRYABLE（失敗した）
 *  - 期限内の処理権が無い（処理中ではない）
 *  - 復旧を試した回数が RECOVERY_MAX_AUTO_ATTEMPTS 未満、最後に試してから RECOVERY_BACKOFF_MS 以上たった
 *  - モードが今の接続と同じ（記録に無ければ試す。取り直した通知のモードでも確かめる）
 * 候補は「試した回数の少ない順・最後に試した時刻の古い順（未実施が先）・作成の古い順」に並べる
 * （復旧できない古い通知が、後の通知を毎回の上限から追い出し続けないように）。
 */
export const RECOVERY_STALE_MS = 30 * 60 * 1000;
export const RECOVERY_BACKOFF_MS = 20 * 60 * 60 * 1000;
export const RECOVERY_MAX_AUTO_ATTEMPTS = 5;
/** 1回の自動の復旧で処理する通知の上限 */
export const RECOVERY_MAX_EVENTS = 20;
/** 1回の自動の復旧で読む未処理の記録のページの上限（1ページ100件） */
export const RECOVERY_MAX_PAGES = 5;
/**
 * 自動の復旧の開始からこの時間を過ぎたら、新しい通知の処理を始めない（始めた通知の処理は途中で止めない）。
 * 関数全体の終了の時間は保証しない：先に実行するメンテナンスと、始めた通知の処理（Stripe API・Firestore）を合わせると、
 * 定期処理の maxDuration（300秒）を超えて打ち切られることがある。打ち切られた通知は processedAt が無いまま残り、
 * 処理権の期限の後の再送・復旧で処理し直す（docs/preview-verification.md §12）
 */
export const RECOVERY_DEADLINE_MS = 60 * 1000;

export type WebhookRecoveryResult =
  /** Webhook と同じ処理で処理済みになった */
  | "recovered"
  /** 別の環境の決済の通知として処理済み（IGNORED_OTHER_ENV） */
  | "ignored_other_env"
  /** もう処理済み（何もしない） */
  | "already_processed"
  /** 処理中（期限内の処理権がある）。何もしない */
  | "busy"
  /** 処理に失敗した（RETRYABLE。Webhook と同じく処理済みにしない） */
  | "failed"
  /** Stripe から通知を取得できない（404。保存期間を過ぎた・Stripe のアカウントの設定違いなど、原因は判断しない）。FAILED_PERMANENT（要確認） */
  | "event_unavailable"
  /** Stripe API の呼び出しに失敗した（通信・認証など）。後で試し直す */
  | "stripe_error"
  /** 取り直した通知が記録と一致しない（ID・種類・モード）。処理しない */
  | "event_mismatch"
  /** 記録のモードが今の接続と違う（本番とテストの取り違え）。処理しない */
  | "mode_mismatch"
  /** 記録が無い通知（このアプリが受信していない ID）。処理しない */
  | "not_found";

export const WEBHOOK_RECOVERY_RESULTS: readonly WebhookRecoveryResult[] = [
  "recovered",
  "ignored_other_env",
  "already_processed",
  "busy",
  "failed",
  "event_unavailable",
  "stripe_error",
  "event_mismatch",
  "mode_mismatch",
  "not_found",
];

export const WEBHOOK_RECOVERY_RESULT_LABEL: Record<WebhookRecoveryResult, string> = {
  recovered: "再処理して処理済みにしました",
  ignored_other_env: "別の環境の決済の通知として処理済みにしました（この環境には何も書いていません）",
  already_processed: "すでに処理済みです（何もしていません）",
  busy: "ほかの処理が処理中です（何もしていません）。時間をおいて、もう一度お試しください",
  failed: "再処理に失敗しました（処理済みにしていません）",
  event_unavailable: "Stripe から通知を取得できないため、要確認です（処理済みにしていません）。Stripe の接続の設定と、Stripe のダッシュボードの決済の状態を確認してください",
  stripe_error: "Stripe に接続できませんでした（処理済みにしていません）。時間をおいて、もう一度お試しください",
  event_mismatch: "Stripe の通知が記録と一致しません（処理していません）",
  mode_mismatch: "本番とテストのモードが違う通知です（処理していません）",
  not_found: "この通知の記録がありません（処理していません）",
};

/** Stripe の処理を試した結果（回数に数える）。何もしなかった結果（処理中・処理済み・記録なし）は数えない */
export const isRecoveryAttempt = (r: WebhookRecoveryResult) => r !== "busy" && r !== "already_processed" && r !== "not_found" && r !== "mode_mismatch";

export type RecoveryCandidateInput = {
  eventId: string;
  state: string;
  livemode: boolean | null;
  leaseExpiresAt: Date | null;
  recoveryAttempts: number;
  lastRecoveryAt: Date | null;
  createdAt: Date | null;
};

export type RecoverySkipReason = "lease_active" | "mode_mismatch" | "attempts_exhausted" | "backoff" | "not_retryable";

/** 自動の復旧の対象か（対象でなければ理由） */
export function recoverySkipReason(r: RecoveryCandidateInput, now: Date, mode: "test" | "live"): RecoverySkipReason | null {
  if (r.state !== "RECEIVED" && r.state !== "RETRYABLE") return "not_retryable";
  if (r.leaseExpiresAt && now.getTime() < r.leaseExpiresAt.getTime()) return "lease_active";
  if (r.livemode !== null && r.livemode !== (mode === "live")) return "mode_mismatch";
  if (r.recoveryAttempts >= RECOVERY_MAX_AUTO_ATTEMPTS) return "attempts_exhausted";
  if (r.lastRecoveryAt && now.getTime() - r.lastRecoveryAt.getTime() < RECOVERY_BACKOFF_MS) return "backoff";
  return null;
}

const t = (d: Date | null) => (d ? d.getTime() : -Infinity);

/** 自動の復旧の候補を選び、並べて上限で切る（入力は未処理で時間がたった記録） */
export function selectRecoveryCandidates<T extends RecoveryCandidateInput>(records: T[], now: Date, mode: "test" | "live", max = RECOVERY_MAX_EVENTS): { candidates: T[]; skipped: Record<RecoverySkipReason, number>; overLimit: number } {
  const skipped: Record<RecoverySkipReason, number> = { lease_active: 0, mode_mismatch: 0, attempts_exhausted: 0, backoff: 0, not_retryable: 0 };
  const ok: T[] = [];
  for (const r of records) {
    const why = recoverySkipReason(r, now, mode);
    if (why) skipped[why]++;
    else ok.push(r);
  }
  ok.sort((a, b) => a.recoveryAttempts - b.recoveryAttempts || t(a.lastRecoveryAt) - t(b.lastRecoveryAt) || t(a.createdAt) - t(b.createdAt) || (a.eventId < b.eventId ? -1 : a.eventId > b.eventId ? 1 : 0));
  return { candidates: ok.slice(0, max), skipped, overLimit: Math.max(0, ok.length - max) };
}
