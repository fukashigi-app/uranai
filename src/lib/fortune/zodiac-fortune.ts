import { LUCKY_COLORS, LUCKY_ITEMS, LUCKY_TIME_WINDOWS } from "./content/common";
import { FULL_MOON_MESSAGES, MIRACLE_MESSAGES } from "./content/rarity";
import {
  ACTIONS,
  CAUTION_BY_CATEGORY,
  CAUTION_SIGN_REASONS,
  GOOD_SIGN_REASONS,
  HEALTH,
  LOVE,
  MONEY,
  OVERALL,
  RANK_HEADLINES,
  RESET_ACTIONS,
  SIGN_POINTS,
  SIGN_PROFILES,
  STAR_MESSAGES,
  STYLE_TIPS,
  WORK,
} from "./content/zodiac";
import { dayRng, momentOf, purchaseRng, type GenerateContext, type Moment } from "./context";
import { CATEGORY_OFFSET_WEIGHTS, judgeZodiacRarity, rarityInfo } from "./rarity";
import type { Rng } from "./rng";
import { createComposer, pickTagged, toneOf, type Composer } from "./select";
import { CATEGORY_KEYS, type CareSection, type CategoryKey, type DayStars, type RarityKey, type Stars, type ZodiacResultV2 } from "./types";
import { ZODIAC_SIGNS, zodiacInfo, type ZodiacKey } from "./zodiac";

/**
 * 12星座占い（v2）。主役は「今日の12星座ランキング」。
 *
 * 固定部分（日付だけ／日付＋星座だけで決まる。再購入しても同じ）
 *   ランキング・各運勢の★・レア度・相性のいい星座・注意したい星座
 * 購入ごとに変わる部分
 *   各運勢の文章・星からのメッセージ・ラッキー系・開運アクション・整えるヒントの文章
 */

/** 順位 → 総合運（1〜2位★5 / 3〜6位★4 / 7〜10位★3 / 11位★2 / 12位★1） */
export function starsForRank(rank: number): Stars {
  if (rank <= 2) return 5;
  if (rank <= 6) return 4;
  if (rank <= 10) return 3;
  if (rank === 11) return 2;
  return 1;
}

const clamp = (n: number) => Math.min(5, Math.max(1, n)) as Stars;

/** その日の12星座ランキング（日付だけで決まる。必ず1〜12位に重複なく並ぶ） */
export function zodiacRanking(date: string): ZodiacKey[] {
  const keys = ZODIAC_SIGNS.map((s) => s.key) as ZodiacKey[];
  const rng = dayRng(date, "ZODIAC", "ranking");
  for (let i = keys.length - 1; i > 0; i--) {
    const j = Math.floor(rng.next() * (i + 1));
    [keys[i], keys[j]] = [keys[j], keys[i]];
  }
  return keys;
}

export type ZodiacDayEntry = { key: ZodiacKey; rank: number; stars: DayStars; rarity: RarityKey };

/** その日の12星座すべての基本運勢（固定部分） */
export function zodiacDay(date: string): ZodiacDayEntry[] {
  return zodiacRanking(date).map((key, i) => {
    const rank = i + 1;
    const overall = starsForRank(rank);
    const rng = dayRng(date, `Z:${key}`, "stars");
    const cat = () => clamp(overall + rng.weighted(CATEGORY_OFFSET_WEIGHTS) - 2);
    const stars: DayStars = { overall, love: cat(), work: cat(), money: cat(), health: cat() };
    return { key, rank, stars, rarity: judgeZodiacRarity(stars, rank) };
  });
}

const ELEMENT_JA: Record<string, string> = { fire: "火", earth: "地", air: "風", water: "水" };
const COMPLEMENT: Record<string, string> = { fire: "air", air: "fire", earth: "water", water: "earth" };
const signIndex = (key: string) => ZODIAC_SIGNS.findIndex((s) => s.key === key);

function ref(key: ZodiacKey) {
  const s = zodiacInfo(key);
  return { key: s.key, name: s.name, symbol: s.symbol };
}

function luckyTime(m: Moment, rng: Rng): string {
  const nowH = m.hour + m.minute / 60;
  // 結果を作った時刻より後に少なくとも30分以上残っている時間帯だけ
  const future = LUCKY_TIME_WINDOWS.filter(([, end]) => end - nowH >= 0.5);
  if (future.length === 0) return "明日 7:00〜9:00";
  const [s, e] = rng.pick(future);
  return `${s}:00〜${e}:00`;
}

function careFor(rarity: RarityKey, stars: DayStars, rng: Rng, text: Composer): CareSection {
  const care: CareSection = {};
  const weakest = [...CATEGORY_KEYS].sort((a, b) => stars[a] - stars[b])[0] as CategoryKey;
  if (stars[weakest] <= 2 || rarity === "NEW_MOON") care.caution = text.pick(rng, CAUTION_BY_CATEGORY[weakest]);
  if (rarity === "NEW_MOON" || rarity === "CRESCENT") care.style = text.pick(rng, STYLE_TIPS);
  if (rarity === "NEW_MOON") care.reset = text.pick(rng, RESET_ACTIONS);
  return care;
}

/** 読む文章の合計文字数の上限の目安（12星座占いは 400〜600 字） */
const MAX_READING_LENGTH = 600;
/** 同じ結果の中で使う回数の上限（「星」「あなた」が続きすぎないように） */
const PHRASE_LIMITS = { 星: 6, あなた: 3, 日です: 1 } as const;

export function generateZodiac(signKey: ZodiacKey, ctx: GenerateContext): ZodiacResultV2 {
  const m = momentOf(ctx.now);
  const day = zodiacDay(m.date);
  const me = day.find((d) => d.key === signKey)!;
  const sign = zodiacInfo(signKey);
  const profile = SIGN_PROFILES[signKey];
  const subject = `Z:${signKey}`;
  const p = purchaseRng(m.date, subject, ctx.purchaseSeed, "text");
  const lucky = purchaseRng(m.date, subject, ctx.purchaseSeed, "lucky");
  const s = me.stars;
  const tone = toneOf(s.overall);

  // 相性のいい星座：同じエレメント＋高め合うエレメントのうち、今日いちばん順位が高い星座（固定）
  const i = signIndex(signKey);
  const sameEl = [4, 8].map((d) => ZODIAC_SIGNS[(i + d) % 12].key as ZodiacKey);
  const compEl = ZODIAC_SIGNS.filter((z) => z.element === COMPLEMENT[sign.element]).map((z) => z.key as ZodiacKey);
  const byRank = (a: ZodiacKey, b: ZodiacKey) => day.find((d) => d.key === a)!.rank - day.find((d) => d.key === b)!.rank;
  const good = [...sameEl, ...compEl].sort(byRank)[0];
  const goodEntry = day.find((d) => d.key === good)!;
  const goodInfo = zodiacInfo(good);
  // 注意したい星座：90度の位置にある2星座のうち、今日順位が低いほう（固定）
  const caution = [3, 9].map((d) => ZODIAC_SIGNS[(i + d) % 12].key as ZodiacKey).sort(byRank)[1];
  const cautionInfo = zodiacInfo(caution);

  const vars = {
    sign: sign.name,
    strength: profile.strength,
    rank: me.rank,
    element: ELEMENT_JA[sign.element],
    otherElement: ELEMENT_JA[goodInfo.element],
    other: goodInfo.name,
    otherRank: goodEntry.rank,
    caution: cautionInfo.name,
  };
  const rarity = me.rarity;
  const special = rarity === "MIRACLE" ? p.pick(MIRACLE_MESSAGES) : rarity === "FULL_MOON" ? p.pick(FULL_MOON_MESSAGES) : undefined;
  const info = rarityInfo(rarity, s, me.rank, special);
  const luckyColor = lucky.pick(LUCKY_COLORS);
  const luckyItem = pickTagged(lucky, LUCKY_ITEMS, { season: m.season }).text;
  const time = luckyTime(m, lucky);
  const others = [luckyColor.name, luckyItem, time, info.tagline, ...info.reasons, special ?? ""];

  // 星座の持ち味（{strength}）は1つの結果で2回まで。「星」「あなた」も続きすぎないようにする
  const text = createComposer(vars, {
    limits: { ...PHRASE_LIMITS, [profile.strength]: 2 },
    maxLength: MAX_READING_LENGTH - others.reduce((n, t) => n + [...t].length, 0),
  });
  text.add(profile.note);
  const rankHeadline = text.pick(p, RANK_HEADLINES[me.rank]);
  const overall = text.pick(p, OVERALL[s.overall]);
  const point = text.pick(p, SIGN_POINTS, { tone });
  const love = text.pick(p, LOVE[s.love]);
  const work = text.pick(p, WORK[s.work]);
  const money = text.pick(p, MONEY[s.money]);
  const health = text.pick(p, HEALTH[s.health]);
  const starMessage = text.pick(p, STAR_MESSAGES, { tone });
  const goodReason = text.pick(p, GOOD_SIGN_REASONS[sameEl.includes(good) ? "same" : "complement"]);
  const cautionReason = text.pick(p, CAUTION_SIGN_REASONS);
  const action = text.pick(p, ACTIONS, { time: m.timeOfDay });
  const care = careFor(rarity, s, p, text);

  return {
    v: 2,
    kind: "ZODIAC",
    dateLabel: m.date,
    generatedAt: ctx.now.toISOString(),
    sign: { ...ref(signKey), element: sign.element },
    rank: me.rank,
    ranking: day.map((d) => ({ ...ref(d.key), stars: d.stars.overall })),
    rankHeadline,
    signNote: profile.note,
    overall: { stars: s.overall, comment: overall },
    love: { stars: s.love, comment: love },
    work: { stars: s.work, comment: work },
    money: { stars: s.money, comment: money },
    health: { stars: s.health, comment: health },
    point,
    starMessage,
    goodSign: { ...ref(good), reason: goodReason },
    cautionSign: { ...ref(caution), reason: cautionReason },
    luckyColor,
    luckyItem,
    luckyTime: time,
    action,
    care,
    rarity: info,
  };
}
