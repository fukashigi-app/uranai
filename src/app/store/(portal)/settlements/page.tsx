import { Card, PageHeader, StatusBadge, Table } from "@/components/console/shell";
import { requireStoreUser } from "@/lib/auth/session";
import { listSettlements } from "@/lib/services/settlements";
import { formatDateJa, formatYearMonthJa } from "@/lib/time";
import { formatYen } from "@/lib/money";

export const metadata = { title: "振込状況" };

export default async function StoreSettlementsPage() {
  const { store } = await requireStoreUser();
  const rows = await listSettlements({ storeId: store.id, limit: 36 });
  return (
    <>
      <PageHeader title="振込状況" description="月末締めで集計し、運営からご登録の口座へお振込みします。" />
      <Card>
        <Table head={["対象月", "利用回数", "総売上", "店舗報酬", "状況", "振込日"]} empty={rows.length === 0}>
          {rows.map(({ s }) => (
            <tr key={s.id}>
              <td className="font-serif font-bold">{formatYearMonthJa(s.yearMonth)}</td>
              <td className="tabular-nums">{s.transactionCount.toLocaleString("ja-JP")}件</td>
              <td className="tabular-nums">{formatYen(s.grossSales)}</td>
              <td className="tabular-nums text-gold-200">{formatYen(s.storeShare)}</td>
              <td>
                <StatusBadge status={s.status} />
              </td>
              <td className="whitespace-nowrap text-ink-muted">{s.paidAt ? formatDateJa(s.paidAt) : "—"}</td>
            </tr>
          ))}
        </Table>
      </Card>
    </>
  );
}
