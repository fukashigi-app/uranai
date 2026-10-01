/** JST(UTC+9, DSTなし)の日付ユーティリティ */
const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

export function jstDateString(d: Date = new Date()): string {
  return new Date(d.getTime() + JST_OFFSET_MS).toISOString().slice(0, 10);
}

/** "2026-10" */
export function jstYearMonth(d: Date = new Date()): string {
  return jstDateString(d).slice(0, 7);
}

/** JSTの年月の開始・終了（UTCのDate） */
export function jstMonthRange(yearMonth: string): { start: Date; end: Date } {
  const m = /^(\d{4})-(\d{2})$/.exec(yearMonth);
  if (!m) throw new Error("invalid yearMonth");
  const y = Number(m[1]);
  const mo = Number(m[2]);
  if (mo < 1 || mo > 12) throw new Error("invalid yearMonth");
  const start = new Date(Date.UTC(y, mo - 1, 1) - JST_OFFSET_MS);
  const end = new Date(Date.UTC(y, mo, 1) - JST_OFFSET_MS);
  return { start, end };
}

export function shiftYearMonth(yearMonth: string, delta: number): string {
  const [y, m] = yearMonth.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1 + delta, 1));
  return d.toISOString().slice(0, 7);
}

export function isValidYearMonth(v: string): boolean {
  return /^\d{4}-(0[1-9]|1[0-2])$/.test(v);
}

export function formatYearMonthJa(yearMonth: string): string {
  const [y, m] = yearMonth.split("-");
  return `${y}年${Number(m)}月`;
}

export function formatDateTimeJa(d: Date | string | null | undefined): string {
  if (!d) return "—";
  const date = typeof d === "string" ? new Date(d) : d;
  return new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

export function formatDateJa(d: Date | string): string {
  const date = typeof d === "string" ? new Date(d) : d;
  return new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "long",
    day: "numeric",
    weekday: "short",
  }).format(date);
}
