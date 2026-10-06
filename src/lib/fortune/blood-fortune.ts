import { CAUTION_BY_CATEGORY, LUCKY_COLORS, LUCKY_ITEMS, RESET_ACTIONS, STYLE_TIPS } from "./content/common";
import { FULL_MOON_MESSAGES, MIRACLE_MESSAGES } from "./content/rarity";
import { BLOOD_CORE, CAUTIONS, GOOD_ACTIONS, GOOD_BLOOD_REASONS, HEALTH, HELPERS, LOVE, MESSAGES, MONEY, MONTH_MOTIFS, OVERALL, TYPE_TODAY, TYPES_48, WORK } from "./content/blood";
import { dayRng, momentOf, purchaseRng, type GenerateContext } from "./context";
import { standardDay } from "./day-stars";
import { rarityInfo } from "./rarity";
import type { Rng } from "./rng";
import { fill, pickTagged, toneOf } from "./select";
import { CATEGORY_KEYS, CATEGORY_LABELS, type BloodResultV2, type BloodTypeValue, type CareSection, type CategoryKey, type DayStars, type RarityKey } from "./types";

/**
 * 血液型占い（v2）：血液型×誕生月の48タイプ。
 *
 * 固定部分（日本時間の日付＋血液型＋誕生月だけで決まる。再購入しても同じ）
 *   各運勢の★・レア度・今日相性のいい血液型
 * 購入ごとに変わる部分
 *   各運勢の文章・うまくいく行動・気をつけたいこと・一言・ラッキー系・整えるヒント
 */

export const bloodSubject = (bloodType: BloodTypeValue, birthMonth: number) => `T:${bloodType}:${birthMonth}`;

/** 今日相性のいい血液型（固定）。今日いちばん控えめな運勢を支える／好調な運勢を広げる持ち味から選ぶ */
export function goodBloodFor(date: string, bloodType: BloodTypeValue, birthMonth: number, stars: DayStars) {
  const sorted = [...CATEGORY_KEYS].sort((a, b) => stars[a] - stars[b]);
  const weakest = sorted[0];
  const mode: "weak" | "strong" = stars[weakest] <= 3 ? "weak" : "strong";
  const target: CategoryKey = mode === "weak" ? weakest : sorted[sorted.length - 1];
  const helper = dayRng(date, bloodSubject(bloodType, birthMonth), "good-blood").pick(HELPERS[target]);
  return { mode, target, helper };
}

function careFor(rarity: RarityKey, stars: DayStars, rng: Rng): CareSection {
  const care: CareSection = {};
  const weakest = [...CATEGORY_KEYS].sort((a, b) => stars[a] - stars[b])[0];
  // 「今日気をつけたいこと」は常に表示するため、ここでは控えめな運勢の具体的な注意点だけを足す
  if (rarity === "NEW_MOON" || stars[weakest] <= 2) care.caution = rng.pick(CAUTION_BY_CATEGORY[weakest]);
  if (rarity === "NEW_MOON" || rarity === "CRESCENT") care.style = rng.pick(STYLE_TIPS);
  if (rarity === "NEW_MOON") care.reset = rng.pick(RESET_ACTIONS);
  return care;
}

export function generateBlood(bloodType: BloodTypeValue, birthMonth: number, ctx: GenerateContext): BloodResultV2 {
  const m = momentOf(ctx.now);
  const subject = bloodSubject(bloodType, birthMonth);
  const { stars: s, rarity } = standardDay(m.date, subject);
  const type = TYPES_48[bloodType][birthMonth];
  const p = purchaseRng(m.date, subject, ctx.purchaseSeed, "text");
  const lucky = purchaseRng(m.date, subject, ctx.purchaseSeed, "lucky");
  const vars = { blood: bloodType, trait: BLOOD_CORE[bloodType].trait, motif: MONTH_MOTIFS[birthMonth], month: birthMonth };
  const tone = toneOf(s.overall);

  const good = goodBloodFor(m.date, bloodType, birthMonth, s);
  const reason = fill(p.pick(GOOD_BLOOD_REASONS[good.mode]), { ...vars, cat: CATEGORY_LABELS[good.target], partner: good.helper.type, help: good.helper.help });
  const used = new Set<string>();
  const special = rarity === "MIRACLE" ? p.pick(MIRACLE_MESSAGES) : rarity === "FULL_MOON" ? p.pick(FULL_MOON_MESSAGES) : undefined;

  return {
    v: 2,
    kind: "BLOOD",
    dateLabel: m.date,
    generatedAt: ctx.now.toISOString(),
    bloodType,
    birthMonth,
    typeName: type.name,
    typeCatch: type.catch,
    typeFeature: type.feature,
    typeToday: fill(pickTagged(p, TYPE_TODAY, { tone }).text, { ...vars, name: type.name }),
    overall: { stars: s.overall, comment: fill(p.pick(OVERALL[s.overall]), vars) },
    love: { stars: s.love, comment: fill(p.pick(LOVE[s.love]), vars) },
    work: { stars: s.work, comment: fill(p.pick(WORK[s.work]), vars) },
    money: { stars: s.money, comment: fill(p.pick(MONEY[s.money]), vars) },
    health: { stars: s.health, comment: fill(p.pick(HEALTH[s.health]), vars) },
    goodAction: pickTagged(p, GOOD_ACTIONS[bloodType], { tone }, used).text,
    caution: pickTagged(p, CAUTIONS[bloodType], { tone }, used).text,
    goodBlood: { type: good.helper.type, reason },
    luckyColor: lucky.pick(LUCKY_COLORS),
    luckyItem: pickTagged(lucky, LUCKY_ITEMS, { season: m.season }).text,
    luckyNumber: lucky.int(1, 9),
    message: fill(pickTagged(p, MESSAGES, { tone }, used).text, vars),
    care: careFor(rarity, s, p),
    rarity: rarityInfo(rarity, s, undefined, special),
  };
}
