import Link from "next/link";
import { Card, PageHeader, Stat, StatusBadge } from "@/components/console/shell";
import { BarChart } from "@/components/ui/bar-chart";
import { requireStoreUser } from "@/lib/auth/session";
import { dailySeries, monthlySeries } from "@/lib/services/reports";
import { formatYearMonthJa, jstYearMonth } from "@/lib/time";
import { formatYen } from "@/lib/money";

export const metadata = { title: "ダッシュボード" };

export default async function StoreDashboard() {
  const { store } = await requireStoreUser();
  const ym = jstYearMonth();
  const [daily, monthly] = await Promise.all([dailySeries(ym, store.id), monthlySeries(12, store.id)]);
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
      <div className="grid gap-3 sm:grid-cols-3">
        <Stat label="今月の利用" value={cur.count.toLocaleString("ja-JP")} unit="回" />
        <Stat label="総売上" value={cur.gross.toLocaleString("ja-JP")} unit="円" />
        <Stat label="店舗報酬" value={cur.storeShare.toLocaleString("ja-JP")} unit="円" sub={`売上の${shareRate}%`} emphasis />
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
