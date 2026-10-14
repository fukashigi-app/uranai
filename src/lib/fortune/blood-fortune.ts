import { LUCKY_COLORS, LUCKY_ITEMS } from "./content/common";
import { FULL_MOON_MESSAGES, MIRACLE_MESSAGES } from "./content/rarity";
import { BLOOD_CORE, CARE_CAUTION, CARE_RESET, CARE_STYLE, CAUTIONS, GOOD_ACTIONS, GOOD_BLOOD_REASONS, HEALTH, HELPERS, LOVE, MESSAGES, MONEY, MONTH_MOTIFS, OVERALL, TYPE_TODAY, TYPES_48, WORK } from "./content/blood";
import { dayRng, momentOf, purchaseRng, type GenerateContext } from "./context";
import { standardDay } from "./day-stars";
import { rarityInfo } from "./rarity";
import type { Rng } from "./rng";
import { createComposer, pickTagged, toneOf, type Composer } from "./select";
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

function careFor(rarity: RarityKey, stars: DayStars, rng: Rng, text: Composer): CareSection {
  const care: CareSection = {};
  const weakest = [...CATEGORY_KEYS].sort((a, b) => stars[a] - stars[b])[0];
  // 「今日気をつけたいこと」は常に表示するため、ここでは控えめな運勢の具体的な注意点だけを足す
  if (rarity === "NEW_MOON" || stars[weakest] <= 2) care.caution = text.pick(rng, CARE_CAUTION[weakest]);
  if (rarity === "NEW_MOON" || rarity === "CRESCENT") care.style = text.pick(rng, CARE_STYLE);
  if (rarity === "NEW_MOON") care.reset = text.pick(rng, CARE_RESET);
  return care;
}

/** 読む文章の合計文字数の上限の目安（血液型占いは 400〜600 字） */
const MAX_READING_LENGTH = 600;
/** 同じ結果の中で使う回数の上限（血液型の持ち味・「日」止めの文が続きすぎないように） */
const PHRASE_LIMITS = { あなた: 3, 日です: 1, 疲れやすい: 1 } as const;

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
  const special = rarity === "MIRACLE" ? p.pick(MIRACLE_MESSAGES) : rarity === "FULL_MOON" ? p.pick(FULL_MOON_MESSAGES) : undefined;
  const info = rarityInfo(rarity, s, undefined, special);
  const luckyColor = lucky.pick(LUCKY_COLORS);
  const luckyItem = pickTagged(lucky, LUCKY_ITEMS, { season: m.season }).text;
  const luckyNumber = lucky.int(1, 9);
  const others = [type.name, luckyColor.name, luckyItem, String(luckyNumber), info.tagline, ...info.reasons, special ?? ""];
  const text = createComposer(
    { ...vars, name: type.name, cat: CATEGORY_LABELS[good.target], partner: good.helper.type, help: good.helper.help },
    { limits: { ...PHRASE_LIMITS, [vars.trait]: 2, [vars.motif]: 1 }, maxLength: MAX_READING_LENGTH - others.reduce((n, t) => n + [...t].length, 0) },
  );
  for (const t of [type.catch, type.feature]) text.add(t);
  const typeToday = text.pick(p, TYPE_TODAY, { tone });
  const overall = text.pick(p, OVERALL[s.overall]);
  const love = text.pick(p, LOVE[s.love]);
  const work = text.pick(p, WORK[s.work]);
  const money = text.pick(p, MONEY[s.money]);
  const health = text.pick(p, HEALTH[s.health]);
  const goodAction = text.pick(p, GOOD_ACTIONS[bloodType], { tone });
  const caution = text.pick(p, CAUTIONS[bloodType], { tone });
  const reason = text.pick(p, GOOD_BLOOD_REASONS[good.mode]);
  const message = text.pick(p, MESSAGES, { tone });
  const care = careFor(rarity, s, p, text);

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
    typeToday,
    overall: { stars: s.overall, comment: overall },
    love: { stars: s.love, comment: love },
    work: { stars: s.work, comment: work },
    money: { stars: s.money, comment: money },
    health: { stars: s.health, comment: health },
    goodAction,
    caution,
    goodBlood: { type: good.helper.type, reason },
    luckyColor,
    luckyItem,
    luckyNumber,
    message,
    care,
    rarity: info,
  };
}
