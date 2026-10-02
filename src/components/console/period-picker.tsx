import Link from "next/link";
import type { Period, PeriodKey } from "@/lib/period";
import { jstYearMonth, shiftYearMonth } from "@/lib/time";

/**
 * 集計期間の切り替え（今月 / 先月 / 月を指定 / 全期間）。
 * 通常のリンクとフォーム（GET）だけで動くため、JavaScriptが無くても使える。
 * @param basePath 例: "/admin/stores"
 * @param keep 期間以外に引き継ぐクエリ（検索条件など）
 */
export function PeriodPicker({ period, basePath, keep = {} }: { period: Period; basePath: string; keep?: Record<string, string | undefined> }) {
  const qs = (o: Record<string, string>) => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries({ ...keep, ...o })) if (v) p.set(k, v);
    return `${basePath}?${p}`;
  };
  const tabs: { key: PeriodKey; label: string }[] = [
    { key: "this", label: "今月" },
    { key: "last", label: "先月" },
    { key: "all", label: "全期間" },
  ];
  const current = jstYearMonth();
  return (
    <div className="flex flex-wrap items-center gap-2">
      <nav className="flex rounded-xl border border-white/10 bg-night-950/40 p-1" aria-label="集計期間">
        {tabs.map((t) => (
          <Link
            key={t.key}
            href={qs({ period: t.key })}
            aria-current={period.key === t.key ? "page" : undefined}
            className={`min-w-14 rounded-lg px-3 py-1.5 text-center text-[13px] transition-colors ${
              period.key === t.key ? "bg-gold-300/15 font-bold text-gold-200" : "text-ink-muted hover:text-ink"
            }`}
          >
            {t.label}
          </Link>
        ))}
      </nav>
      <form action={basePath} className="flex items-center gap-1.5">
        {Object.entries(keep).map(([k, v]) => (v ? <input key={k} type="hidden" name={k} value={v} /> : null))}
        <input type="hidden" name="period" value="month" />
        <label className="sr-only" htmlFor="period-ym">
          月を指定
        </label>
        <input
          id="period-ym"
          type="month"
          name="ym"
          max={current}
          min="2020-01"
          defaultValue={period.yearMonth ?? shiftYearMonth(current, -1)}
          className={`field !w-40 !py-1.5 !text-[14px] ${period.key === "month" ? "!border-gold-300/60" : ""}`}
        />
        <button className="btn-ghost h-9 whitespace-nowrap rounded-lg px-3 text-[12px]">月を指定</button>
      </form>
    </div>
  );
}
