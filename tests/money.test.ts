import { describe, expect, it } from "vitest";
import { calcFee, percentStringToBps, splitRevenue } from "@/lib/money";
import { jstDateString, jstMonthRange, jstYearMonth, shiftYearMonth } from "@/lib/time";

describe("splitRevenue", () => {
  it("100円の30%は店舗30円・運営70円", () => {
    expect(splitRevenue(100, 3000)).toEqual({ storeShare: 30, operatorShare: 70 });
  });
  it("端数は切り捨てて店舗に、残りは運営に（合計は常に一致）", () => {
    const r = splitRevenue(100, 3333);
    expect(r.storeShare).toBe(33);
    expect(r.storeShare + r.operatorShare).toBe(100);
  });
  it("不正値を拒否", () => {
    expect(() => splitRevenue(100.5, 3000)).toThrow();
    expect(() => splitRevenue(100, 10001)).toThrow();
    expect(() => splitRevenue(-1, 3000)).toThrow();
  });
});

describe("fees", () => {
  it("fee_rate 文字列を bps に変換", () => {
    expect(percentStringToBps("3.00")).toBe(300);
    expect(percentStringToBps("3.6")).toBe(360);
    expect(percentStringToBps(null)).toBeNull();
    expect(percentStringToBps("abc")).toBeNull();
  });
  it("手数料は整数円", () => {
    expect(calcFee(100, 360)).toBe(4);
    expect(calcFee(100, 300)).toBe(3);
  });
});

describe("JST", () => {
  it("UTC 15:00 は JST 翌日", () => {
    expect(jstDateString(new Date("2026-09-30T15:00:00Z"))).toBe("2026-10-01");
    expect(jstYearMonth(new Date("2026-09-30T14:59:59Z"))).toBe("2026-09");
  });
  it("月の範囲", () => {
    const { start, end } = jstMonthRange("2026-10");
    expect(start.toISOString()).toBe("2026-09-30T15:00:00.000Z");
    expect(end.toISOString()).toBe("2026-10-31T15:00:00.000Z");
    expect(shiftYearMonth("2026-01", -1)).toBe("2025-12");
  });
});
