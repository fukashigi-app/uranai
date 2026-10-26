import { Card, PageHeader, StatusBadge, Table } from "@/components/console/shell";
import { SettlementAdjustmentsTable } from "@/components/console/settlement-adjustments";
import { requireStoreUser } from "@/lib/auth/session";
import { listSettlementAdjustments, listSettlements } from "@/lib/services/settlements";
import { formatDateJa, formatYearMonthJa } from "@/lib/time";
import { formatYen } from "@/lib/money";

export const metadata = { title: "振込状況" };

export default async function StoreSettlementsPage() {
  const { store } = await requireStoreUser();
  // storeId は必ずログイン中のアカウントから解決（URL等の値は使わない）
  const [rows, adjustments] = await Promise.all([listSettlements({ storeId: store.id, limit: 36 }), listSettlementAdjustments({ storeId: store.id, limit: 100 })]);
  const open = adjustments.filter((a) => a.status === "OPEN");
  const openTotal = open.reduce((t, a) => t + a.amount, 0);
  return (
    <>
      <PageHeader title="振込状況" description="売上は毎月末に集計し、原則として3か月ごとにまとめて、運営からご登録の口座へお振込みします。" />
      <Card>
        <Table head={["対象月", "利用回数", "総売上", "店舗報酬", "保留", "調整", "振込額", "状況", "振込日"]} empty={rows.length === 0}>
          {rows.map(({ s }) => (
            <tr key={s.id}>
              <td className="font-serif font-bold">{formatYearMonthJa(s.yearMonth)}</td>
              <td className="tabular-nums">{s.transactionCount.toLocaleString("ja-JP")}件</td>
              <td className="tabular-nums">{formatYen(s.grossSales)}</td>
              <td className="tabular-nums">{formatYen(s.storeShare)}</td>
              <td className="tabular-nums text-ink-muted">{s.heldShare ? formatYen(s.heldShare) : "—"}</td>
              <td className="tabular-nums">
                {s.payableAmount !== null && s.adjustmentTotal ? formatYen(s.adjustmentTotal) : "—"}
                {s.carryOver < 0 ? <span className="block text-[11px] text-danger">{`次回へ繰越 ${formatYen(s.carryOver)}`}</span> : null}
              </td>
              <td className="tabular-nums font-bold text-gold-200">{s.payableAmount !== null ? formatYen(s.payableAmount) : <span className="text-[12px] font-normal text-ink-faint">集計中</span>}</td>
              <td>
                <StatusBadge status={s.status} />
              </td>
              <td className="whitespace-nowrap text-ink-muted">{s.paidAt ? formatDateJa(s.paidAt) : "—"}</td>
            </tr>
          ))}
        </Table>
        <p className="mt-3 text-[12px] leading-relaxed text-ink-faint">
          「保留」は、お客様の異議申し立て（カード会社への支払いの取り消しの申し立て）に対応中の売上です。結果が出るまでお振込みを保留し、認められなかった場合は次回のお振込みに含めます。
        </p>
      </Card>
      {adjustments.length ? (
        <Card title="振込額の調整" className="mt-4">
          <p className="mb-3 text-[12px] leading-relaxed text-ink-faint">
            お振込み後に返金・異議申し立てなどがあった場合は、過去のお振込みは変更せず、次回のお振込みで差し引き（マイナス）・加算（プラス）します。
            {open.length ? <span className="mt-1 block font-bold text-gold-200">{`次回のお振込みで反映する調整：${formatYen(openTotal)}`}</span> : null}
          </p>
          <SettlementAdjustmentsTable rows={adjustments} audience="store" />
        </Card>
      ) : null}
    </>
  );
}
