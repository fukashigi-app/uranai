import Link from "next/link";
import { formatYearMonthJa, jstYearMonth, shiftYearMonth } from "@/lib/time";

export function MonthPicker({ value, makeHref }: { value: string; makeHref: (ym: string) => string }) {
  const next = shiftYearMonth(value, 1);
  const canNext = next <= jstYearMonth();
  const cls = "rounded-lg border border-white/10 px-3 py-1.5 text-[13px] hover:bg-white/5";
  return (
    <div className="flex items-center gap-2">
      <Link className={cls} href={makeHref(shiftYearMonth(value, -1))} aria-label="前の月">
        ‹
      </Link>
      <span className="min-w-28 text-center font-serif font-bold">{formatYearMonthJa(value)}</span>
      {canNext ? (
        <Link className={cls} href={makeHref(next)} aria-label="次の月">
          ›
        </Link>
      ) : (
        <span className={`${cls} opacity-30`}>›</span>
      )}
    </div>
  );
}
