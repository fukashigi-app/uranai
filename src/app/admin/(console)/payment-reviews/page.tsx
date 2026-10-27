import Link from "next/link";
import { Card, PageHeader, Table } from "@/components/console/shell";
import { ActionButton } from "@/components/console/admin-forms";
import { one } from "@/components/console/pagination";
import { requireOperator } from "@/lib/auth/session";
import { isFirestore } from "@/lib/data-provider";
import { getStoresByIds } from "@/lib/services/stores";
import { formatDateTimeJa, formatYearMonthJa } from "@/lib/time";
import { formatYen } from "@/lib/money";
import { resolvePaymentReviewAction } from "../../actions";

export const metadata = { title: "決済要確認" };

const MISMATCH_LABEL: Record<string, string> = {
  provider: "決済方法",
  charge_id: "決済ID（Charge）",
  livemode: "本番／テスト",
  payment_intent: "決済ID（PaymentIntent）",
  currency: "通貨",
  amount: "金額",
  store: "店舗",
};

/**
 * 決済要確認：署名を確認できた Stripe の通知のうち、記録と照合できなかったもの（反映していない）と、
 * 以前に確定した精算の月の取引が後から変わったもの（調整していない）。秘密情報・カード情報は保存・表示しない。
 */
export default async function PaymentReviewsPage(props: PageProps<"/admin/payment-reviews">) {
  await requireOperator();
  const sp = await props.searchParams;
  const status = one(sp.status) === "RESOLVED" ? "RESOLVED" : one(sp.status) === "all" ? undefined : "OPEN";
  if (!isFirestore()) {
    return (
      <>
        <PageHeader title="決済要確認" />
        <Card>
          <p className="text-[13px] text-ink-muted">この機能は Firestore を使うときだけ利用できます。</p>
        </Card>
      </>
    );
  }
  const { listPaymentReviews, PAYMENT_REVIEW_LABEL } = await import("@/lib/firestore/payment-reviews");
  const rows = await listPaymentReviews({ status, limit: 200 });
  const names = new Map((await getStoresByIds([...new Set(rows.map((r) => r.storeId).filter((v): v is string => !!v))])).map((s) => [s.id, s.name]));
  return (
    <>
      <PageHeader
        title="決済要確認"
        description="Stripe の通知のうち、決済ID・店舗・金額などが記録と一致せず反映していないもの、以前に確定した精算の月の取引が後から変わったもの（支払った額が分からないため、自動では調整していません）です。Stripe のダッシュボードと照らし合わせて確認してください。"
      />
      <p className="mb-3 text-[12px] text-ink-faint">
        {"処理の失敗（Webhook・返金・精算の確定など）や点検で見つかった食い違いは"}
        <Link href="/admin/payment-monitor" className="text-gold-200 hover:underline">
          決済監視
        </Link>
        {"に表示します。"}
      </p>
      <Card>
        <div className="mb-3 flex gap-2 text-[12px]">
          {(
            [
              ["OPEN", "未確認"],
              ["RESOLVED", "確認済み"],
              ["all", "すべて"],
            ] as const
          ).map(([v, label]) => (
            <Link key={v} href={`/admin/payment-reviews?status=${v}`} className={`rounded-full border px-3 py-1 ${(status ?? "all") === v ? "border-gold-300/60 text-gold-200" : "border-white/10 text-ink-muted"}`}>
              {label}
            </Link>
          ))}
        </div>
        <Table head={["発生日時（最初・最後）", "原因", "対象ID", "店舗・対象月", "金額", "回数", "状態", "操作"]} empty={rows.length === 0}>
          {rows.map((r) => (
            <tr key={r.id}>
              <td className="whitespace-nowrap text-[12px] tabular-nums">
                {r.firstSeenAt ? formatDateTimeJa(r.firstSeenAt) : "—"}
                {r.lastSeenAt && r.firstSeenAt && r.lastSeenAt.getTime() !== r.firstSeenAt.getTime() ? <span className="block text-ink-faint">{`最後 ${formatDateTimeJa(r.lastSeenAt)}`}</span> : null}
              </td>
              <td className="max-w-72 text-[12px]">
                {PAYMENT_REVIEW_LABEL[r.kind] ?? r.kind}
                {r.mismatches?.length ? <span className="block text-danger">{`一致しない項目：${r.mismatches.map((m) => MISMATCH_LABEL[m] ?? m).join("・")}`}</span> : null}
                {r.eventType ? <span className="block text-ink-faint">{r.eventType}</span> : null}
              </td>
              <td className="max-w-48 font-mono text-[11px] text-ink-faint">
                <span className="block truncate" title={r.objectId}>{`${r.objectType}: ${r.objectId}`}</span>
                {r.transactionId ? <span className="block truncate" title={r.transactionId}>{`取引: ${r.transactionId}`}</span> : null}
                {r.chargeId && r.objectId !== r.chargeId ? <span className="block truncate">{`Charge: ${r.chargeId}`}</span> : null}
              </td>
              <td className="text-[12px]">
                {r.storeId ? (
                  <Link href={`/admin/stores/${r.storeId}`} className="hover:text-gold-200">
                    {names.get(r.storeId) ?? "—"}
                  </Link>
                ) : (
                  "—"
                )}
                {r.yearMonth ? <span className="block text-ink-faint">{formatYearMonthJa(r.yearMonth)}</span> : null}
              </td>
              <td className="tabular-nums">{r.amount === null || r.amount === undefined ? "—" : formatYen(r.amount)}</td>
              <td className="tabular-nums">{r.occurrences}</td>
              <td className={r.status === "OPEN" ? "text-danger" : "text-ink-muted"}>{r.status === "OPEN" ? "未確認" : "確認済み"}</td>
              <td>{r.status === "OPEN" ? <ActionButton action={resolvePaymentReviewAction.bind(null, r.id)} label="確認済みにする" confirmMessage="確認済みにしますか？（同じ内容がくり返し届いても未確認には戻りません。内容が変わったら未確認に戻ります）" /> : "—"}</td>
            </tr>
          ))}
        </Table>
      </Card>
    </>
  );
}
