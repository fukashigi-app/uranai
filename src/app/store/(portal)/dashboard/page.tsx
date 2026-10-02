import Link from "next/link";
import { Card, PageHeader, Stat, StatusBadge } from "@/components/console/shell";
import { BarChart } from "@/components/ui/bar-chart";
import { requireStoreUser } from "@/lib/auth/session";
import { dailySeries, monthlySeries, totalsForRange } from "@/lib/services/reports";
import { formatYearMonthJa, jstYearMonth } from "@/lib/time";
import { formatYen } from "@/lib/money";

export const metadata = { title: "ダッシュボード" };

export default async function StoreDashboard() {
  const { store } = await requireStoreUser();
  const ym = jstYearMonth();
  // storeId は必ずログイン中のアカウントから解決（URL等の値は使わない）
  const [daily, monthly, allTime] = await Promise.all([dailySeries(ym, store.id), monthlySeries(12, store.id), totalsForRange(null, store.id)]);
  const cur = monthly[0];
  const shareRate = store.storeShareBps / 100;

  return (
    <>
      <PageHeader
        title={store.name}
        description={
          <span className="inline-flex items-center gap-2">
            {formatYearMonthJa(ym)}の実績 <StatusBadge status={store.status} />
          </span>
        }
        actions={
          <Link href="/store/qr" className="btn-ghost rounded-xl px-4 py-2 text-[13px]">
            店舗QRコード
          </Link>
        }
      />
      <h2 className="mb-2 text-[13px] font-bold text-ink-muted">今月（{formatYearMonthJa(ym)}）</h2>
      <div className="grid gap-3 sm:grid-cols-3">
        <Stat label="今月の利用件数" value={cur.count.toLocaleString("ja-JP")} unit="件" />
        <Stat label="今月の総売上" value={formatYen(cur.gross)} />
        <Stat label="今月の店舗取り分" value={formatYen(cur.storeShare)} sub={`売上の${shareRate}%`} emphasis />
      </div>
      <h2 className="mb-2 mt-5 text-[13px] font-bold text-ink-muted">累計（これまでの合計）</h2>
      <div className="grid gap-3 sm:grid-cols-3">
        <Stat label="累計利用件数" value={allTime.count.toLocaleString("ja-JP")} unit="件" />
        <Stat label="累計総売上" value={formatYen(allTime.gross)} />
        <Stat label="累計店舗取り分" value={formatYen(allTime.storeShare)} emphasis />
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <Card>
          <BarChart title={`日別利用数（${formatYearMonthJa(ym)}）`} data={daily.map((d) => ({ label: String(d.day), value: d.count, detail: `${Number(ym.slice(5))}月${d.day}日` }))} tickEvery={5} />
        </Card>
        <Card>
          <BarChart
            title="月別利用数（直近12ヶ月）"
            data={[...monthly].reverse().map((m) => ({ label: `${Number(m.yearMonth.slice(5))}月`, value: m.count, detail: formatYearMonthJa(m.yearMonth) }))}
          />
        </Card>
      </div>

      <Card title="過去実績" className="mt-4" actions={<Link href="/store/sales" className="text-[12px] text-ink-muted underline underline-offset-4">詳しく見る</Link>}>
        <ul className="divide-y divide-white/5">
          {monthly.slice(0, 6).map((m) => (
            <li key={m.yearMonth} className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 py-3">
              <span className="font-serif font-bold">{formatYearMonthJa(m.yearMonth)}</span>
              <span className="flex gap-4 text-[13px] tabular-nums text-ink-muted">
                <span>{m.count.toLocaleString("ja-JP")}件</span>
                <span>売上 {formatYen(m.gross)}</span>
                <span className="text-gold-200">店舗報酬 {formatYen(m.storeShare)}</span>
              </span>
            </li>
          ))}
        </ul>
      </Card>
    </>
  );
}
