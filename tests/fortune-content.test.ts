import { describe, expect, it } from "vitest";
import * as common from "@/lib/fortune/content/common";
import * as rarityContent from "@/lib/fortune/content/rarity";
import * as zodiacContent from "@/lib/fortune/content/zodiac";
import { candidates, type Tagged } from "@/lib/fortune/select";
import { momentOf, type Season, type TimeOfDay } from "@/lib/fortune/context";
import { generateZodiac } from "@/lib/fortune/zodiac-fortune";
import { ZODIAC_KEYS } from "@/lib/fortune/zodiac";
import { charCount, zodiacReadingTexts } from "./helpers/fortune";

/** すべての文章を取り出す（入れ子の配列・オブジェクトも） */
function allStrings(v: unknown): string[] {
  if (typeof v === "string") return [v];
  if (Array.isArray(v)) return v.flatMap(allStrings);
  if (v && typeof v === "object") return Object.values(v).flatMap(allStrings);
  return [];
}
const CONTENT = [...allStrings(common), ...allStrings(rarityContent), ...allStrings(zodiacContent)];
const BANNED = ["凶", "ハズレ", "はずれ", "宝くじ", "ギャンブル", "投資", "賭け", "必ず", "絶対", "治る", "治ります"];
const SEASONS: Season[] = ["spring", "summer", "autumn", "winter"];
const TIMES: TimeOfDay[] = ["morning", "day", "night"];

describe("文章データの品質", () => {
  it("強い不快感・断定・危険な誘導につながる言葉を使わない", () => {
    for (const s of CONTENT) for (const w of BANNED) expect(s.includes(w), `「${w}」: ${s}`).toBe(false);
  });

  it("同じリストの中に重複した文章がない", () => {
    const pools: (readonly (string | Tagged)[])[] = [
      common.LUCKY_ITEMS,
      common.ACTIONS,
      common.STYLE_TIPS,
      common.RESET_ACTIONS,
      rarityContent.FULL_MOON_MESSAGES,
      rarityContent.MIRACLE_MESSAGES,
      zodiacContent.STAR_MESSAGES,
      zodiacContent.SIGN_POINTS,
      ...Object.values(zodiacContent.OVERALL),
      ...Object.values(zodiacContent.LOVE),
      ...Object.values(zodiacContent.WORK),
      ...Object.values(zodiacContent.MONEY),
      ...Object.values(zodiacContent.HEALTH),
    ];
    for (const pool of pools) {
      const texts = pool.map((t) => (typeof t === "string" ? t : t.text));
      expect(new Set(texts).size).toBe(texts.length);
    }
  });

  it("どの条件でも選べる文章が十分にある", () => {
    for (const tone of ["high", "mid", "low"] as const) {
      expect(candidates(zodiacContent.STAR_MESSAGES, { tone }).length).toBeGreaterThanOrEqual(3);
      expect(candidates(zodiacContent.SIGN_POINTS, { tone }).length).toBeGreaterThanOrEqual(3);
    }
    for (const season of SEASONS) expect(candidates(common.LUCKY_ITEMS, { season }).length).toBeGreaterThanOrEqual(25);
    for (const time of TIMES) expect(candidates(common.ACTIONS, { time }).length).toBeGreaterThanOrEqual(10);
    expect(rarityContent.FULL_MOON_MESSAGES.length).toBeGreaterThanOrEqual(8);
    expect(rarityContent.MIRACLE_MESSAGES.length).toBeGreaterThanOrEqual(8);
  });
});

describe("12星座占いの結果の整合性", () => {
  // 1年分 × 12星座 × いろいろな時刻
  const samples = Array.from({ length: 365 }, (_, i) => i).flatMap((i) =>
    ZODIAC_KEYS.map((sign, j) => {
      const now = new Date(Date.UTC(2026, 0, 1) + i * 86_400_000 + ((i * 7 + j * 5) % 24) * 3_600_000 + 17 * 60_000);
      return { now, r: generateZodiac(sign, { now, purchaseSeed: `p${i}-${j}` }) };
    }),
  );

  it("読む文章は 400〜600 文字", () => {
    for (const { r } of samples) {
      const n = charCount(zodiacReadingTexts(r));
      expect(n, `${r.dateLabel} ${r.sign.name} ${r.rarity.key}: ${n}字`).toBeGreaterThanOrEqual(400);
      expect(n).toBeLessThanOrEqual(600);
    }
  });

  it("差し込み文字の閉じ忘れがない", () => {
    for (const { r } of samples) expect(JSON.stringify(r)).not.toMatch(/\{\w+\}/);
  });

  it("ラッキータイムは結果を作った時刻より後（深夜は明日の時間帯）", () => {
    for (const { now, r } of samples) {
      const m = momentOf(now);
      if (r.luckyTime.startsWith("明日")) {
        expect(m.hour * 60 + m.minute).toBeGreaterThanOrEqual(22 * 60 + 30);
        continue;
      }
      const end = Number(/〜(\d+):00$/.exec(r.luckyTime)![1]);
      expect(end * 60 - (m.hour * 60 + m.minute)).toBeGreaterThanOrEqual(30);
    }
  });

  it("季節外れのラッキーアイテム・時間帯に合わない開運アクションは出ない", () => {
    for (const { now, r } of samples) {
      const m = momentOf(now);
      const item = common.LUCKY_ITEMS.find((t) => t.text === r.luckyItem)!;
      expect(!item.season || item.season.includes(m.season), `${r.luckyItem} @${m.season}`).toBe(true);
      const action = common.ACTIONS.find((t) => t.text === r.action)!;
      expect(!action.time || action.time.includes(m.timeOfDay), `${r.action} @${m.timeOfDay}`).toBe(true);
    }
  });

  it("★と文章の調子が食い違わない（好調な日に控えめ向けの一言を出さない、逆も）", () => {
    for (const { r } of samples) {
      const msg = zodiacContent.STAR_MESSAGES.find((t) => fillCheck(t.text, r.starMessage))!;
      expect(msg, r.starMessage).toBeDefined();
      const tone = r.overall.stars >= 4 ? "high" : r.overall.stars === 3 ? "mid" : "low";
      expect(msg.tone?.includes(tone) ?? true).toBe(true);
    }
  });

  it("新月の日ほど「整えるヒント」が充実し、満月・奇跡の星夜には専用メッセージ", () => {
    for (const { r } of samples) {
      if (r.rarity.key === "NEW_MOON") {
        expect(r.care.caution && r.care.style && r.care.reset).toBeTruthy();
      }
      if (r.rarity.key === "FULL_MOON") expect(rarityContent.FULL_MOON_MESSAGES).toContain(r.rarity.special);
      if (r.rarity.key === "MIRACLE") expect(rarityContent.MIRACLE_MESSAGES).toContain(r.rarity.special);
      if (r.rarity.level <= 3) expect(r.rarity.special).toBeUndefined();
    }
  });
});

/** 差し込み前の文章と差し込み後の文章が対応するか */
function fillCheck(template: string, filled: string): boolean {
  const pattern = new RegExp("^" + template.replace(/[.*+?^$()|[\]\\]/g, "\\$&").replace(/\{\w+\}/g, ".+?") + "$");
  return pattern.test(filled);
}
