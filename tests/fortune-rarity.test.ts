import { describe, expect, it } from "vitest";
import { CATEGORY_OFFSET_WEIGHTS, judgeStandardRarity, judgeZodiacRarity, rarityReasons, STANDARD_OVERALL_WEIGHTS } from "@/lib/fortune/rarity";
import { generateZodiac, starsForRank, zodiacDay } from "@/lib/fortune/zodiac-fortune";
import { ZODIAC_KEYS } from "@/lib/fortune/zodiac";
import { RARITY_KEYS, type DayStars, type RarityKey, type Stars } from "@/lib/fortune/types";
import { jstDateString } from "@/lib/time";

const START = Date.UTC(2026, 0, 1, 3);
const dateAt = (i: number) => jstDateString(new Date(START + i * 86_400_000));
/** 目標の出現率（%）と許容差 */
const TARGET: Record<RarityKey, [number, number]> = {
  MIRACLE: [2.0, 0.5],
  FULL_MOON: [7.7, 1.5],
  HALF_MOON: [20.5, 2],
  CRESCENT: [35.8, 2.5],
  NEW_MOON: [34.0, 2.5],
};

describe("今日の運勢レア度：12星座占い", () => {
  // 20年分 × 12星座 = 87,660件
  const days = Array.from({ length: 7305 }, (_, i) => zodiacDay(dateAt(i)));
  const all = days.flat();

  it("毎日 12星座が1〜12位に重複なく並び、総合運は順位どおり", () => {
    for (const day of days) {
      expect(new Set(day.map((d) => d.key)).size).toBe(12);
      expect(day.map((d) => d.rank)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
      for (const d of day) expect(d.stars.overall).toBe(starsForRank(d.rank));
    }
  });

  it("出現率が目標どおり（MIRACLE 約2%）", () => {
    const rate = (k: RarityKey) => (100 * all.filter((d) => d.rarity === k).length) / all.length;
    for (const k of RARITY_KEYS) {
      const [target, tol] = TARGET[k];
      expect(Math.abs(rate(k) - target), `${k}: ${rate(k).toFixed(2)}%`).toBeLessThanOrEqual(tol);
    }
  });

  it("MIRACLE は「12星座中1位」かつ「4つの運勢すべて★5」のときだけ", () => {
    for (const d of all) {
      const allFive = d.stars.love === 5 && d.stars.work === 5 && d.stars.money === 5 && d.stars.health === 5;
      expect(d.rarity === "MIRACLE").toBe(d.rank === 1 && allFive);
    }
  });

  it("MIRACLE が出る日は毎日ではない（1日に出るのは最大1星座）", () => {
    const miracleDays = days.filter((day) => day.some((d) => d.rarity === "MIRACLE")).length;
    for (const day of days) expect(day.filter((d) => d.rarity === "MIRACLE").length).toBeLessThanOrEqual(1);
    expect(miracleDays / days.length).toBeLessThan(0.35);
  });
});

describe("今日の運勢レア度：血液型占い・生年月日占い用の判定（ランキングなし）", () => {
  // ★の出方のモデル（総合運 STANDARD_OVERALL_WEIGHTS、各運勢 総合運±2）で全組み合わせを厳密に計算
  function distribution(): Record<RarityKey, number> {
    const out = Object.fromEntries(RARITY_KEYS.map((k) => [k, 0])) as Record<RarityKey, number>;
    const ow = STANDARD_OVERALL_WEIGHTS.reduce((a, b) => a + b, 0);
    const cw = CATEGORY_OFFSET_WEIGHTS.reduce((a, b) => a + b, 0);
    const clamp = (n: number) => Math.min(5, Math.max(1, n)) as Stars;
    for (let o = 1; o <= 5; o++) {
      const po = STANDARD_OVERALL_WEIGHTS[o - 1] / ow;
      for (let a = 0; a < 5; a++)
        for (let b = 0; b < 5; b++)
          for (let c = 0; c < 5; c++)
            for (let d = 0; d < 5; d++) {
              const p = po * [a, b, c, d].reduce((acc, i) => acc * (CATEGORY_OFFSET_WEIGHTS[i] / cw), 1);
              const s: DayStars = { overall: o as Stars, love: clamp(o + a - 2), work: clamp(o + b - 2), money: clamp(o + c - 2), health: clamp(o + d - 2) };
              out[judgeStandardRarity(s)] += p * 100;
            }
    }
    return out;
  }

  it("出現率が目標どおりで、12星座占いとの差が小さい", () => {
    const dist = distribution();
    for (const k of RARITY_KEYS) {
      const [target, tol] = TARGET[k];
      expect(Math.abs(dist[k] - target), `${k}: ${dist[k].toFixed(2)}%`).toBeLessThanOrEqual(tol + 0.5);
    }
    expect(Math.abs(dist.MIRACLE - 2.0)).toBeLessThan(0.3);
  });

  it("MIRACLE は「総合運★5」かつ「4つの運勢すべて★5」のときだけ", () => {
    const five: DayStars = { overall: 5, love: 5, work: 5, money: 5, health: 5 };
    expect(judgeStandardRarity(five)).toBe("MIRACLE");
    expect(judgeStandardRarity({ ...five, health: 4 })).not.toBe("MIRACLE");
    expect(judgeStandardRarity({ ...five, overall: 4 })).not.toBe("MIRACLE");
  });
});

describe("レア度は固定部分だけで決まる（再購入で変わらない）", () => {
  it("購入ごとの値が違っても ★・順位・レア度・相性は同じ、文章は変わる", () => {
    let textChanged = 0;
    let total = 0;
    for (let i = 0; i < 120; i++) {
      const now = new Date(START + i * 86_400_000 + 5 * 3_600_000);
      for (const sign of ZODIAC_KEYS) {
        const a = generateZodiac(sign, { now, purchaseSeed: "purchase-A" });
        const b = generateZodiac(sign, { now, purchaseSeed: "purchase-B" });
        for (const k of ["overall", "love", "work", "money", "health"] as const) expect(a[k].stars).toBe(b[k].stars);
        expect(a.rank).toBe(b.rank);
        expect(a.ranking).toEqual(b.ranking);
        expect(a.rarity.key).toBe(b.rarity.key);
        expect(a.rarity.reasons).toEqual(b.rarity.reasons);
        expect(a.goodSign.key).toBe(b.goodSign.key);
        expect(a.cautionSign.key).toBe(b.cautionSign.key);
        total++;
        if (a.starMessage !== b.starMessage || a.action !== b.action || a.luckyItem !== b.luckyItem || a.overall.comment !== b.overall.comment) textChanged++;
      }
    }
    // 再購入では一字一句同じ結果にならない（ほぼ必ずどこかの文章が変わる）
    expect(textChanged / total).toBeGreaterThan(0.95);
  });

  it("同じ購入（同じ値）なら一字一句同じ結果", () => {
    const now = new Date(START + 10 * 86_400_000);
    expect(generateZodiac("leo", { now, purchaseSeed: "x" })).toEqual(generateZodiac("leo", { now, purchaseSeed: "x" }));
  });

  it("全レア度で「なぜこのレア度か」の説明がある", () => {
    const s: DayStars = { overall: 3, love: 3, work: 2, money: 4, health: 3 };
    for (const k of RARITY_KEYS) expect(rarityReasons(k, s, 5).length).toBeGreaterThanOrEqual(2);
    const miracle = rarityReasons("MIRACLE", { overall: 5, love: 5, work: 5, money: 5, health: 5 }, 1);
    expect(miracle).toContain("12星座中 1位");
    expect(judgeZodiacRarity({ overall: 5, love: 5, work: 5, money: 5, health: 5 }, 2)).toBe("FULL_MOON");
  });
});
