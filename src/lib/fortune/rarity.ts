import { CATEGORY_KEYS, CATEGORY_LABELS, type CategoryKey, type DayStars, type RarityInfo, type RarityKey, type Stars } from "./types";

/**
 * 今日の運勢レア度。画面に表示される「今日の基本運勢」（★・12星座ランキング）だけで判定する。
 * 購入ごとに変わる値や、見えない追加抽選は一切使わない → 同じ日・同じ入力なら何度払っても同じレア度。
 *
 * 想定出現率（tests/fortune-rarity.test.ts で検証）
 *   MIRACLE 約2% / FULL MOON 約8% / HALF MOON 約20% / CRESCENT 約36% / NEW MOON 約34%
 */

export const RARITY_TIERS: Record<RarityKey, Omit<RarityInfo, "key" | "reasons" | "special">> = {
  NEW_MOON: { level: 1, en: "NEW MOON", ja: "新月", tagline: "整える日" },
  CRESCENT: { level: 2, en: "CRESCENT", ja: "三日月", tagline: "小さな幸運の日" },
  HALF_MOON: { level: 3, en: "HALF MOON", ja: "上弦", tagline: "追い風の日" },
  FULL_MOON: { level: 4, en: "FULL MOON", ja: "満月", tagline: "幸運が満ちる日" },
  MIRACLE: { level: 5, en: "MIRACLE", ja: "奇跡の星夜", tagline: "めったに訪れない特別な一日" },
};

const cats = (s: DayStars) => CATEGORY_KEYS.map((k) => s[k]);
const total = (s: DayStars) => s.overall * 4 + cats(s).reduce((a, b) => a + b, 0); // 総合運を4倍で重視
const fives = (s: DayStars) => cats(s).filter((x) => x === 5).length;
const minCat = (s: DayStars) => Math.min(...cats(s));

/**
 * 12星座占い：総合運は順位で決まる（1〜2位★5 / 3〜6位★4 / 7〜10位★3 / 11位★2 / 12位★1）。
 *  MIRACLE   … 12星座中1位 かつ 4つの運勢すべて★5
 *  FULL MOON … 総合運★5 かつ 4つの運勢すべて★4以上で★5が3つ以上
 *  HALF MOON … 総合運★5、または 総合運★4で運勢全体がかなり好調
 *  CRESCENT  … 運勢全体がまずまず
 *  NEW MOON  … それ以外（整える日）
 */
export function judgeZodiacRarity(s: DayStars, rank: number): RarityKey {
  if (rank === 1 && s.overall === 5 && fives(s) === 4) return "MIRACLE";
  if (s.overall === 5 && minCat(s) >= 4 && fives(s) >= 3) return "FULL_MOON";
  if (s.overall === 5 || (s.overall === 4 && total(s) >= 33)) return "HALF_MOON";
  if (total(s) >= 25) return "CRESCENT";
  return "NEW_MOON";
}

/**
 * 血液型占い・生年月日占い用（ランキングが無い占い）。
 * 総合運★5の出やすさを STANDARD_OVERALL_WEIGHTS で12星座の「1位」と同じ 1/12 に合わせ、
 * MIRACLE の条件を「総合運★5 かつ 全運勢★5」にすることで、見えない条件を使わずに約2%にそろえる。
 */
/** 総合運に対する各運勢のずれ（-2〜+2）の出やすさ。3種類の占いで共通 */
export const CATEGORY_OFFSET_WEIGHTS = [5, 25, 35, 25, 10] as const;

export const STANDARD_OVERALL_WEIGHTS = [1, 1, 6, 3, 1] as const; // ★1〜★5（合計12）

export function judgeStandardRarity(s: DayStars): RarityKey {
  if (s.overall === 5 && fives(s) === 4) return "MIRACLE";
  if ((s.overall === 5 && minCat(s) >= 4) || (s.overall === 4 && minCat(s) >= 4 && fives(s) >= 2)) return "FULL_MOON";
  if (s.overall === 5 || (s.overall === 4 && total(s) >= 30)) return "HALF_MOON";
  if (total(s) >= 24) return "CRESCENT";
  return "NEW_MOON";
}

const starText = (n: Stars) => "★".repeat(n) + "☆".repeat(5 - n);
const labels = (keys: CategoryKey[]) => keys.map((k) => CATEGORY_LABELS[k]).join("・");

/** なぜこのレア度なのか（内部の点数は見せず、画面の★と順位だけで説明） */
export function rarityReasons(key: RarityKey, s: DayStars, rank?: number): string[] {
  const high = CATEGORY_KEYS.filter((k) => s[k] >= 4);
  const top = CATEGORY_KEYS.filter((k) => s[k] === 5);
  const low = CATEGORY_KEYS.filter((k) => s[k] <= 2);
  const out = [`総合運 ${starText(s.overall)}`];
  if (rank) out.push(`12星座中 ${rank}位`);
  switch (key) {
    case "MIRACLE":
      out.push("恋愛運・仕事運・金運・健康運 すべて★5");
      break;
    case "FULL_MOON":
      out.push(top.length === 4 ? "4つの運勢すべて★5" : `${labels(top)}が★5`);
      if (top.length < 4) out.push("4つの運勢すべて★4以上");
      break;
    case "HALF_MOON":
      if (high.length) out.push(`${labels(high)}が好調（★4以上）`);
      else out.push("総合運が最高ランク");
      break;
    case "CRESCENT":
      out.push(high.length ? `${labels(high)}が好調（★4以上）` : "大きく崩れる運勢のない安定した一日");
      break;
    case "NEW_MOON":
      if (low.length) out.push(`${labels(low)}はひと休みモード`);
      out.push("無理をせず整えるほど、明日の運気につながる日");
      break;
  }
  return out;
}

export function rarityInfo(key: RarityKey, s: DayStars, rank?: number, special?: string): RarityInfo {
  return { key, ...RARITY_TIERS[key], reasons: rarityReasons(key, s, rank), ...(special ? { special } : {}) };
}
