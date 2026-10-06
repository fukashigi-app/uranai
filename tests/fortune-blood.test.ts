import { describe, expect, it } from "vitest";
import * as bloodContent from "@/lib/fortune/content/blood";
import { LUCKY_ITEMS } from "@/lib/fortune/content/common";
import { FULL_MOON_MESSAGES, MIRACLE_MESSAGES } from "@/lib/fortune/content/rarity";
import { bloodSubject, generateBlood } from "@/lib/fortune/blood-fortune";
import { momentOf } from "@/lib/fortune/context";
import { standardDay } from "@/lib/fortune/day-stars";
import { fortuneInputSchema, templateEngine } from "@/lib/fortune/engine";
import { RARITY_KEYS, type BloodResultV2, type BloodTypeValue, type RarityKey } from "@/lib/fortune/types";
import { jstDateString } from "@/lib/time";
import { charCount } from "./helpers/fortune";

const BLOODS: BloodTypeValue[] = ["A", "B", "O", "AB"];
const MONTHS = Array.from({ length: 12 }, (_, i) => i + 1);
const ALL48 = BLOODS.flatMap((b) => MONTHS.map((m) => [b, m] as const));
const START = Date.UTC(2026, 0, 1, 3);
const nowAt = (day: number, hour = 12) => new Date(START + day * 86_400_000 + (hour - 12) * 3_600_000);
const BANNED = ["凶", "ハズレ", "はずれ", "宝くじ", "ギャンブル", "投資", "賭け", "必ず", "絶対", "治る", "治ります", "医学", "科学的"];

/** ユーザーが実際に読む文章 */
function readingTexts(r: BloodResultV2): string[] {
  return [
    r.typeName,
    r.typeCatch,
    r.typeFeature,
    r.typeToday,
    r.overall.comment,
    r.love.comment,
    r.work.comment,
    r.money.comment,
    r.health.comment,
    r.goodAction,
    r.caution,
    r.goodBlood.reason,
    r.luckyColor.name,
    r.luckyItem,
    String(r.luckyNumber),
    r.message,
    r.care.caution ?? "",
    r.care.style ?? "",
    r.care.reset ?? "",
    r.rarity.tagline,
    ...r.rarity.reasons,
    r.rarity.special ?? "",
  ];
}

function allStrings(v: unknown): string[] {
  if (typeof v === "string") return [v];
  if (Array.isArray(v)) return v.flatMap(allStrings);
  if (v && typeof v === "object") return Object.values(v).flatMap(allStrings);
  return [];
}

describe("血液型占い v2：48タイプ", () => {
  it("48タイプすべて生成でき、タイプ名は重複しない", () => {
    const names = new Set<string>();
    for (const [b, m] of ALL48) {
      const r = generateBlood(b, m, { now: nowAt(0), purchaseSeed: "x" });
      expect(r.v).toBe(2);
      expect(r.kind).toBe("BLOOD");
      expect([r.bloodType, r.birthMonth]).toEqual([b, m]);
      expect(r.typeName && r.typeCatch && r.typeFeature).toBeTruthy();
      names.add(r.typeName);
    }
    expect(names.size).toBe(48);
  });

  it("タイプの特徴は血液型と誕生月の両方を組み合わせた文章", () => {
    for (const [b, m] of ALL48) {
      const t = bloodContent.TYPES_48[b][m];
      expect(t.feature).toContain(`${b}型`);
      expect(t.feature).toContain(`${m}月生まれ`);
    }
  });

  it("入力：血液型と1〜12月だけを受け付ける", () => {
    const ok = (birthMonth: unknown) => fortuneInputSchema.safeParse({ type: "BLOOD", bloodType: "A", birthMonth }).success;
    expect(ok(1)).toBe(true);
    expect(ok(12)).toBe(true);
    for (const bad of [0, 13, -1, 1.5, "8", null, undefined, Number.NaN]) expect(ok(bad), String(bad)).toBe(false);
    expect(fortuneInputSchema.safeParse({ type: "BLOOD", bloodType: "C", birthMonth: 8 }).success).toBe(false);
    expect(fortuneInputSchema.safeParse({ type: "BLOOD", bloodType: "A" }).success).toBe(false);
  });

  it("エンジン経由でも血液型占いは v2（48タイプ）になる", async () => {
    const r = await templateEngine.generate({ type: "BLOOD", bloodType: "O", birthMonth: 8 }, { now: nowAt(3), purchaseSeed: "y" });
    expect(r.v === 2 && r.kind === "BLOOD" && r.typeName).toBe("真夏の太陽リーダー");
  });
});

describe("血液型占い v2：固定部分と購入ごとに変わる部分", () => {
  const fixed = (r: BloodResultV2) => [r.overall.stars, r.love.stars, r.work.stars, r.money.stars, r.health.stars, r.rarity.key, r.goodBlood.type, r.rarity.reasons.join("|")];

  it("同じ日＋同じ血液型＋同じ月なら、購入ごとの値が違っても★・レア度・相性は同じ。文章の一部は変わる", () => {
    let changed = 0;
    let total = 0;
    for (let d = 0; d < 60; d++) {
      for (const [b, m] of ALL48) {
        const a = generateBlood(b, m, { now: nowAt(d, 10), purchaseSeed: "purchase-A" });
        const c = generateBlood(b, m, { now: nowAt(d, 21), purchaseSeed: "purchase-B" });
        expect(fixed(a)).toEqual(fixed(c));
        expect(a.typeName).toBe(c.typeName);
        total++;
        if (a.message !== c.message || a.goodAction !== c.goodAction || a.luckyItem !== c.luckyItem || a.overall.comment !== c.overall.comment || a.typeToday !== c.typeToday) changed++;
      }
    }
    expect(changed / total).toBeGreaterThan(0.95);
  });

  it("同じ購入（同じ値・同じ時刻）なら一字一句同じ", () => {
    const now = nowAt(5);
    expect(generateBlood("A", 8, { now, purchaseSeed: "z" })).toEqual(generateBlood("A", 8, { now, purchaseSeed: "z" }));
  });

  it("誕生月が違えば固定部分が変わる（A型×7月 と A型×8月）", () => {
    let differ = 0;
    for (let d = 0; d < 365; d++) {
      const a7 = generateBlood("A", 7, { now: nowAt(d), purchaseSeed: "s" });
      const a8 = generateBlood("A", 8, { now: nowAt(d), purchaseSeed: "s" });
      if (JSON.stringify(fixed(a7)) !== JSON.stringify(fixed(a8))) differ++;
    }
    expect(differ / 365).toBeGreaterThan(0.85);
  });

  it("同じタイプでも、相性のいい血液型は日によって変わる", () => {
    for (const [b, m] of ALL48) {
      const types = new Set(Array.from({ length: 60 }, (_, d) => generateBlood(b, m, { now: nowAt(d), purchaseSeed: "s" }).goodBlood.type));
      expect(types.size, `${b}型${m}月`).toBeGreaterThanOrEqual(2);
    }
  });
});

describe("血液型占い v2：今日の運勢レア度", () => {
  it("MIRACLE は「総合運★5」かつ「4つの運勢すべて★5」のときだけ", () => {
    for (let d = 0; d < 730; d++) {
      const date = jstDateString(nowAt(d));
      for (const [b, m] of ALL48) {
        const { stars: s, rarity } = standardDay(date, bloodSubject(b, m));
        const allFive = s.overall === 5 && s.love === 5 && s.work === 5 && s.money === 5 && s.health === 5;
        expect(rarity === "MIRACLE").toBe(allFive);
      }
    }
  });

  it("20年分 × 48タイプの出現率が目標どおり（MIRACLE 約2%）", () => {
    const target: Record<RarityKey, [number, number]> = {
      MIRACLE: [2.0, 0.3],
      FULL_MOON: [8.0, 1.5],
      HALF_MOON: [20.0, 1.5],
      CRESCENT: [36.0, 2.0],
      NEW_MOON: [34.0, 2.0],
    };
    const count = Object.fromEntries(RARITY_KEYS.map((k) => [k, 0])) as Record<RarityKey, number>;
    let n = 0;
    for (let d = 0; d < 7305; d++) {
      const date = jstDateString(nowAt(d));
      for (const [b, m] of ALL48) {
        count[standardDay(date, bloodSubject(b, m)).rarity]++;
        n++;
      }
    }
    for (const k of RARITY_KEYS) {
      const rate = (100 * count[k]) / n;
      expect(Math.abs(rate - target[k][0]), `${k}: ${rate.toFixed(2)}%`).toBeLessThanOrEqual(target[k][1]);
    }
  });
});

describe("血液型占い v2：文章の品質と整合性", () => {
  const samples = Array.from({ length: 200 }, (_, d) => d).flatMap((d) =>
    ALL48.filter((_, i) => (i + d) % 4 === 0).map(([b, m], i) => {
      const now = new Date(START + d * 86_400_000 + ((d * 5 + i * 7) % 24) * 3_600_000);
      return { now, r: generateBlood(b, m, { now, purchaseSeed: `p${d}-${i}` }) };
    }),
  );

  it("読む文章は 400〜600 文字", () => {
    for (const { r } of samples) {
      const n = charCount(readingTexts(r));
      expect(n, `${r.dateLabel} ${r.bloodType}${r.birthMonth} ${r.rarity.key}: ${n}字`).toBeGreaterThanOrEqual(400);
      expect(n).toBeLessThanOrEqual(600);
    }
  });

  it("禁止語を使わない（文章データすべて）", () => {
    for (const s of allStrings(bloodContent)) for (const w of BANNED) expect(s.includes(w), `「${w}」: ${s}`).toBe(false);
  });

  it("差し込み文字の閉じ忘れがない", () => {
    for (const { r } of samples) expect(JSON.stringify(r)).not.toMatch(/\{\w+\}/);
  });

  it("季節外れのラッキーアイテムは出ない", () => {
    for (const { now, r } of samples) {
      const item = LUCKY_ITEMS.find((t) => t.text === r.luckyItem)!;
      expect(!item.season || item.season.includes(momentOf(now).season), `${r.luckyItem}`).toBe(true);
    }
  });

  it("★と文章の調子が食い違わない（うまくいく行動・気をつけたいこと・一言）", () => {
    for (const { r } of samples) {
      const tone = r.overall.stars >= 4 ? "high" : r.overall.stars === 3 ? "mid" : "low";
      const ok = (pool: readonly { text: string; tone?: readonly string[] }[], text: string) => {
        const t = pool.find((x) => x.text === text || new RegExp("^" + x.text.replace(/[.*+?^$()|[\]\\]/g, "\\$&").replace(/\{\w+\}/g, ".+?") + "$").test(text));
        return Boolean(t) && (!t!.tone || t!.tone.includes(tone));
      };
      expect(ok(bloodContent.GOOD_ACTIONS[r.bloodType], r.goodAction), r.goodAction).toBe(true);
      expect(ok(bloodContent.CAUTIONS[r.bloodType], r.caution), r.caution).toBe(true);
      expect(ok(bloodContent.MESSAGES, r.message), r.message).toBe(true);
      expect(ok(bloodContent.TYPE_TODAY, r.typeToday), r.typeToday).toBe(true);
    }
  });

  it("同じ結果の中で同じ文章が重複しない", () => {
    for (const { r } of samples) {
      const texts = readingTexts(r).filter((t) => [...t].length > 12);
      expect(new Set(texts).size).toBe(texts.length);
    }
  });

  it("新月の日ほど整えるヒントが充実し、満月・奇跡の星夜には専用メッセージ", () => {
    for (const { r } of samples) {
      if (r.rarity.key === "NEW_MOON") expect(r.care.caution && r.care.style && r.care.reset).toBeTruthy();
      if (r.rarity.key === "FULL_MOON") expect(FULL_MOON_MESSAGES).toContain(r.rarity.special);
      if (r.rarity.key === "MIRACLE") expect(MIRACLE_MESSAGES).toContain(r.rarity.special);
      if (r.rarity.level <= 3) expect(r.rarity.special).toBeUndefined();
      expect(r.rarity.reasons.length).toBeGreaterThanOrEqual(2);
      expect(r.luckyNumber).toBeGreaterThanOrEqual(1);
      expect(r.luckyNumber).toBeLessThanOrEqual(9);
    }
  });
});
