import { LUCKY_COLORS, LUCKY_ITEMS } from "./content/common";
import { FULL_MOON_MESSAGES, MIRACLE_MESSAGES } from "./content/rarity";
import {
  ACTIONS,
  BIRTH_MONTH_MOTIFS,
  BLESSINGS,
  CARE_CAUTION,
  CARE_RESET,
  CARE_STYLE,
  CAUTIONS,
  EVENTS,
  HEALTH,
  LIFE_PATH_GROUP,
  LIFE_PATHS,
  LOVE,
  LUCKY_NUMBER_NOTES,
  MESSAGES,
  MONEY,
  OVERALL,
  PERSONAL_DAYS,
  SAME_NUMBER_NOTE,
  SIGNS,
  SYNTHESIS,
  THEME_BRIDGES,
  WORK,
} from "./content/birthday";
import { dayRng, momentOf, purchaseRng, type GenerateContext } from "./context";
import { standardDay } from "./day-stars";
import { isMasterNumber, lifePathDigit, lifePathNumber, personalDayNumber } from "./numerology";
import { rarityInfo } from "./rarity";
import type { Rng } from "./rng";
import { fill, pickTagged, toneOf } from "./select";
import { CATEGORY_KEYS, type BirthdayResultV2, type CareSection, type DayStars, type RarityKey } from "./types";
import { zodiacFromDate, zodiacInfo, type ZodiacKey } from "./zodiac";

/**
 * 生年月日占い（v2）。星座・誕生数・今日の個人日数・誕生月を組み合わせる、3種類の中で最も本格的な占い。
 *
 * 固定部分（日本時間の日付＋生年月日から導いた情報で決まる。再購入しても同じ）
 *   各運勢の★・レア度・今日の個人日数・今日のテーマ・今日起こりやすいこと
 * 購入ごとに変わる部分
 *   各運勢の文章・おすすめの行動・気をつけたいこと・ラッキー系・あなたへの一言・整えるヒント
 *
 * 生年月日そのものは結果に含めない（乱数の種として内部で使うだけで、保存もログ出力もしない）。
 */

export type BirthdayFacts = { sign: ZodiacKey; lifePath: number; birthMonth: number; birthDay: number };

export function birthdayFacts(birthDate: string): BirthdayFacts {
  const [y, m, d] = birthDate.split("-").map(Number);
  return { sign: zodiacFromDate(m, d), lifePath: lifePathNumber(y, m, d), birthMonth: m, birthDay: d };
}

/** 固定部分の乱数の種（生年月日ごとに異なる。ハッシュの材料にするだけで保存しない） */
export const birthdaySubject = (birthDate: string) => `D:${birthDate}`;

function careFor(rarity: RarityKey, stars: DayStars, rng: Rng): CareSection {
  const care: CareSection = {};
  const weakest = [...CATEGORY_KEYS].sort((a, b) => stars[a] - stars[b])[0];
  if (rarity === "NEW_MOON" || stars[weakest] <= 2) care.caution = rng.pick(CARE_CAUTION[weakest]);
  if (rarity === "NEW_MOON" || rarity === "CRESCENT") care.style = rng.pick(CARE_STYLE);
  if (rarity === "NEW_MOON") care.reset = rng.pick(CARE_RESET);
  return care;
}

function luckyNumberFor(lp: number, pd: number, dom: number, rng: Rng): { n: number; note: string } {
  const lp1 = lifePathDigit(lp);
  const vars = { lp, pd, dom };
  const candidates = [
    { n: lp1 * 10 + pd, note: fill(LUCKY_NUMBER_NOTES.lpPd, vars) },
    { n: pd * 10 + lp1, note: fill(LUCKY_NUMBER_NOTES.pdLp, vars) },
    { n: dom + lp, note: fill(LUCKY_NUMBER_NOTES.dateLp, vars) },
  ].filter((c) => c.n >= 1 && c.n <= 99 && c.n !== pd);
  return rng.pick(candidates);
}

export function generateBirthday(birthDate: string, ctx: GenerateContext): BirthdayResultV2 {
  const m = momentOf(ctx.now);
  const f = birthdayFacts(birthDate);
  const subject = birthdaySubject(birthDate);
  const { stars: s, rarity } = standardDay(m.date, subject);
  const sign = zodiacInfo(f.sign);
  const sp = SIGNS[f.sign];
  const lp = LIFE_PATHS[f.lifePath];
  const pd = personalDayNumber(f.birthMonth, f.birthDay, m.date);
  const day = PERSONAL_DAYS[pd];
  const tone = toneOf(s.overall);
  const vars = {
    sign: sign.name,
    signQuality: sp.quality,
    lp: f.lifePath,
    lpQuality: lp.quality,
    pd,
    keyword: day.keyword,
    month: f.birthMonth,
    monthMotif: BIRTH_MONTH_MOTIFS[f.birthMonth],
  };

  // 固定部分：今日のテーマと今日起こりやすいこと
  const fixed = dayRng(m.date, subject, "theme");
  const bridge = fill(pickTagged(fixed, THEME_BRIDGES[pd], { tone }).text, vars);
  const themeText = `${day.meaning}${bridge}${lifePathDigit(f.lifePath) === pd ? SAME_NUMBER_NOTE : ""}`;
  const events = pickTagged(fixed, EVENTS[pd], { tone }).text;

  // 購入ごとに変わる部分
  const p = purchaseRng(m.date, subject, ctx.purchaseSeed, "text");
  const lucky = purchaseRng(m.date, subject, ctx.purchaseSeed, "lucky");
  const ln = luckyNumberFor(f.lifePath, pd, Number(m.date.slice(8, 10)), lucky);
  const special = rarity === "MIRACLE" ? p.pick(MIRACLE_MESSAGES) : rarity === "FULL_MOON" ? p.pick(FULL_MOON_MESSAGES) : undefined;

  return {
    v: 2,
    kind: "BIRTHDAY",
    dateLabel: m.date,
    generatedAt: ctx.now.toISOString(),
    sign: { key: sign.key, name: sign.name, symbol: sign.symbol, element: sign.element },
    lifePath: f.lifePath,
    lifePathTitle: lp.title,
    isMaster: isMasterNumber(f.lifePath),
    birthMonth: f.birthMonth,
    personalDay: pd,
    typeName: `${sp.adj}${lp.title}`,
    typeDescription: `${sign.name}らしい${sp.quality}と、誕生数${f.lifePath}の${lp.quality}を持つあなた。${SYNTHESIS[sign.element][LIFE_PATH_GROUP[f.lifePath]]}${f.birthMonth}月生まれの${vars.monthMotif}も、その魅力をそっと支えています。`,
    strengths: `${lp.strength}${sp.strengthLink}`,
    weakPoints: `${lp.caution}${sp.cautionLink}`,
    theme: { keyword: day.keyword, text: themeText },
    overall: { stars: s.overall, comment: fill(p.pick(OVERALL[s.overall]), vars) },
    love: { stars: s.love, comment: p.pick(LOVE[s.love]) },
    work: { stars: s.work, comment: p.pick(WORK[s.work]) },
    money: { stars: s.money, comment: p.pick(MONEY[s.money]) },
    health: { stars: s.health, comment: p.pick(HEALTH[s.health]) },
    events,
    action: pickTagged(p, ACTIONS[pd], { tone }).text,
    caution: p.pick(CAUTIONS[pd]),
    luckyColor: lucky.pick(LUCKY_COLORS),
    luckyItem: pickTagged(lucky, LUCKY_ITEMS, { season: m.season }).text,
    luckyNumber: ln.n,
    luckyNumberNote: ln.note,
    message: fill(pickTagged(p, MESSAGES, { tone }).text, vars),
    ...(rarity === "MIRACLE" ? { blessing: fill(p.pick(BLESSINGS), vars) } : {}),
    care: careFor(rarity, s, p),
    rarity: rarityInfo(rarity, s, undefined, special),
  };
}
