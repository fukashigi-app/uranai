import { formatYearMonthJa, isValidYearMonth, jstMonthRange, jstYearMonth, shiftYearMonth } from "@/lib/time";

/**
 * 管理画面の集計期間。すべての数字（件数・売上・取り分・合計）は同じ期間で集計する。
 *  - this  … 今月（既定）
 *  - last  … 先月
 *  - month … 指定した月（ym=YYYY-MM）
 *  - all   … 全期間
 */
export type PeriodKey = "this" | "last" | "month" | "all";

export type Period = {
  key: PeriodKey;
  /** 表示用（例: 「2026年10月（今月）」「全期間」） */
  label: string;
  /** 対象の年月（全期間は null） */
  yearMonth: string | null;
  /** 集計範囲（paid_at の [start, end)）。全期間は null */
  range: { start: Date; end: Date } | null;
};

export function resolvePeriod(periodParam?: string, ymParam?: string): Period {
  const current = jstYearMonth();
  if (periodParam === "all") return { key: "all", label: "全期間", yearMonth: null, range: null };
  if (periodParam === "last") {
    const ym = shiftYearMonth(current, -1);
    return { key: "last", label: `${formatYearMonthJa(ym)}（先月）`, yearMonth: ym, range: jstMonthRange(ym) };
  }
  if (periodParam === "month" && ymParam && isValidYearMonth(ymParam) && ymParam <= current && ymParam >= "2000-01") {
    return { key: "month", label: formatYearMonthJa(ymParam), yearMonth: ymParam, range: jstMonthRange(ymParam) };
  }
  return { key: "this", label: `${formatYearMonthJa(current)}（今月）`, yearMonth: current, range: jstMonthRange(current) };
}

/** URLクエリ文字列（period / ym） */
export function periodQuery(p: Period): Record<string, string> {
  return p.key === "month" && p.yearMonth ? { period: "month", ym: p.yearMonth } : { period: p.key };
}
