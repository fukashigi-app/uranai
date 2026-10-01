import Link from "next/link";
import { Card, PageHeader, Stat } from "@/components/console/shell";
import { BarChart } from "@/components/ui/bar-chart";
import { requireOperator } from "@/lib/auth/session";
import { countActiveStores, dailySeries, listStores, monthTotals, totalsBetween } from "@/lib/services/reports";
import { formatYearMonthJa, jstDateString, jstYearMonth } from "@/lib/time";
import { formatYen } from "@/lib/money";

export const metadata = { title: "運営ダッシュボード" };

export default async function AdminDashboard() {
  await requireOperator();
  const ym = jstYearMonth();
  const today = jstDateString();
  const todayStart = new Date(`${today}T00:00:00+09:00`);
  const [storesCount, todayTotals, month, daily, top] = await Promise.all([
    countActiveStores(),
    totalsBetween(todayStart, new Date(todayStart.getTime() + 86400000)),
    monthTotals(ym),
    dailySeries(ym),
    listStores({ sort: "monthCount", dir: "desc", page: 1, perPage: 5 }),
  ]);
  const net = month.operatorShare - month.fee;
  const y = (n: number) => n.toLocaleString("ja-JP");

  return (
    <>
      <PageHeader title="ダッシュボード" description={`${formatYearMonthJa(ym)}（JST）の集計。返金分は除外しています。`} />
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="全店舗数" value={y(storesCount.total)} unit="店" sub={`稼働中 ${storesCount.active}店`} />
        <Stat label="本日の利用数" value={y(todayTotals.count)} unit="回" />
        <Stat label="今月利用数" value={y(month.count)} unit="回" />
        <Stat label="今月総売上" value={y(month.gross)} unit="円" />
        <Stat label="店舗報酬合計" value={y(month.storeShare)} unit="円" />
        <Stat label="運営売上" value={y(month.operatorShare)} unit="円" />
        <Stat label="決済手数料" value={y(month.fee)} unit="円" sub="推定値" />
        <Stat label="推定運営純売上" value={y(net)} unit="円" sub="運営売上 − 決済手数料" emphasis />
      </div>
      <div className="mt-4 grid gap-4 lg:grid-cols-[1.6fr_1fr]">
        <Card>
          <BarChart title={`日別利用数（${formatYearMonthJa(ym)}・全店舗）`} data={daily.map((d) => ({ label: String(d.day), value: d.count, detail: `${Number(ym.slice(5))}月${d.day}日` }))} tickEvery={5} />
        </Card>
        <Card title="今月の利用が多い店舗" actions={<Link href="/admin/stores?sort=monthCount&dir=desc" className="text-[12px] text-ink-muted underline underline-offset-4">すべて</Link>}>
          <ol className="divide-y divide-white/5">
            {top.rows.map((s, i) => (
              <li key={s.id} className="flex items-center justify-between gap-3 py-2.5 text-[13px]">
                <Link href={`/admin/stores/${s.id}`} className="flex min-w-0 items-center gap-2 hover:text-gold-200">
                  <span className="font-display text-lg text-gold-300">{i + 1}</span>
                  <span className="truncate">{s.name}</span>
                </Link>
                <span className="shrink-0 tabular-nums text-ink-muted">{s.monthCount}回</span>
              </li>
            ))}
            {top.rows.length === 0 ? <li className="py-6 text-center text-[13px] text-ink-faint">店舗がありません</li> : null}
          </ol>
          <p className="mt-3 text-[11px] text-ink-faint">今月の総売上 {formatYen(month.gross)}</p>
        </Card>
      </div>
    </>
  );
}
