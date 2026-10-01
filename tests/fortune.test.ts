import { describe, expect, it } from "vitest";
import { fortuneInputSchema, templateEngine } from "@/lib/fortune/engine";
import { createRng, hashString } from "@/lib/fortune/rng";
import { isValidBirthDate, lifePathNumber, zodiacFromDate } from "@/lib/fortune/zodiac";

const day = new Date("2026-10-01T03:00:00Z");
const nextDay = new Date("2026-10-02T03:00:00Z");

describe("rng", () => {
  it("同じseedなら同じ系列", () => {
    const a = createRng(hashString("x"));
    const b = createRng(hashString("x"));
    expect([a.next(), a.next(), a.next()]).toEqual([b.next(), b.next(), b.next()]);
  });
});

describe("templateEngine", () => {
  it("同一人物・同一日・同一条件は同じ結果", async () => {
    const input = { type: "BIRTHDAY" as const, birthDate: "1990-05-12" };
    const r1 = await templateEngine.generate(input, day);
    const r2 = await templateEngine.generate(input, new Date("2026-10-01T14:00:00Z")); // 同じJST日付
    expect(r1).toEqual(r2);
  });
  it("日付が変われば結果が変わる（少なくとも一部）", async () => {
    const results = new Set<string>();
    for (let i = 0; i < 7; i++) {
      const r = await templateEngine.generate({ type: "BLOOD", bloodType: "A" }, new Date(day.getTime() + i * 86400000));
      results.add(JSON.stringify(r));
    }
    expect(results.size).toBeGreaterThan(1);
    expect(await templateEngine.generate({ type: "BLOOD", bloodType: "A" }, nextDay)).toBeDefined();
  });
  it("星の数は1〜5、必要な項目がそろう", async () => {
    const r = await templateEngine.generate({ type: "ZODIAC", sign: "libra" }, day);
    for (const k of ["overall", "love", "work", "money"] as const) {
      expect(r[k].stars).toBeGreaterThanOrEqual(1);
      expect(r[k].stars).toBeLessThanOrEqual(5);
      expect(r[k].comment.length).toBeGreaterThan(0);
    }
    expect(r.luckyColor.hex).toMatch(/^#[0-9a-f]{6}$/);
    expect(r.highlight).toMatch(/^今日の12星座ランキング ([1-9]|1[0-2])位$/);
  });
  it("結果に生年月日そのものを含めない", async () => {
    const r = await templateEngine.generate({ type: "BIRTHDAY", birthDate: "1990-05-12" }, day);
    expect(JSON.stringify(r)).not.toContain("1990-05-12");
  });
  it("12星座のランキングは重複しない", async () => {
    const signs = ["aries","taurus","gemini","cancer","leo","virgo","libra","scorpio","sagittarius","capricorn","aquarius","pisces"] as const;
    const ranks = await Promise.all(signs.map(async (s) => (await templateEngine.generate({ type: "ZODIAC", sign: s }, day)).highlight));
    expect(new Set(ranks).size).toBe(12);
  });
});

describe("input validation", () => {
  it("不正な生年月日を拒否", () => {
    expect(fortuneInputSchema.safeParse({ type: "BIRTHDAY", birthDate: "2023-02-30" }).success).toBe(false);
    expect(fortuneInputSchema.safeParse({ type: "BIRTHDAY", birthDate: "1899-01-01" }).success).toBe(false);
    expect(fortuneInputSchema.safeParse({ type: "BIRTHDAY", birthDate: "2000-01-01" }).success).toBe(true);
    expect(fortuneInputSchema.safeParse({ type: "BLOOD", bloodType: "C" }).success).toBe(false);
    expect(fortuneInputSchema.safeParse({ type: "ZODIAC", sign: "dragon" }).success).toBe(false);
  });
  it("星座境界・誕生数", () => {
    expect(zodiacFromDate(3, 21)).toBe("aries");
    expect(zodiacFromDate(1, 19)).toBe("capricorn");
    expect(zodiacFromDate(12, 22)).toBe("capricorn");
    expect(zodiacFromDate(2, 19)).toBe("pisces");
    expect(lifePathNumber(1990, 5, 12)).toBe(9); // 1+9+9+0+5+1+2=27 → 2+7=9
    expect(lifePathNumber(1992, 11, 9)).toBe(5); // 1+9+9+2+1+1+9=32 → 5
    expect(lifePathNumber(1983, 2, 6)).toBe(11); // 1+9+8+3+2+6=29 → 11（マスターナンバー）
    expect(isValidBirthDate("2024-02-29")).toBe(true);
  });
});
