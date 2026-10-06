import { dayRng } from "./context";
import { CATEGORY_OFFSET_WEIGHTS, judgeStandardRarity, STANDARD_OVERALL_WEIGHTS } from "./rarity";
import type { DayStars, RarityKey, Stars } from "./types";

const clamp = (n: number) => Math.min(5, Math.max(1, n)) as Stars;

/**
 * ランキングの無い占い（血液型・生年月日）の「今日の基本運勢」。
 * 日付＋入力（subject）だけで決まる固定部分。購入ごとの値は使わない。
 */
export function standardDay(date: string, subject: string): { stars: DayStars; rarity: RarityKey } {
  const rng = dayRng(date, subject, "stars");
  const overall = (rng.weighted(STANDARD_OVERALL_WEIGHTS) + 1) as Stars;
  const cat = () => clamp(overall + rng.weighted(CATEGORY_OFFSET_WEIGHTS) - 2);
  const stars: DayStars = { overall, love: cat(), work: cat(), money: cat(), health: cat() };
  return { stars, rarity: judgeStandardRarity(stars) };
}
