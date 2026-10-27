import Link from "next/link";
import { Card, PageHeader, Table } from "@/components/console/shell";
import { ActionButton } from "@/components/console/admin-forms";
import { one } from "@/components/console/pagination";
import { requireOperator } from "@/lib/auth/session";
import { isFirestore } from "@/lib/data-provider";
import { formatDateTimeJa } from "@/lib/time";
import { formatYen } from "@/lib/money";
import { ALERT_MODE_LABEL, API_5XX_ALERT_THRESHOLD, monitorHealth, PAYMENT_ALERT_LABEL, STUCK_PROCESSING_MINUTES, type AlertMode } from "@/lib/payments/monitor-rules";
import { resolvePaymentAlertAction, runPaymentMonitorAction } from "../../actions";

export const metadata = { title: "決済監視" };
export const dynamic = "force-dynamic";

const HEALTH_CLASS: Record<string, string> = {
  ok: "border-success/40 text-success",
  issues: "border-danger/40 text-danger",
  partial: "border-gold-300/50 text-gold-200",
  stale: "border-danger/40 text-danger",
  failed: "border-danger/40 text-danger",
  never_run: "border-danger/40 text-danger",
  running: "border-white/15 text-ink-muted",
};
const HEALTH_LABEL: Record<string, string> = { ok: "異常なし", issues: "異常あり", partial: "一部未確認", stale: "監視が止まっている可能性", failed: "点検に失敗", never_run: "未実施", running: "実行中" };
const MODE_CLASS: Record<AlertMode, string> = { live: "border-danger/40 text-danger", test: "border-white/15 text-ink-muted", unknown: "border-gold-300/50 text-gold-200" };

/**
 * 決済監視：決済・Webhook・精算の処理の失敗と、点検（読み取り専用）で見つかった食い違い。
 * 記録と照合できなかった Stripe の通知そのものは「決済要確認」で扱う（ここには重ねて載せない）。
 * 監視の点検が動いていない・失敗・一部未確認のときは「異常なし」と表示しない。
 */
export default async function PaymentMonitorPage(props: PageProps<"/admin/payment-monitor">) {
  await requireOperator();
  const sp = await props.searchParams;
  const status = one(sp.status) === "RESOLVED" ? "RESOLVED" : one(sp.status) === "all" ? undefined : "OPEN";
  const modeParam = one(sp.mode);
  const mode: AlertMode | undefined = modeParam === "live" || modeParam === "test" || modeParam === "unknown" ? modeParam : undefined;
  if (!isFirestore()) {
    return (
      <>
        <PageHeader title="決済監視" />
        <Card>
          <p className="text-[13px] text-ink-muted">この機能は Firestore を使うときだけ利用できます。監視は実行されていません。</p>
        </Card>
      </>
    );
  }
  const { countOpenPaymentAlerts, listPaymentAlerts, readMonitorStatus, PAYMENT_ALERT_LIST_LIMIT } = await import("@/lib/firestore/payment-alerts");
  const { countOpenPaymentReviews } = await import("@/lib/firestore/payment-reviews");
  const [{ rows, truncated }, openAlerts, monitor, openReviews] = await Promise.all([listPaymentAlerts({ status, mode }), countOpenPaymentAlerts(), readMonitorStatus(), countOpenPaymentReviews()]);
  const health = monitorHealth(monitor, new Date(), openAlerts);
  const q = (s: string, m?: string) => `/admin/payment-monitor?status=${s}${m ? `&mode=${m}` : ""}`;
  return (
    <>
      <PageHeader
        title="決済監視"
        description="決済・Webhook・返金・異議申し立て・精算の処理の失敗と、点検（読み取りのみ）で見つかった食い違いです。同じ種類・対象の異常は1件にまとめ、回数を数えます。自動で返金・再決済はしません。Stripe のダッシュボードと照らし合わせて確認してください。"
      />
      <Card title="監視の状態">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="space-y-1 text-[13px]">
            <p>
              <span data-monitor-health={health.state} className={`mr-2 inline-flex rounded-full border px-2 py-0.5 text-[11px] ${HEALTH_CLASS[health.state]}`}>
                {HEALTH_LABEL[health.state]}
              </span>
              {health.message}
            </p>
            <p className="text-[12px] text-ink-faint">
              {`最後の点検：${monitor?.lastFinishedAt ? formatDateTimeJa(monitor.lastFinishedAt) : "なし"}`}
              {monitor?.lastStartedAt ? `（開始 ${formatDateTimeJa(monitor.lastStartedAt)}）` : ""}
              {monitor ? `・Stripe の照合：${monitor.stripeMode === "live" ? "本番" : monitor.stripeMode === "test" ? "テスト" : "接続なし"}` : ""}
            </p>
            <p className="text-[12px] text-ink-faint">{`未確認の異常：${openAlerts}件`}</p>
            <p className="text-[12px] text-ink-faint">
              {`未確認の決済要確認：${openReviews}件（記録と照合できなかった Stripe の通知など）・`}
              <Link href="/admin/payment-reviews" className="text-gold-200 hover:underline">
                決済要確認を開く
              </Link>
            </p>
            <p className="text-[11px] text-ink-faint">{`点検の内容：確定待ちのまま${STUCK_PROCESSING_MINUTES}分を過ぎた注文・Stripe で支払い済みなのに未確定の注文・占い権利の無い決済・確定済みの精算の金額。定期実行はまだ設定していません（「今すぐ点検」または npm run monitor:payments で実行）。`}</p>
          </div>
          <ActionButton action={runPaymentMonitorAction} label="今すぐ点検（読み取りのみ）" variant="gold" />
        </div>
      </Card>
      <Card>
        <div className="mb-3 flex flex-wrap gap-2 text-[12px]">
          {(
            [
              ["OPEN", "未確認"],
              ["RESOLVED", "確認済み"],
              ["all", "すべて"],
            ] as const
          ).map(([v, label]) => (
            <Link key={v} href={q(v, mode)} className={`rounded-full border px-3 py-1 ${(status ?? "all") === v ? "border-gold-300/60 text-gold-200" : "border-white/10 text-ink-muted"}`}>
              {label}
            </Link>
          ))}
          <span className="mx-1 text-ink-faint">|</span>
          {(
            [
              [undefined, "すべてのモード"],
              ["live", "本番"],
              ["test", "テスト"],
              ["unknown", "不明"],
            ] as const
          ).map(([v, label]) => (
            <Link key={v ?? "any"} href={q(status ?? "all", v)} className={`rounded-full border px-3 py-1 ${mode === v ? "border-gold-300/60 text-gold-200" : "border-white/10 text-ink-muted"}`}>
              {label}
            </Link>
          ))}
        </div>
        <Table head={["発生日時（最初・最後）", "種類", "対象ID", "モード", "回数", "状態", "操作"]} empty={rows.length === 0}>
          {rows.map((r) => (
            <tr key={r.id} data-alert-kind={r.kind}>
              <td className="whitespace-nowrap text-[12px] tabular-nums">
                {r.firstSeenAt ? formatDateTimeJa(r.firstSeenAt) : "—"}
                {r.lastSeenAt && r.firstSeenAt && r.lastSeenAt.getTime() !== r.firstSeenAt.getTime() ? <span className="block text-ink-faint">{`最後 ${formatDateTimeJa(r.lastSeenAt)}`}</span> : null}
              </td>
              <td className="max-w-72 text-[12px]">
                {PAYMENT_ALERT_LABEL[r.kind] ?? r.kind}
                {r.kind === "payment_api_5xx" && r.occurrences >= API_5XX_ALERT_THRESHOLD ? <span className="block text-danger">{`多発（1時間に${API_5XX_ALERT_THRESHOLD}回以上）`}</span> : null}
                {r.eventType ? <span className="block text-ink-faint">{r.eventType}</span> : null}
                {r.errorName ? <span className="block text-ink-faint">{`エラー：${r.errorName}`}</span> : null}
                {r.httpStatus ? <span className="block text-ink-faint">{`HTTP ${r.httpStatus}`}</span> : null}
                {r.amount !== null && r.amount !== undefined ? <span className="block text-ink-faint">{`差額 ${formatYen(r.amount)}`}</span> : null}
              </td>
              <td className="max-w-56 font-mono text-[11px] text-ink-faint">
                <span className="block truncate" title={r.objectId}>{`${r.objectType}: ${r.objectId}`}</span>
                {r.checkoutId && r.checkoutId !== r.objectId ? <span className="block truncate">{`注文: ${r.checkoutId}`}</span> : null}
                {r.transactionId && r.transactionId !== r.objectId ? <span className="block truncate">{`取引: ${r.transactionId}`}</span> : null}
                {r.settlementId && r.settlementId !== r.objectId ? <span className="block truncate">{`精算: ${r.settlementId}`}</span> : null}
                {r.storeId ? (
                  <Link href={`/admin/stores/${r.storeId}`} className="block truncate hover:text-gold-200">
                    {`店舗: ${r.storeId}`}
                  </Link>
                ) : null}
                {r.kind === "payment_review_record_failed" ? (
                  <Link href="/admin/payment-reviews" className="block text-gold-200 hover:underline">
                    決済要確認を開く
                  </Link>
                ) : null}
              </td>
              <td>
                <span data-alert-mode={r.mode} className={`inline-flex whitespace-nowrap rounded-full border px-2 py-0.5 text-[11px] ${MODE_CLASS[r.mode]}`}>
                  {ALERT_MODE_LABEL[r.mode]}
                </span>
              </td>
              <td className="tabular-nums">
                {r.sampled ? (
                  <span data-alert-sampled="true">
                    {`少なくとも ${r.observedCount ?? r.occurrences}件`}
                    <span className="block text-[11px] text-ink-faint">{`間引いて記録（記録 ${r.occurrences}回）。正確な総数ではありません`}</span>
                  </span>
                ) : (
                  r.occurrences
                )}
              </td>
              <td className={r.status === "OPEN" ? "text-danger" : "text-ink-muted"}>
                {r.status === "OPEN" ? "未確認" : "確認済み"}
                {r.status === "RESOLVED" && r.resolvedAt ? <span className="block text-[11px] text-ink-faint">{formatDateTimeJa(r.resolvedAt)}</span> : null}
              </td>
              <td>{r.status === "OPEN" ? <ActionButton action={resolvePaymentAlertAction.bind(null, r.id)} label="確認済みにする" confirmMessage="確認済みにしますか？（同じ異常がまた起きたら未確認に戻ります）" /> : "—"}</td>
            </tr>
          ))}
        </Table>
        {truncated ? <p data-alerts-truncated="true" className="mt-2 text-center text-[11px] text-gold-200">{`読み込みの上限（${PAYMENT_ALERT_LIST_LIMIT}件）を超えたため、一部だけを表示しています。ほかにも記録があります。`}</p> : null}
        {rows.length === 0 ? <p className="mt-2 text-center text-[11px] text-ink-faint">一覧が空でも、上の「監視の状態」が「異常なし」でなければ、異常が無いとは限りません。</p> : null}
      </Card>
    </>
  );
}
