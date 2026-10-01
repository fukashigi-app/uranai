import { Card, PageHeader, Stat, StatusBadge, Table } from "@/components/console/shell";
import { MonthPicker } from "@/components/console/month-picker";
import { Pagination, one, parsePage } from "@/components/console/pagination";
import { requireStoreUser } from "@/lib/auth/session";
import { listTransactions, monthlySeries, monthTotals } from "@/lib/services/reports";
import { FORTUNE_CATALOG } from "@/lib/fortune/catalog";
import { formatDateTimeJa, formatYearMonthJa, isValidYearMonth, jstYearMonth } from "@/lib/time";
import { formatYen } from "@/lib/money";

export const metadata = { title: "売上" };

export default async function StoreSalesPage(props: PageProps<"/store/sales">) {
  const { store } = await requireStoreUser();
  const sp = await props.searchParams;
  const ymParam = one(sp.ym);
  const ym = ymParam && isValidYearMonth(ymParam) && ymParam <= jstYearMonth() ? ymParam : jstYearMonth();
  const page = parsePage(sp.page);
  const perPage = 30;
  const [totals, monthly, txs] = await Promise.all([monthTotals(ym, store.id), monthlySeries(12, store.id), listTransactions({ storeId: store.id, yearMonth: ym, page, perPage })]);

  return (
    <>
      <PageHeader title="売上" description="お支払いが確認できた利用のみ集計しています（返金分は除外）。" actions={<MonthPicker value={ym} makeHref={(v) => `/store/sales?ym=${v}`} />} />
      <div className="grid gap-3 sm:grid-cols-3">
        <Stat label="利用回数" value={totals.count.toLocaleString("ja-JP")} unit="回" />
        <Stat label="総売上" value={totals.gross.toLocaleString("ja-JP")} unit="円" />
        <Stat label="店舗報酬" value={totals.storeShare.toLocaleString("ja-JP")} unit="円" emphasis />
      </div>

      <Card title={`${formatYearMonthJa(ym)}の利用履歴`} className="mt-4">
        <Table head={["日時", "占い", "金額", "店舗報酬", "状態"]} empty={txs.rows.length === 0}>
          {txs.rows.map((t) => (
            <tr key={t.id}>
              <td className="whitespace-nowrap tabular-nums">{formatDateTimeJa(t.paidAt)}</td>
              <td>{FORTUNE_CATALOG[t.fortuneType].label}</td>
              <td className="tabular-nums">{formatYen(t.amount)}</td>
              <td className="tabular-nums text-gold-200">{formatYen(t.paymentStatus === "SUCCEEDED" ? t.storeShare : 0)}</td>
              <td>
                <StatusBadge status={t.paymentStatus === "SUCCEEDED" ? t.fortuneStatus : t.paymentStatus} />
              </td>
            </tr>
          ))}
        </Table>
        <Pagination page={page} perPage={perPage} total={txs.total} makeHref={(p) => `/store/sales?ym=${ym}&page=${p}`} />
      </Card>

      <Card title="月別集計" className="mt-4">
        <Table head={["年月", "利用回数", "総売上", "店舗報酬"]}>
          {monthly.map((m) => (
            <tr key={m.yearMonth}>
              <td className="font-serif font-bold">{formatYearMonthJa(m.yearMonth)}</td>
              <td className="tabular-nums">{m.count.toLocaleString("ja-JP")}件</td>
              <td className="tabular-nums">{formatYen(m.gross)}</td>
              <td className="tabular-nums text-gold-200">{formatYen(m.storeShare)}</td>
            </tr>
          ))}
        </Table>
      </Card>
    </>
  );
}
