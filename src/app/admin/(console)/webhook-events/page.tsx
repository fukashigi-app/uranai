import Link from "next/link";
import { Card, PageHeader, Table } from "@/components/console/shell";
import { ActionButton } from "@/components/console/admin-forms";
import { one } from "@/components/console/pagination";
import { requireOperator } from "@/lib/auth/session";
import { isFirestore } from "@/lib/data-provider";
import { formatDateTimeJa } from "@/lib/time";
import { RECOVERY_BACKOFF_MS, RECOVERY_MAX_AUTO_ATTEMPTS, RECOVERY_MAX_EVENTS, RECOVERY_STALE_MS, recoverySkipReason, WEBHOOK_RECOVERY_RESULT_LABEL, type WebhookRecoveryResult } from "@/lib/payments/webhook-recovery-rules";
import { recoverWebhookEventAction, runWebhookRecoveryAction } from "../../actions";

export const metadata = { title: "Webhook の復旧" };
export const dynamic = "force-dynamic";

const STATE_LABEL: Record<string, string> = { RECEIVED: "処理中か途中で停止", RETRYABLE: "失敗（再処理できる）", FAILED_PERMANENT: "要確認（Stripe から取得できない）" };
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
    </>
  );
}
