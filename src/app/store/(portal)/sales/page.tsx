import { Card, PageHeader, Stat, StatusBadge, Table } from "@/components/console/shell";
import { MonthPicker } from "@/components/console/month-picker";
import { Pagination, one, parsePage } from "@/components/console/pagination";
import { requireStoreUser } from "@/lib/auth/session";
import { listTransactions, monthlySeries, monthTotals, totalsForRange } from "@/lib/services/reports";
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
  // storeId は必ずログイン中のアカウントから解決（他店舗の売上は取得できない）
  const [totals, monthly, txs, allTime] = await Promise.all([
    monthTotals(ym, store.id),
    monthlySeries(12, store.id),
    listTransactions({ storeId: store.id, yearMonth: ym, page, perPage }),
    totalsForRange(null, store.id),
  ]);

  return (
    <>
      <PageHeader title="売上" description="お支払いが確認できた利用のみ集計しています（返金分は除外）。" actions={<MonthPicker value={ym} makeHref={(v) => `/store/sales?ym=${v}`} />} />
      <h2 className="mb-2 text-[13px] font-bold text-ink-muted">{formatYearMonthJa(ym)}</h2>
      <div className="grid gap-3 sm:grid-cols-3">
        <Stat label="利用件数" value={totals.count.toLocaleString("ja-JP")} unit="件" />
        <Stat label="総売上" value={formatYen(totals.gross)} />
        <Stat label="店舗取り分" value={formatYen(totals.storeShare)} emphasis />
      </div>
      <Card title="累計（これまでの合計）" className="mt-4">
        <dl className="grid grid-cols-1 gap-3 text-[13px] sm:grid-cols-3">
          {[
            ["累計利用件数", `${allTime.count.toLocaleString("ja-JP")}件`, ""],
            ["累計総売上", formatYen(allTime.gross), ""],
            ["累計店舗取り分", formatYen(allTime.storeShare), "text-gold-200"],
          ].map(([k, v, cls]) => (
            <div key={k} className="flex items-baseline justify-between gap-2 sm:block">
              <dt className="text-[12px] text-ink-muted">{k}</dt>
              <dd className={`text-xl font-bold tabular-nums ${cls}`}>{v}</dd>
            </div>
          ))}
        </dl>
      </Card>

      <Card title={`${formatYearMonthJa(ym)}の利用履歴`} className="mt-4">
        <Table head={["日時", "占い", "金額", "店舗取り分", "状態"]} empty={txs.rows.length === 0}>
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
        <Table head={["年月", "利用件数", "総売上", "店舗取り分"]}>
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
