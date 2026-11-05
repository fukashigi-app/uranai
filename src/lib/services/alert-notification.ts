import "server-only";
import { isFirestore } from "@/lib/data-provider";
import { env } from "@/lib/env";
import { isSandboxV2Environment } from "@/lib/ops/stripe-account-diagnostics";
import { buildAlertMessage, buildHeartbeatMessage, collectCronIssues, environmentLabelOf, parseDiscordWebhookUrl, sendDiscordAlert, type AlertIssue, type DiscordPayload } from "@/lib/ops/alert-notifier";
import { ALERT_MODE_LABEL, PAYMENT_ALERT_LABEL } from "@/lib/payments/monitor-rules";

/**
 * 定期処理の結果を運営者に通知する（Discord。src/lib/ops/alert-notifier.ts）。
 *  - 通知するもの：新しい未確認の決済監視の異常・新しい決済要確認（前回までに通知していないもの）、Webhook の復旧・再確認の失敗、
 *    定期処理の段階の失敗・時間切れ・ロックの異常、決済監視の失敗・一部未確認・時間不足、保存期間の削除の遅れ
 *  - 異常が無い回：前回の正常の報告から7日以上（または報告の履歴が無い）なら、週1回の正常の報告を送る
 *  - 全体を timeoutMs で区切る。区切りを過ぎたら中止の合図を送り、新しい送信を始めない（送信中の HTTP も中止する）。
 *    送信を始めた後の中止は、Discord 側で受け取られている可能性があるので、重複を完全には防げない
 *  - 送信の成功と、Firestore への記録の成功を別に扱う（送れたが記録できない＝sent_unrecorded。次の回に重複して送ることがあるが、取りこぼさない）
 *  - 例外を投げない。定期処理の結果・ロックの解除・決済の処理には影響しない
 */
export type NotificationStatus =
  | "sent"
  | "sent_unrecorded"
  | "heartbeat"
  | "heartbeat_unrecorded"
  | "nothing"
  | "not_configured"
  | "invalid_url"
  | "send_failed"
  | "error"
  | "skipped_time";
export type NotificationSummary = { status: NotificationStatus; issues: number; newAlerts: number; newReviews: number; errorCode: string | null };

/** 保存期間の削除の遅れが、この回数続いたら通知する。その後は7回ごと（毎回は送らない） */
export const DELETION_DELAY_ALERT_RUNS = 2;
/** 週1回の正常の報告の間隔 */
export const HEARTBEAT_INTERVAL_MS = 7 * 86_400_000;
/** 未確認の一覧を読む件数の上限（1件多く読んで、上限を超えたかを確かめる） */
export const NOTIFY_LIST_LIMIT = 200;
/** 送信を始めるのに必要な残りの時間（これより少なければ送らない） */
const MIN_SEND_MS = 1500;

const DELETION_TASK_LABEL: Record<string, string> = { purgeResults: "占い結果（30日）", purgeAuthSessions: "期限切れのログイン", purgeCheckouts: "未決済の注文（7日）" };

export type CronNotificationInput = {
  runStatus: string;
  unsettled: boolean;
  phases: { name: string; status: string; reason: string | null; errorCode: string | null; abortSettled?: boolean | null }[];
  webhookRecovery?: unknown;
  recheckRecovery?: unknown;
  paymentMonitor?: { status: string } | null;
  /** メンテナンスが成功した（削除の遅れの判定は、成功した回の結果だけで行う） */
  maintenanceOk: boolean;
  /** この定期処理の開始の時刻（正常の報告の「最終実行」） */
  startedAt?: Date;
};

type Opts = { timeoutMs: number; now?: Date; fetchImpl?: typeof fetch };
type Ctx = Opts & { signal: AbortSignal; deadline: number };

const nothing = (status: NotificationStatus, errorCode: string | null = null): NotificationSummary => ({ status, issues: 0, newAlerts: 0, newReviews: 0, errorCode });
const nameOf = (e: unknown) => ((e as Error)?.name || "Error").replace(/[^A-Za-z0-9_]/g, "").slice(0, 40) || "Error";

function adminUrl(): string | null {
  try {
    return `${env().APP_URL}/admin/payment-monitor`;
  } catch {
    return null;
  }
}

/** 全体を ms で区切る。区切りを過ぎたら中止の合図を送る（中の処理は、送信の前にこの合図を確かめる） */
function guarded(work: (ctx: Ctx) => Promise<NotificationSummary>, opts: Opts): Promise<NotificationSummary> {
  const controller = new AbortController();
  const ctx: Ctx = { ...opts, signal: controller.signal, deadline: Date.now() + opts.timeoutMs };
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    work(ctx).catch((e) => nothing("error", nameOf(e))),
    new Promise<NotificationSummary>((ok) => {
      timer = setTimeout(() => {
        controller.abort();
        ok(nothing("error", "timeout"));
      }, opts.timeoutMs);
    }),
  ]).finally(() => timer && clearTimeout(timer));
}

/** 送信してよいか（中止の合図が無く、残りの時間が十分）。送信の直前に確かめる */
const canSend = (ctx: Ctx) => !ctx.signal.aborted && ctx.deadline - Date.now() >= MIN_SEND_MS;
const sendTimeoutOf = (ctx: Ctx) => Math.max(500, Math.min(5000, ctx.deadline - Date.now() - 300));

async function send(url: string, payload: DiscordPayload, ctx: Ctx) {
  if (!canSend(ctx)) return { ok: false as const, error: "skipped_time" };
  return sendDiscordAlert(url, payload, { fetchImpl: ctx.fetchImpl, timeoutMs: sendTimeoutOf(ctx), signal: ctx.signal });
}

export function notifyCronRun(input: CronNotificationInput, opts: Opts): Promise<NotificationSummary> {
  return guarded((ctx) => run(input, ctx), opts);
}

/** 未確認の一覧と、前回までに通知した ID から、新しいもの・次の状態・上限を超えたかを求める（上限を超えたら、読めなかった分の通知済みの ID は消さない） */
function diffWithLimit<T extends { id: string }>(notified: readonly string[], rows: readonly T[], exceeded: boolean): { fresh: T[]; next: string[] } {
  const prev = new Set(notified);
  const fresh = rows.filter((r) => !prev.has(r.id));
  const current = rows.map((r) => r.id);
  if (!exceeded) return { fresh, next: current }; // すべて読めた：確認済みになったものは消す
  const seen = new Set(current);
  return { fresh, next: [...current, ...notified.filter((id) => !seen.has(id))] }; // 読めなかった分が未確認のまま残っている可能性があるので残す
}

async function run(input: CronNotificationInput, ctx: Ctx): Promise<NotificationSummary> {
  const raw = process.env.OPS_ALERT_WEBHOOK_URL;
  if (!(raw ?? "").trim()) return nothing("not_configured");
  const url = parseDiscordWebhookUrl(raw);
  if (!url) {
    console.warn("[alert] OPS_ALERT_WEBHOOK_URL is not a valid Discord webhook URL; nothing was sent");
    return nothing("invalid_url");
  }
  const now = ctx.now ?? new Date();
  const issues: AlertIssue[] = collectCronIssues(input);
  const envLabel = environmentLabelOf(process.env, isSandboxV2Environment());

  // Firestore ではない構成：通知済みの記録が無いので、定期処理の異常だけを送る（正常の報告もしない）
  if (!isFirestore()) {
    if (!issues.length) return nothing("nothing");
    const r = await send(url, buildAlertMessage({ envLabel, at: now, issues, newAlerts: [], newReviews: [], adminUrl: adminUrl() }), ctx);
    if (r.ok) return { status: "sent", issues: issues.length, newAlerts: 0, newReviews: 0, errorCode: null };
    return { ...nothing(r.error === "skipped_time" ? "skipped_time" : "send_failed", r.error), issues: issues.length };
  }

  const fs = await import("@/lib/firestore/alert-notification");
  const { listPaymentAlerts } = await import("@/lib/firestore/payment-alerts");
  const { listPaymentReviews, PAYMENT_REVIEW_LABEL } = await import("@/lib/firestore/payment-reviews");
  const state = await fs.readAlertNotificationState();
  const alertList = await listPaymentAlerts({ status: "OPEN", limit: NOTIFY_LIST_LIMIT }); // 1件多く読み、truncated＝上限を超えた（確定）
  const reviewRows = await listPaymentReviews({ status: "OPEN", limit: NOTIFY_LIST_LIMIT + 1 });
  const alertsExceeded = alertList.truncated;
  const reviewsExceeded = reviewRows.length > NOTIFY_LIST_LIMIT;
  const alerts = alertList.rows.map((a) => ({ id: a.id, label: PAYMENT_ALERT_LABEL[a.kind] ?? a.kind, mode: ALERT_MODE_LABEL[a.mode] ?? null }));
  const reviews = reviewRows.slice(0, NOTIFY_LIST_LIMIT).map((r) => ({ id: r.id, label: PAYMENT_REVIEW_LABEL[r.kind] ?? r.kind, mode: r.livemode === true ? "本番" : r.livemode === false ? "テスト" : null }));
  const a = diffWithLimit(state.notifiedAlertIds, alerts, alertsExceeded);
  const rv = diffWithLimit(state.notifiedReviewIds, reviews, reviewsExceeded);
  const listsTruncated = { alerts: alertsExceeded, reviews: reviewsExceeded };

  // 保存期間の削除の遅れ（メンテナンスが成功した回だけで数える）。確認できた事実だけを書く
  //  - すべてが対象の削除（占い結果・ログイン）：上限で打ち切られた＝古い順に読んで、まだ対象が残っている
  //  - 未決済の注文の削除：時間の上限・中止で止まった、または保存期間＋間隔＋ずれを過ぎた注文が実際に見つかった。
  //    続きの位置からの読み込み（通常のページの区切り）は遅れとしない
  let deletionDelayRuns = state.deletionDelayRuns;
  let deletionDelay: { runs: number; items: string[] } | null = null;
  if (input.maintenanceOk) {
    const items: string[] = [];
    for (const t of await fs.readMaintenanceTaskStats()) {
      const label = DELETION_TASK_LABEL[t.task];
      if (!label) continue;
      if (t.task === "purgeCheckouts") {
        if (t.overdueFound > 0) items.push(`${label}：保存期間を過ぎて残っていた削除の対象の注文を ${t.overdueFound}件 確認しました（今回の削除の対象）`);
        if (t.stoppedBy === "time" || t.stoppedBy === "aborted") items.push(`${label}：時間の上限で、最後まで削除できませんでした（残りの件数は不明）`);
      } else if (t.truncated) {
        items.push(`${label}：${t.stoppedBy === "cap" ? "件数の上限" : "時間の上限"}で打ち切り、古いものが残っています（残りの件数は不明）`);
      }
    }
    deletionDelayRuns = items.length ? deletionDelayRuns + 1 : 0;
    const due = deletionDelayRuns >= DELETION_DELAY_ALERT_RUNS && (deletionDelayRuns - DELETION_DELAY_ALERT_RUNS) % 7 === 0;
    if (items.length && due) deletionDelay = { runs: deletionDelayRuns, items };
  }

  const summary = { issues: issues.length + (deletionDelay ? 1 : 0) + (alertsExceeded || reviewsExceeded ? 1 : 0), newAlerts: a.fresh.length, newReviews: rv.fresh.length };
  const nextState = { notifiedAlertIds: a.next, notifiedReviewIds: rv.next, deletionDelayRuns, lastHeartbeatAt: state.lastHeartbeatAt };
  const record = async (s: typeof nextState, status: string, errorCode: string | null, sent: boolean): Promise<string | null> => {
    try {
      await fs.writeAlertNotificationState(s, { at: now, status, errorCode, sent, listsTruncated });
      return null;
    } catch (e) {
      console.error("[alert] notification state could not be recorded", { error: nameOf(e) });
      return nameOf(e);
    }
  };

  // ---- 異常が無い回：週1回の正常の報告（期限が来ていなければ送らない） ----
  if (!summary.issues && !a.fresh.length && !rv.fresh.length) {
    const due = !state.lastHeartbeatAt || now.getTime() - state.lastHeartbeatAt.getTime() >= HEARTBEAT_INTERVAL_MS;
    if (!due) {
      const err = await record(nextState, "nothing", null, false);
      return { status: "nothing", ...summary, errorCode: err };
    }
    // 直近7日の実行の回数は、実行の履歴（記録）から数える。読めなければ「取得不可」（推測しない）。今回の実行は、まだ履歴に記録されていないので1回として足す
    let runs7d: { count: number; since: Date | null } | null = null;
    try {
      const h = await fs.readCronRunHistory();
      const from = now.getTime() - 7 * 86_400_000;
      runs7d = { count: h.starts.filter((d) => d.getTime() >= from && d.getTime() <= now.getTime()).length + 1, since: h.since ?? input.startedAt ?? now };
    } catch {
      runs7d = null;
    }
    const payload = buildHeartbeatMessage({
      envLabel,
      at: input.startedAt ?? now,
      runs7d,
      openAlerts: { count: alerts.length, exceeded: alertsExceeded },
      openReviews: { count: reviews.length, exceeded: reviewsExceeded },
      adminUrl: adminUrl(),
    });
    const r = await send(url, payload, ctx);
    if (!r.ok) {
      // 失敗：lastHeartbeatAt は進めない（次の回にもう一度送る）
      const err = await record(nextState, r.error === "skipped_time" ? "skipped_time" : "send_failed", r.error, false);
      return { status: r.error === "skipped_time" ? "skipped_time" : "send_failed", ...summary, errorCode: err ?? r.error };
    }
    const err = await record({ ...nextState, lastHeartbeatAt: now }, "heartbeat", null, true);
    return { status: err ? "heartbeat_unrecorded" : "heartbeat", ...summary, errorCode: err };
  }

  // ---- 異常の通知 ----
  const payload = buildAlertMessage({
    envLabel,
    at: now,
    issues,
    newAlerts: a.fresh,
    newReviews: rv.fresh,
    deletionDelay,
    listsExceeded: alertsExceeded || reviewsExceeded ? { alerts: alertsExceeded, reviews: reviewsExceeded, limit: NOTIFY_LIST_LIMIT } : null,
    adminUrl: adminUrl(),
  });
  const r = await send(url, payload, ctx);
  if (r.ok) {
    // 送れた：記録に失敗しても送信は成功（sent_unrecorded。次の回に同じ異常を重複して送ることがある）
    const err = await record(nextState, "sent", null, true);
    return { status: err ? "sent_unrecorded" : "sent", ...summary, errorCode: err };
  }
  if (r.error !== "skipped_time") console.error("[alert] notification could not be sent", { error: r.error });
  // 送れなかった：通知済みの ID は進めない（次の回に同じ異常をもう一度通知する）。削除の遅れの回数も、通知の予定の回のまま次に持ち越す
  const err = await record(
    { notifiedAlertIds: state.notifiedAlertIds, notifiedReviewIds: state.notifiedReviewIds, deletionDelayRuns: deletionDelay ? deletionDelayRuns - 1 : deletionDelayRuns, lastHeartbeatAt: state.lastHeartbeatAt },
    r.error === "skipped_time" ? "skipped_time" : "send_failed",
    r.error,
    false,
  );
  return { status: r.error === "skipped_time" ? "skipped_time" : "send_failed", ...summary, errorCode: r.error ?? err };
}

/** 定期処理のロックを取れない（Firestore の失敗）：Firestore を使わずに、その異常だけを送る */
export function notifyCronLockFailure(opts: Opts): Promise<NotificationSummary> {
  return guarded(async (ctx) => {
    const url = parseDiscordWebhookUrl(process.env.OPS_ALERT_WEBHOOK_URL);
    if (!url) return nothing((process.env.OPS_ALERT_WEBHOOK_URL ?? "").trim() ? "invalid_url" : "not_configured");
    const issues: AlertIssue[] = [{ severity: "error", text: "定期処理のロックを取得できず（データベースの障害の可能性）、何も実行しませんでした" }];
    const r = await send(url, buildAlertMessage({ envLabel: environmentLabelOf(process.env, isSandboxV2Environment()), at: ctx.now ?? new Date(), issues, newAlerts: [], newReviews: [], adminUrl: adminUrl() }), ctx);
    if (r.ok) return { status: "sent", issues: 1, newAlerts: 0, newReviews: 0, errorCode: null };
    return { ...nothing(r.error === "skipped_time" ? "skipped_time" : "send_failed", r.error), issues: 1 };
  }, opts);
}
