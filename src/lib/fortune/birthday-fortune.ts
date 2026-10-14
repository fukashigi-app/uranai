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
  EVENT_NOTES,
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
  SAME_NUMBER_NOTES,
  SIGNS,
  SYNTHESIS,
  THEME_BRIDGES,
  THEME_BRIDGES_COMMON,
  THEME_NOTES,
  TRAIT_KINDS,
  WORK,
} from "./content/birthday";
import { dayRng, momentOf, purchaseRng, type GenerateContext } from "./context";
import { standardDay } from "./day-stars";
import { isMasterNumber, lifePathDigit, lifePathNumber, personalDayNumber } from "./numerology";
import { rarityInfo } from "./rarity";
import type { Rng } from "./rng";
import { createComposer, fill, pickTagged, toneOf, type Composer } from "./select";
import { CATEGORY_KEYS, type BirthdayResultV2, type CareSection, type DayStars, type RarityKey } from "./types";
import { zodiacFromDate, zodiacInfo, type ZodiacKey } from "./zodiac";

/**
 * 生年月日占い（v2）。星座・誕生数・今日の個人日数・誕生月を組み合わせる、3種類の中で最も本格的な占い。
 *
 * 固定部分（日本時間の日付＋生年月日から導いた情報で決まる。再購入しても同じ）
 *   各運勢の★・レア度・基本タイプ・強み・気をつけたいところ
 *   今日のナンバーとテーマ（キーワード・意味）・今日起こりやすいこと
 * 購入ごとに変わる部分
 *   テーマがあなたにとって持つ意味の言い回し（同じ誕生数グループ・同じ調子の文から選ぶ）・テーマの補足
 *   起こりやすいことの補足・各運勢の文章・おすすめの行動・気をつけたいこと
 *   ラッキー系・あなたへの一言・整えるヒント
 *
 * 文章は createComposer で組み立て、同じ結果の中で「同じ種類の特徴」「似た文」「あなた・日です の多用」を避ける。
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

function careFor(rarity: RarityKey, stars: DayStars, rng: Rng, text: Composer): CareSection {
  const care: CareSection = {};
  const weakest = [...CATEGORY_KEYS].sort((a, b) => stars[a] - stars[b])[0];
  if (rarity === "NEW_MOON" || stars[weakest] <= 2) care.caution = text.pick(rng, CARE_CAUTION[weakest]);
  if (rarity === "NEW_MOON" || rarity === "CRESCENT") care.style = text.pick(rng, CARE_STYLE);
  if (rarity === "NEW_MOON") care.reset = text.pick(rng, CARE_RESET);
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

/** 同じ結果の中で使う回数の上限（文章の意味を壊すほど機械的には避けない） */
/** 読む文章の合計文字数の上限の目安（生年月日占いは 600〜900 字） */
const MAX_READING_LENGTH = 900;
const PHRASE_LIMITS = { あなた: 4, 日です: 1, 大丈夫: 1, 十分: 1, 一日: 2, タイミング: 1, 整え: 2 } as const;
const cap = (k: string) => k[0].toUpperCase() + k.slice(1);

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
  const traitVars = Object.fromEntries(TRAIT_KINDS.flatMap((k) => [[`lp${cap(k)}`, lp.traits[k]], [`sign${cap(k)}`, sp.traits[k]]]));
  const vars = {
    sign: sign.name,
    lp: f.lifePath,
    pd,
    keyword: day.keyword,
    month: f.birthMonth,
    monthMotif: BIRTH_MONTH_MOTIFS[f.birthMonth],
    ...traitVars,
  };
  // 購入ごとに変わる部分のうち、文章の組み立てと関係ないもの（ラッキー系・レア度・祝福）を先に決める
  const lucky = purchaseRng(m.date, subject, ctx.purchaseSeed, "lucky");
  const extra = purchaseRng(m.date, subject, ctx.purchaseSeed, "rarity");
  const ln = luckyNumberFor(f.lifePath, pd, Number(m.date.slice(8, 10)), lucky);
  const luckyColor = lucky.pick(LUCKY_COLORS);
  const luckyItem = pickTagged(lucky, LUCKY_ITEMS, { season: m.season }).text;
  const special = rarity === "MIRACLE" ? extra.pick(MIRACLE_MESSAGES) : rarity === "FULL_MOON" ? extra.pick(FULL_MOON_MESSAGES) : undefined;
  const blessing = rarity === "MIRACLE" ? fill(extra.pick(BLESSINGS), vars) : undefined;
  const info = rarityInfo(rarity, s, undefined, special);
  const typeName = `${sp.adj}${lp.title}`;
  const others = [typeName, `今日のナンバー${pd}「${day.keyword}」`, luckyColor.name, luckyItem, String(ln.n), ln.note, blessing ?? "", info.tagline, ...info.reasons, special ?? ""];
  const budget = MAX_READING_LENGTH - others.reduce((n, t) => n + [...t].length, 0);

  // 固定部分：基本タイプ・強み・気をつけたいところ・今日のテーマ・今日起こりやすいこと
  const typeDescription = `${sign.name}らしい${sp.quality}と、誕生数${f.lifePath}の${lp.quality}を持つあなた。${SYNTHESIS[sign.element][LIFE_PATH_GROUP[f.lifePath]]}${f.birthMonth}月生まれの${vars.monthMotif}も持ち合わせています。`;
  const strengths = `${lp.strength}${sp.strengthLink}`;
  const weakPoints = `${lp.caution}${sp.cautionLink}`;
  const sameNote = lifePathDigit(f.lifePath) === pd ? pickTagged(dayRng(m.date, subject, "same"), SAME_NUMBER_NOTES, { tone }).text : "";
  const events = pickTagged(dayRng(m.date, subject, "theme"), EVENTS[pd], { tone }).text;

  // 購入ごとに変わる文章。長くなりすぎたときは、短めの文を優先して組み立て直す（同じ購入なら必ず同じ結果）
  const compose = (maxLength: number) => {
    const text = createComposer(vars, { tracked: [...Object.keys(traitVars), "keyword", "monthMotif"], limits: PHRASE_LIMITS, maxLength });
    for (const t of [typeDescription, strengths, weakPoints, day.meaning]) text.add(t);
    const same = sameNote ? text.add(sameNote) : "";
    text.add(events);
    const p = purchaseRng(m.date, subject, ctx.purchaseSeed, "text");
    // 今日のテーマは、意味は同じまま「あなたにとっての意味」の言い回しが変わる
    const bridge = text.pick(p, [...THEME_BRIDGES[LIFE_PATH_GROUP[f.lifePath]][pd], ...THEME_BRIDGES_COMMON[pd]], { tone });
    const out = {
      themeText: `${day.meaning}${bridge}${same}`,
      themeNote: text.pick(p, THEME_NOTES[pd], { tone }),
      eventsNote: text.pick(p, EVENT_NOTES[pd], { tone }),
      overall: text.pick(p, OVERALL[s.overall]),
      love: text.pick(p, LOVE[s.love]),
      work: text.pick(p, WORK[s.work]),
      money: text.pick(p, MONEY[s.money]),
      health: text.pick(p, HEALTH[s.health]),
      action: text.pick(p, ACTIONS[pd], { tone }),
      caution: text.pick(p, CAUTIONS[pd]),
      message: text.pick(p, MESSAGES, { tone }),
      care: careFor(rarity, s, p, text),
    };
    return { out, length: text.texts.reduce((n, t) => n + [...t].length, 0) };
  };
  let composed = compose(budget);
  for (let shrink = 30; composed.length > budget && shrink <= 240; shrink += 30) composed = compose(budget - shrink);
  const t = composed.out;

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
    typeName,
    typeDescription,
    strengths,
    weakPoints,
    theme: { keyword: day.keyword, text: t.themeText },
    themeNote: t.themeNote,
    overall: { stars: s.overall, comment: t.overall },
    love: { stars: s.love, comment: t.love },
    work: { stars: s.work, comment: t.work },
    money: { stars: s.money, comment: t.money },
    health: { stars: s.health, comment: t.health },
    events,
    eventsNote: t.eventsNote,
    action: t.action,
    caution: t.caution,
    luckyColor,
    luckyItem,
    luckyNumber: ln.n,
    luckyNumberNote: ln.note,
    message: t.message,
    ...(blessing ? { blessing } : {}),
    care: t.care,
    rarity: info,
  };
}
