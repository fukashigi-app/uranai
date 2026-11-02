/**
 * 決済記録の作成の後の再確認（recheckState=PENDING）の自動の回収の規則（純粋な関数。Firestore・Stripe には触れない。単体テスト用に分けている）。
 * 回収の処理は recheck-recovery.ts。決済記録の再確認そのものは既存の confirmStripeCheckout（決済記録がある経路だけ）を使う。
 *
 * 対象（すべて満たすもの）：
 *  - recheckState が PENDING の Stripe の決済記録で、決済のモード（livemode）が今の Stripe との接続と一致する
 *  - 作成から RECHECK_RECOVERY_MIN_AGE_MS 以上たっている（作成の直後の再確認・Webhook の処理とぶつからない）
 *  - 前回の自動の回収から RECHECK_RECOVERY_BACKOFF_MS 以上たっている
 *  - 自動の回収の回数（recheckRecoveryAttempts。確定の処理の recheckAttempts とは別に数える）が RECHECK_RECOVERY_MAX_ATTEMPTS 未満
 *  - Session・PaymentIntent の ID が記録されている（無ければ回収できない記録として数える。確定は試みない）
 */
import { RECHECK_PENDING } from "./stripe-sync-rules";

export const RECHECK_RECOVERY_MIN_AGE_MS = 30 * 60 * 1000;
export const RECHECK_RECOVERY_BACKOFF_MS = 20 * 60 * 60 * 1000;
export const RECHECK_RECOVERY_MAX_ATTEMPTS = 6;
/** 1回の実行で回収を試す件数の上限 */
export const RECHECK_RECOVERY_MAX_ITEMS = 10;
/** 開始からこの時間を過ぎたら、新しい決済記録の回収を始めない（始めた回収は最後まで行う） */
export const RECHECK_RECOVERY_DEADLINE_MS = 60 * 1000;
/** 1回の読み込みの件数と、1回の実行で読むページの上限（読んだ記録は対象外でも続きの位置を進める） */
export const RECHECK_RECOVERY_PAGE_SIZE = 50;
export const RECHECK_RECOVERY_MAX_PAGES = 4;

export type RecheckRecoverySkipReason = "not_pending" | "not_stripe" | "mode_mismatch" | "too_new" | "backoff" | "max_attempts" | "invalid_record" | "manual_running";

/** 決済監視：作成からこの時間を過ぎた PENDING を異常として記録する */
export const RECHECK_ALERT_MIN_AGE_MS = 60 * 60 * 1000;
/** 自動の回収の試行が started のまま、この時間を過ぎたら「止まった」とみなす（関数の上限 300秒より十分長い） */
export const RECHECK_STALLED_MS = 30 * 60 * 1000;
/** 運営の手動の再確認：実行中の印の期限（同じ決済記録の二重の実行を防ぐ。止まっても期限で外れる） */
export const RECHECK_MANUAL_LEASE_MS = 5 * 60 * 1000;
/** 運営の手動の再確認：作成からこの時間は実行しない（作成の直後の確定・再確認とぶつからない） */
export const RECHECK_MANUAL_MIN_AGE_MS = 5 * 60 * 1000;

export type RecheckRecoveryCandidate = {
  paymentProvider: unknown;
  recheckState: unknown;
  livemode: unknown;
  createdAt: Date | null;
  recoveryAttempts: unknown;
  recoveryLastAt: Date | null;
  sessionId: unknown;
  paymentIntentId: unknown;
  /** 自動の回収の最後の結果（started のままなら試行の途中で止まった可能性） */
  recoveryLastResult?: unknown;
  /** 運営の手動の再確認の実行中の印の期限 */
  manualUntil?: Date | null;
};

const attemptsOf = (v: unknown) => (typeof v === "number" && Number.isSafeInteger(v) && v > 0 ? v : 0);

/** 自動の回収の対象でない理由（null なら対象）。isSessionId は Session の ID がこのモードの形か（isStripeSessionId） */
export function recheckRecoverySkipReason(c: RecheckRecoveryCandidate, now: Date, mode: "test" | "live", isSessionId: (v: unknown) => boolean): RecheckRecoverySkipReason | null {
  // 検索の条件（recheckState == "PENDING"）と同じく、値が PENDING そのものの記録だけ（想定外の値・値の無い以前の記録は対象外）
  if (c.recheckState !== RECHECK_PENDING) return "not_pending";
  if (c.paymentProvider !== "stripe") return "not_stripe";
  if (typeof c.livemode !== "boolean" || c.livemode !== (mode === "live")) return "mode_mismatch";
  if (!c.createdAt || !isSessionId(c.sessionId) || typeof c.paymentIntentId !== "string" || !/^pi_[A-Za-z0-9_]+$/.test(c.paymentIntentId)) return "invalid_record";
  if (now.getTime() - c.createdAt.getTime() < RECHECK_RECOVERY_MIN_AGE_MS) return "too_new";
  if (attemptsOf(c.recoveryAttempts) >= RECHECK_RECOVERY_MAX_ATTEMPTS) return "max_attempts";
  // 運営が手動で再確認している間は、自動の回収は試さない（同じ決済記録の二重の実行を防ぐ）
  if (c.manualUntil && now.getTime() < c.manualUntil.getTime()) return "manual_running";
  if (c.recoveryLastAt && now.getTime() - c.recoveryLastAt.getTime() < RECHECK_RECOVERY_BACKOFF_MS) return "backoff";
  return null;
}

/**
 * 1件の回収の結果。
 *  done          … 再確認が完了した（DONE）。別の処理が先に完了していた場合も含む
 *  pending       … 再確認を試したが完了しなかった（PENDING のまま。次回以降・運営の確認）
 *  rejected      … 決済の確定の処理が拒否した（決済記録が無い・Session と決済が一致しないなど。異常として運営の確認が必要）
 *  error         … Stripe API・Firestore の例外（PENDING のまま。試行の回数は先に記録済み）
 */
export type RecheckRecoveryResult = "done" | "pending" | "rejected" | "error";
export const RECHECK_RECOVERY_RESULTS: readonly RecheckRecoveryResult[] = ["done", "pending", "rejected", "error"];

/** 決済の確定の処理の結果から、回収の結果を決める（確定の処理は決済記録がある経路だけで呼ぶ） */
export function recheckRecoveryResultOf(r: { status: string; recheck?: "done" | "pending" | "not_pending" }): RecheckRecoveryResult {
  // 決済記録がある経路は duplicate・refunded だけ。confirmed（新しく作成）・not_paid・rejected は異常として扱う
  if (r.status !== "duplicate" && r.status !== "refunded") return "rejected";
  if (r.recheck === "pending") return "pending";
  return "done"; // done、または not_pending（別の処理が先に完了・PENDING でなくなっていた）
}

/**
 * 決済監視・運営画面での PENDING の区別（null なら異常として扱わない：PENDING でない・作成から60分未満）。
 *  rejected  … 自動の回収で確定の処理が拒否した（決済記録が無い・Session と決済が一致しないなど。運営の確認が必要）
 *  stalled   … 自動の回収の試行が started のまま止まった（関数の打ち切りなど）
 *  exhausted … 自動の回収が上限の回数に達した（手動で再確認できる）
 *  pending   … 自動の回収の対象（次の定期処理で試す）
 */
export type PendingRecheckStatus = "pending" | "exhausted" | "rejected" | "stalled";
export function classifyPendingRecheck(c: RecheckRecoveryCandidate, now: Date): PendingRecheckStatus | null {
  if (c.recheckState !== RECHECK_PENDING || !c.createdAt) return null;
  if (now.getTime() - c.createdAt.getTime() < RECHECK_ALERT_MIN_AGE_MS) return null;
  if (c.recoveryLastResult === "rejected") return "rejected";
  if (c.recoveryLastResult === "started" && (!c.recoveryLastAt || now.getTime() - c.recoveryLastAt.getTime() >= RECHECK_STALLED_MS)) return "stalled";
  if (attemptsOf(c.recoveryAttempts) >= RECHECK_RECOVERY_MAX_ATTEMPTS) return "exhausted";
  return "pending";
}

export const PENDING_RECHECK_STATUS_LABEL: Record<PendingRecheckStatus, string> = {
  pending: "自動の回収の対象（次の定期処理で再確認）",
  exhausted: `自動の回収が${RECHECK_RECOVERY_MAX_ATTEMPTS}回で終了（手動で再確認できます）`,
  rejected: "確定の処理が拒否（決済記録・Session・決済の食い違い。運営の確認が必要）",
  stalled: "自動の回収の試行が途中で停止（次の定期処理・手動で再確認できます）",
};

/** 運営の手動の再確認を実行できない理由（null なら実行できる）。回数の上限・間隔待ちは対象外（運営は上限の後も実行できる） */
export type ManualRecheckBlock = "not_pending" | "not_stripe" | "mode_mismatch" | "invalid_record" | "too_new" | "manual_running" | "auto_running";
export function manualRecheckBlock(c: RecheckRecoveryCandidate, now: Date, mode: "test" | "live", isSessionId: (v: unknown) => boolean): ManualRecheckBlock | null {
  if (c.recheckState !== RECHECK_PENDING) return "not_pending";
  if (c.paymentProvider !== "stripe") return "not_stripe";
  if (typeof c.livemode !== "boolean" || c.livemode !== (mode === "live")) return "mode_mismatch";
  if (!c.createdAt || !isSessionId(c.sessionId) || typeof c.paymentIntentId !== "string" || !/^pi_[A-Za-z0-9_]+$/.test(c.paymentIntentId)) return "invalid_record";
  if (now.getTime() - c.createdAt.getTime() < RECHECK_MANUAL_MIN_AGE_MS) return "too_new";
  if (c.manualUntil && now.getTime() < c.manualUntil.getTime()) return "manual_running";
  // 自動の回収の試行の途中（started で、止まったとみなす時間より前）
  if (c.recoveryLastResult === "started" && c.recoveryLastAt && now.getTime() - c.recoveryLastAt.getTime() < RECHECK_STALLED_MS) return "auto_running";
  return null;
}

export const MANUAL_RECHECK_BLOCK_LABEL: Record<ManualRecheckBlock, string> = {
  not_pending: "再確認はすでに完了しています（何もしていません）。",
  not_stripe: "Stripe の決済ではないため、再確認できません（何もしていません）。",
  mode_mismatch: "Stripe の接続とモード（テスト・本番）が違う決済のため、再確認できません（何もしていません）。",
  invalid_record: "決済記録に Session・決済の ID が無いため、再確認できません（何もしていません）。",
  too_new: "作成の直後のため、まだ再確認しません。数分後にもう一度お試しください（何もしていません）。",
  manual_running: "ほかの運営の再確認を実行中です（何もしていません）。",
  auto_running: "自動の回収を実行中です（何もしていません）。",
};

export const RECHECK_RECOVERY_RESULT_LABEL: Record<RecheckRecoveryResult, string> = {
  done: "再確認が完了しました。",
  pending: "再確認を試しましたが、完了しませんでした（Stripe の読み取り・反映の失敗。PENDING のままです）。",
  rejected: "確定の処理が拒否しました（決済記録・Session・決済の食い違い。運営の確認が必要です）。",
  error: "再確認に失敗しました（Stripe・データベースの一時的なエラーの可能性。PENDING のままです）。",
};
