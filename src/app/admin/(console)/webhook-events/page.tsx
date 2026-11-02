import Link from "next/link";
import { Card, PageHeader, Table } from "@/components/console/shell";
import { ActionButton } from "@/components/console/admin-forms";
import { one } from "@/components/console/pagination";
import { requireOperator } from "@/lib/auth/session";
import { isFirestore } from "@/lib/data-provider";
import { formatDateTimeJa } from "@/lib/time";
import { RECOVERY_BACKOFF_MS, RECOVERY_MAX_AUTO_ATTEMPTS, RECOVERY_MAX_EVENTS, RECOVERY_STALE_MS, recoverySkipReason, WEBHOOK_RECOVERY_RESULT_LABEL, type WebhookRecoveryResult } from "@/lib/payments/webhook-recovery-rules";
import { recheckTransactionAction, recoverWebhookEventAction, runWebhookRecoveryAction } from "../../actions";
import {
  classifyPendingRecheck,
  manualRecheckBlock,
  MANUAL_RECHECK_BLOCK_LABEL,
  PENDING_RECHECK_STATUS_LABEL,
  RECHECK_RECOVERY_BACKOFF_MS,
  RECHECK_RECOVERY_MAX_ATTEMPTS,
  RECHECK_RECOVERY_MAX_ITEMS,
  RECHECK_RECOVERY_MIN_AGE_MS,
  recheckRecoverySkipReason,
  type RecheckRecoverySkipReason,
} from "@/lib/payments/recheck-recovery-rules";
import { isStripeSessionId } from "@/lib/payments/stripe-checkout";

export const metadata = { title: "Webhook の復旧" };
export const dynamic = "force-dynamic";

const STATE_LABEL: Record<string, string> = { RECEIVED: "処理中か途中で停止", RETRYABLE: "失敗（再処理できる）", FAILED_PERMANENT: "要確認（Stripe から取得できない）" };
/** 決済の確定の後の再確認：自動の回収の対象外の理由 */
const RECHECK_SKIP_LABEL: Record<RecheckRecoverySkipReason, string> = {
  not_pending: "再確認は完了",
  not_stripe: "Stripe の決済ではない",
  mode_mismatch: "モードが違う（自動の回収の対象外）",
  too_new: `作成から${RECHECK_RECOVERY_MIN_AGE_MS / 60000}分未満`,
  backoff: `自動の回収の間隔待ち（前回から${RECHECK_RECOVERY_BACKOFF_MS / 3600000}時間未満）`,
  max_attempts: `自動の回収は${RECHECK_RECOVERY_MAX_ATTEMPTS}回で終了（手動で再確認できます）`,
  invalid_record: "Session・決済の ID が無い（回収できない）",
  manual_running: "運営が手動で再確認中",
};
const RECHECK_RESULT_SHORT: Record<string, string> = { done: "完了", pending: "未完了", rejected: "拒否", error: "エラー", started: "実行中（または途中で停止）" };

const SKIP_LABEL: Record<string, string> = {
  lease_active: "処理中（処理権の期限内）",
  mode_mismatch: "モードが違う",
  attempts_exhausted: `自動の復旧は${RECOVERY_MAX_AUTO_ATTEMPTS}回で終了（手動で再処理できます）`,
  backoff: "自動の復旧の間隔待ち",
  not_retryable: "自動の復旧の対象外",
};

/**
 * Webhook の復旧：処理が終わっていない Stripe の通知（processedAt が無い記録）の一覧と、通知の ID ごとの再処理。
 * 再処理は Stripe API から通知を取り直し、Webhook と同じ処理（処理権・環境の識別・冪等性）で反映する。決済の内容は入力できない。
 */
export default async function WebhookEventsPage(props: PageProps<"/admin/webhook-events">) {
  await requireOperator();
  if (!isFirestore()) {
    return (
      <>
        <PageHeader title="Webhook の復旧" />
        <Card>
          <p className="text-[13px] text-ink-muted">この機能は Firestore を使うときだけ利用できます。</p>
        </Card>
      </>
    );
  }
  const sp = await props.searchParams;
  const cursorParam = one(sp.cursor) ?? null;
  // 再処理の後の通知（知っている結果の固定の文言だけ。URL の値そのものは表示しない）
  const noticeParam = one(sp.notice);
  const notice = noticeParam === "recovered" || noticeParam === "ignored_other_env" || noticeParam === "already_processed" ? noticeParam : null;
  const { listUnfinishedWebhookEvents, readWebhookRecoveryRun } = await import("@/lib/firestore/payments");
  const { stripeRuntime } = await import("@/lib/payments/stripe-checkout");
  let mode: "test" | "live" | null = null;
  try {
    mode = stripeRuntime().mode;
  } catch {
    mode = null;
  }
  const now = new Date();
  // 形の正しくない続きの位置は最初から読む（推測で位置を決めない）
  const page = await listUnfinishedWebhookEvents({ staleMs: 0, now, includeAll: true, cursor: cursorParam }).catch(() => listUnfinishedWebhookEvents({ staleMs: 0, now, includeAll: true }));
  const run = await readWebhookRecoveryRun();
  // 決済の確定の後の再確認が終わっていない決済記録（文書の ID の順のページ。続きの位置の形が不正なら最初から）
  const rcursorParam = one(sp.rcursor) ?? null;
  const rcursor = rcursorParam && /^[A-Za-z0-9_]{1,200}$/.test(rcursorParam) ? rcursorParam : null;
  const { listPendingRechecksForAdmin, readRecheckRecoveryRun } = await import("@/lib/firestore/recheck-recovery");
  const rpage = await listPendingRechecksForAdmin(rcursor, 20).catch(() => listPendingRechecksForAdmin(null, 20));
  const rrun = await readRecheckRecoveryRun();
  const recheckDone = one(sp.recheck) === "done";
  const isSession = (v: unknown) => (mode ? isStripeSessionId(v, mode) : false);
  return (
    <>
      <PageHeader
        title="Webhook の復旧"
        description="処理が終わっていない Stripe の通知です。再処理は Stripe から通知を取り直して、Webhook と同じ処理で反映します（処理済み・処理中・別の環境の通知は二重に反映しません）。決済の内容をここで入力・変更することはできません。"
      />
      {notice ? (
        <p role="status" data-notice={`webhook_${notice}`} className="mb-4 rounded-xl border border-success/40 bg-success/10 px-4 py-3 text-[13px] text-success">
          {WEBHOOK_RECOVERY_RESULT_LABEL[notice]}
        </p>
      ) : null}
      <Card title="自動の復旧">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="space-y-1 text-[12px] text-ink-faint">
            <p>{`定期処理（1日1回）のときに、最後の処理から${RECOVERY_STALE_MS / 60000}分以上たった通知を、1回に${RECOVERY_MAX_EVENTS}件まで再処理します（同じ通知は${RECOVERY_BACKOFF_MS / 3600000}時間あけて、${RECOVERY_MAX_AUTO_ATTEMPTS}回まで）。`}</p>
            <p data-recovery-mode={mode ?? "none"}>{`Stripe の接続：${mode === "live" ? "本番" : mode === "test" ? "テスト" : "なし（再処理できません）"}`}</p>
            <p data-recovery-last={run?.status ?? "never"}>
              {run
                ? `最後の実行：${formatDateTimeJa(run.finishedAt)}（${run.source === "cron" ? "定期処理" : "運営"}）・${run.status === "completed" ? "完了" : run.status === "partial" ? "一部（残りあり）" : "失敗"}・処理 ${run.counts.attempted ?? 0}件・処理済み ${run.counts.recovered ?? 0}件・失敗 ${(run.counts.failed ?? 0) + (run.counts.stripe_error ?? 0)}件・取得できない ${run.counts.event_unavailable ?? 0}件`
                : "最後の実行：なし"}
            </p>
          </div>
          <ActionButton action={runWebhookRecoveryAction} label="自動の復旧を今すぐ実行" variant="gold" confirmMessage="対象の通知を再処理しますか？（処理済みの通知は二重に反映しません）" />
        </div>
      </Card>
      <Card>
        <Table head={["受信", "通知", "状態", "最後の処理", "復旧", "操作"]} empty={page.records.length === 0}>
          {page.records.map((r) => {
            const skip = mode ? recoverySkipReason(r, now, mode) : null;
            const leaseActive = r.leaseExpiresAt !== null && now.getTime() < r.leaseExpiresAt.getTime();
            return (
              <tr key={r.id} data-webhook-event={r.eventId} data-webhook-state={r.state}>
                <td className="whitespace-nowrap text-[12px] tabular-nums">{r.createdAt ? formatDateTimeJa(r.createdAt) : "—"}</td>
                <td className="max-w-64 font-mono text-[11px]">
                  <span className="block truncate" title={r.eventId}>
                    {r.eventId}
                  </span>
                  <span className="block text-ink-faint">{r.type}</span>
                  {r.objectId ? <span className="block truncate text-ink-faint">{r.objectId}</span> : null}
                  <span className="block text-ink-faint">{r.livemode === true ? "本番" : r.livemode === false ? "テスト" : "モード不明"}</span>
                </td>
                <td className="text-[12px]">
                  {leaseActive ? "処理中" : (STATE_LABEL[r.state] ?? r.state)}
                  {r.lastError ? <span className="block text-ink-faint">{`エラー：${r.lastError}`}</span> : null}
                </td>
                <td className="whitespace-nowrap text-[12px] tabular-nums">
                  {r.lastAttemptAt ? formatDateTimeJa(r.lastAttemptAt) : "—"}
                  <span className="block text-ink-faint">{`処理 ${r.attempts ?? 0}回`}</span>
                </td>
                <td className="max-w-56 text-[12px]">
                  {`${r.recoveryAttempts}回`}
                  {r.lastRecoveryAt ? <span className="block text-ink-faint">{formatDateTimeJa(r.lastRecoveryAt)}</span> : null}
                  {r.lastRecoveryResult ? <span className="block text-ink-faint">{WEBHOOK_RECOVERY_RESULT_LABEL[r.lastRecoveryResult as WebhookRecoveryResult] ?? r.lastRecoveryResult}</span> : null}
                  {r.lastRecoveryError ? <span className="block text-ink-faint">{`理由：${r.lastRecoveryError}`}</span> : null}
                  {skip ? <span className="block text-ink-faint">{SKIP_LABEL[skip]}</span> : null}
                </td>
                <td>{mode ? <ActionButton action={recoverWebhookEventAction.bind(null, r.eventId)} label="再処理" confirmMessage={`${r.eventId} を再処理しますか？（Stripe から取り直して処理します。処理済みなら何もしません）`} /> : "—"}</td>
              </tr>
            );
          })}
        </Table>
        <div className="mt-3 flex justify-between text-[12px]">
          {cursorParam ? (
            <Link href="/admin/webhook-events" className="text-gold-200 hover:underline">
              最初から
            </Link>
          ) : (
            <span />
          )}
          {page.nextCursor ? (
            <Link href={`/admin/webhook-events?cursor=${encodeURIComponent(page.nextCursor)}`} className="text-gold-200 hover:underline">
              次の100件
            </Link>
          ) : null}
        </div>
      </Card>
      <Card title="決済の確定の後の再確認">
        <div id="pending-rechecks" className="space-y-1 text-[12px] text-ink-faint">
          {recheckDone ? (
            <p role="status" data-notice="recheck_done" className="mb-2 rounded-xl border border-success/40 bg-success/10 px-4 py-3 text-[13px] text-success">
              再確認が完了しました。
            </p>
          ) : null}
          <p>
            {`決済記録の作成の後の再確認（返金・異議申し立ての読み直し）が終わっていない決済記録です。定期処理（1日1回）のときに、作成から${RECHECK_RECOVERY_MIN_AGE_MS / 60000}分以上たったものを、1回に${RECHECK_RECOVERY_MAX_ITEMS}件まで自動で再確認します（同じ決済記録は${RECHECK_RECOVERY_BACKOFF_MS / 3600000}時間あけて${RECHECK_RECOVERY_MAX_ATTEMPTS}回まで）。再確認は決済記録・占い権利を新しく作らず、返金・チャージバック済みの権利を戻しません。`}
          </p>
          <p data-recheck-recovery-last={rrun?.status ?? "never"}>
            {rrun
              ? `最後の自動の回収：${formatDateTimeJa(rrun.finishedAt)}・${rrun.status === "completed" ? "完了" : rrun.status === "partial" ? "一部（残り・エラーあり）" : "失敗"}・読んだ ${rrun.counts.scanned ?? 0}件・試行 ${rrun.counts.attempted ?? 0}件（完了 ${rrun.counts.done ?? 0}・未完了 ${rrun.counts.pending ?? 0}・拒否 ${rrun.counts.rejected ?? 0}・エラー ${rrun.counts.error ?? 0}）${rrun.errorName ? `・${rrun.errorName}` : ""}`
              : "最後の自動の回収：なし"}
          </p>
        </div>
        <div className="mt-3">
          <Table head={["決済", "状態", "確定の処理の再確認", "自動の回収", "手動の再確認", "操作"]} empty={rpage.rows.length === 0}>
            {rpage.rows.map((r) => {
              const status = classifyPendingRecheck(r.candidate, now);
              const autoSkip = mode ? recheckRecoverySkipReason(r.candidate, now, mode, isSession) : null;
              const block = mode ? manualRecheckBlock(r.candidate, now, mode, isSession) : null;
              return (
                <tr key={r.id} data-pending-recheck={r.id} data-recheck-status={status ?? "recent"}>
                  <td className="max-w-64 text-[12px]">
                    <span className="block tabular-nums">{r.paidAt ? formatDateTimeJa(r.paidAt) : r.createdAt ? formatDateTimeJa(r.createdAt) : "—"}</span>
                    <span className="block truncate font-mono text-[11px] text-ink-faint" title={r.id}>
                      {r.id}
                    </span>
                    <span className="block text-ink-faint">{`${r.paymentStatus ?? "—"}・${r.livemode === true ? "本番" : r.livemode === false ? "テスト" : "モード不明"}`}</span>
                  </td>
                  <td className="max-w-56 text-[12px]">{status ? PENDING_RECHECK_STATUS_LABEL[status] : "作成から60分未満（確定の直後の再確認の途中の可能性）"}</td>
                  <td className="whitespace-nowrap text-[12px] tabular-nums">
                    {`${r.recheckAttempts}回`}
                    {r.recheckLastAttemptAt ? <span className="block text-ink-faint">{formatDateTimeJa(r.recheckLastAttemptAt)}</span> : null}
                    {r.recheckLastError ? <span className="block text-ink-faint">{`エラー：${r.recheckLastError}`}</span> : null}
                  </td>
                  <td className="max-w-56 text-[12px]">
                    {`${r.recoveryAttempts}／${RECHECK_RECOVERY_MAX_ATTEMPTS}回`}
                    {r.recoveryLastAt ? <span className="block text-ink-faint tabular-nums">{formatDateTimeJa(r.recoveryLastAt)}</span> : null}
                    {r.recoveryLastResult ? <span className="block text-ink-faint">{RECHECK_RESULT_SHORT[r.recoveryLastResult] ?? r.recoveryLastResult}</span> : null}
                    {r.recoveryLastError ? <span className="block text-ink-faint">{`理由：${r.recoveryLastError}`}</span> : null}
                    {autoSkip ? <span className="block text-ink-faint">{RECHECK_SKIP_LABEL[autoSkip]}</span> : null}
                  </td>
                  <td className="max-w-48 text-[12px]">
                    {r.manualLastAt ? <span className="block tabular-nums">{formatDateTimeJa(r.manualLastAt)}</span> : "—"}
                    {r.manualLastResult ? <span className="block text-ink-faint">{RECHECK_RESULT_SHORT[r.manualLastResult] ?? r.manualLastResult}</span> : null}
                  </td>
                  <td className="max-w-48 text-[12px]">
                    {mode && !block ? (
                      <ActionButton action={recheckTransactionAction.bind(null, r.id)} label="再確認" confirmMessage={`${r.id} を再確認しますか？（Stripe から返金・異議申し立ての状態を読み直して反映します。決済記録・占い権利は新しく作らず、返金・チャージバック済みの権利は戻しません）`} />
                    ) : (
                      <span className="text-ink-faint">{block ? MANUAL_RECHECK_BLOCK_LABEL[block] : "Stripe の接続が無いため再確認できません"}</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </Table>
          <div className="mt-3 flex justify-between text-[12px]">
            {rcursor ? (
              <Link href="/admin/webhook-events#pending-rechecks" className="text-gold-200 hover:underline">
                最初から
              </Link>
            ) : (
              <span />
            )}
            {rpage.nextCursor ? (
              <Link href={`/admin/webhook-events?rcursor=${encodeURIComponent(rpage.nextCursor)}#pending-rechecks`} className="text-gold-200 hover:underline">
                次の20件
              </Link>
            ) : null}
          </div>
        </div>
      </Card>
    </>
  );
}
