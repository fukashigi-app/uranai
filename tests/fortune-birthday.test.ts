import { describe, expect, it } from "vitest";
import * as birthdayContent from "@/lib/fortune/content/birthday";
import { LUCKY_ITEMS } from "@/lib/fortune/content/common";
import { FULL_MOON_MESSAGES, MIRACLE_MESSAGES } from "@/lib/fortune/content/rarity";
import { birthdayFacts, birthdaySubject, generateBirthday } from "@/lib/fortune/birthday-fortune";
import { momentOf } from "@/lib/fortune/context";
import { standardDay } from "@/lib/fortune/day-stars";
import { fortuneInputSchema, templateEngine } from "@/lib/fortune/engine";
import { lifePathNumber, personalDayNumber } from "@/lib/fortune/numerology";
import { RARITY_KEYS, type BirthdayResultV2, type RarityKey } from "@/lib/fortune/types";
import { jstDateString } from "@/lib/time";
import { charCount } from "./helpers/fortune";

const START = Date.UTC(2026, 0, 1, 3);
const nowAt = (day: number, hour = 12) => new Date(START + day * 86_400_000 + (hour - 12) * 3_600_000);
/** テスト用の生年月日（1950年〜） */
const BIRTHS = Array.from({ length: 300 }, (_, i) => jstDateString(new Date(Date.UTC(1950, 0, 1) + i * 157 * 86_400_000)));
const BANNED = ["凶", "ハズレ", "はずれ", "宝くじ", "ギャンブル", "投資", "賭け", "必ず", "絶対", "治る", "治ります", "儲か"];

function readingTexts(r: BirthdayResultV2): string[] {
  return [
    r.sign.name,
    `誕生数${r.lifePath}`,
    r.lifePathTitle,
    `今日のナンバー${r.personalDay}`,
    r.theme.keyword,
    r.typeName,
    r.typeDescription,
    r.strengths,
    r.weakPoints,
    r.theme.text,
    r.overall.comment,
    r.love.comment,
    r.work.comment,
    r.money.comment,
    r.health.comment,
    r.events,
    r.action,
    r.caution,
    r.luckyColor.name,
    r.luckyItem,
    String(r.luckyNumber),
    r.luckyNumberNote,
    r.message,
    r.blessing ?? "",
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

describe("生年月日占い v2：入力と計算", () => {
  const ok = (birthDate: string) => fortuneInputSchema.safeParse({ type: "BIRTHDAY", birthDate }).success;

  it("未来の日付・存在しない日付・形式違いを拒否する", () => {
    expect(ok("2999-01-01")).toBe(false);
    expect(ok(jstDateString(new Date(Date.now() + 3 * 86_400_000)))).toBe(false);
    for (const bad of ["2023-02-30", "2026-13-01", "2026-04-31", "1990/05/12", "1990-5-12", "1899-12-31", ""]) expect(ok(bad), bad).toBe(false);
    expect(ok("1990-05-12")).toBe(true);
  });

  it("うるう年の2月29日", () => {
    expect(ok("2000-02-29")).toBe(true);
    expect(ok("2024-02-29")).toBe(true);
    expect(ok("2001-02-29")).toBe(false);
    expect(ok("1900-02-29")).toBe(false);
    expect(birthdayFacts("2000-02-29").sign).toBe("pisces");
  });

  it("星座の境界日", () => {
    const cases: [string, string][] = [
      ["2000-03-20", "pisces"],
      ["2000-03-21", "aries"],
      ["2000-07-22", "cancer"],
      ["2000-07-23", "leo"],
      ["2000-12-21", "sagittarius"],
      ["2000-12-22", "capricorn"],
      ["2001-01-19", "capricorn"],
      ["2001-01-20", "aquarius"],
    ];
    for (const [d, s] of cases) expect(birthdayFacts(d).sign, d).toBe(s);
  });

  it("誕生数：すべての数字を足して1桁に（既存の計算方法のまま）", () => {
    expect(lifePathNumber(1990, 5, 12)).toBe(9); // 1+9+9+0+5+1+2=27 → 9
    expect(lifePathNumber(1992, 11, 9)).toBe(5); // 32 → 5
    expect(birthdayFacts("1990-05-12").lifePath).toBe(9);
  });

  it("誕生数：マスターナンバー 11・22・33 はそのまま残す", () => {
    expect(lifePathNumber(1983, 2, 6)).toBe(11); // 29 → 11
    expect(lifePathNumber(1990, 1, 2)).toBe(22); // 22
    expect(lifePathNumber(1990, 9, 5)).toBe(33); // 33
    const r = generateBirthday("1990-09-05", { now: nowAt(0), purchaseSeed: "m" });
    expect([r.lifePath, r.isMaster, r.lifePathTitle]).toEqual([33, true, "癒やし手"]);
    expect(generateBirthday("1990-05-12", { now: nowAt(0), purchaseSeed: "m" }).isMaster).toBe(false);
  });

  it("今日の個人日数：誕生月＋誕生日＋今日の年月日の数字を足して1〜9", () => {
    // 5 + (1+2) + (2+0+2+6) + (1+0) + 7 = 26 → 8
    expect(personalDayNumber(5, 12, "2026-10-07")).toBe(8);
    for (let d = 0; d < 400; d++) {
      const n = personalDayNumber(8, 10, jstDateString(nowAt(d)));
      expect(n).toBeGreaterThanOrEqual(1);
      expect(n).toBeLessThanOrEqual(9);
    }
  });

  it("日付が変わると今日の個人日数が変わる（同じ月の中では毎日変わる）", () => {
    for (const b of BIRTHS.slice(0, 50)) {
      const f = birthdayFacts(b);
      for (let d = 1; d < 28; d++) {
        const a = personalDayNumber(f.birthMonth, f.birthDay, `2026-10-${String(d).padStart(2, "0")}`);
        const c = personalDayNumber(f.birthMonth, f.birthDay, `2026-10-${String(d + 1).padStart(2, "0")}`);
        expect(a).not.toBe(c);
      }
    }
    const today = generateBirthday("1990-05-12", { now: new Date("2026-10-07T12:00:00+09:00"), purchaseSeed: "x" });
    const next = generateBirthday("1990-05-12", { now: new Date("2026-10-08T12:00:00+09:00"), purchaseSeed: "x" });
    expect([today.personalDay, next.personalDay]).toEqual([8, 9]);
    expect(today.theme.keyword).not.toBe(next.theme.keyword);
  });

  it("エンジン経由でも生年月日占いは v2 になる", async () => {
    const r = await templateEngine.generate({ type: "BIRTHDAY", birthDate: "1990-05-12" }, { now: nowAt(1), purchaseSeed: "e" });
    expect(r.v === 2 && r.kind === "BIRTHDAY" && r.sign.name).toBe("牡牛座");
  });
});

describe("生年月日占い v2：保存してよい情報だけを持つ", () => {
  it("結果に生年月日そのものが含まれない（星座・誕生数・誕生月・今日のナンバーなどの派生情報のみ）", () => {
    for (const b of BIRTHS.slice(0, 120)) {
      const r = generateBirthday(b, { now: nowAt(3), purchaseSeed: "p" });
      const json = JSON.stringify(r);
      const [y, m, d] = b.split("-");
      for (const form of [b, `${y}${m}${d}`, `${y}/${m}/${d}`, `${Number(y)}年${Number(m)}月${Number(d)}日`, `${Number(m)}月${Number(d)}日`]) {
        expect(json.includes(form), `${form}`).toBe(false);
      }
      expect(Object.keys(r)).not.toContain("birthDate");
    }
  });
});

describe("生年月日占い v2：固定部分と購入ごとに変わる部分", () => {
  const fixed = (r: BirthdayResultV2) => [
    r.overall.stars,
    r.love.stars,
    r.work.stars,
    r.money.stars,
    r.health.stars,
    r.rarity.key,
    r.rarity.reasons.join("|"),
    r.personalDay,
    r.theme.text,
    r.events,
    r.typeName,
    r.typeDescription,
    r.strengths,
    r.weakPoints,
  ];

  it("同じ人＋同じ日なら、購入ごとの値が違っても固定部分は同じ。文章・ラッキー系は変わる", () => {
    let changed = 0;
    let total = 0;
    for (let d = 0; d < 40; d++) {
      for (const b of BIRTHS.slice(0, 60)) {
        const a = generateBirthday(b, { now: nowAt(d, 9), purchaseSeed: "purchase-A" });
        const c = generateBirthday(b, { now: nowAt(d, 21), purchaseSeed: "purchase-B" });
        expect(fixed(a)).toEqual(fixed(c));
        total++;
        if (a.message !== c.message || a.action !== c.action || a.caution !== c.caution || a.luckyItem !== c.luckyItem || a.overall.comment !== c.overall.comment || a.luckyNumber !== c.luckyNumber) changed++;
      }
    }
    expect(changed / total).toBeGreaterThan(0.95);
  });

  it("同じ購入（同じ値・同じ時刻）なら一字一句同じ", () => {
    const now = nowAt(7);
    expect(generateBirthday("1988-08-08", { now, purchaseSeed: "q" })).toEqual(generateBirthday("1988-08-08", { now, purchaseSeed: "q" }));
  });

  it("翌日になると個人日数と運勢が変わる", () => {
    let starsChanged = 0;
    for (let d = 0; d < 100; d++) {
      const a = generateBirthday("1995-08-10", { now: nowAt(d), purchaseSeed: "s" });
      const c = generateBirthday("1995-08-10", { now: nowAt(d + 1), purchaseSeed: "s" });
      if (a.dateLabel.slice(0, 7) === c.dateLabel.slice(0, 7)) expect(a.personalDay).not.toBe(c.personalDay);
      if (JSON.stringify(fixed(a).slice(0, 5)) !== JSON.stringify(fixed(c).slice(0, 5))) starsChanged++;
    }
    expect(starsChanged).toBeGreaterThan(80);
  });

  it("ラッキーナンバーは今日のナンバーとは別の 1〜99 の数字で、導き方を表示する", () => {
    for (let d = 0; d < 30; d++) {
      for (const b of BIRTHS.slice(0, 40)) {
        const r = generateBirthday(b, { now: nowAt(d), purchaseSeed: `n${d}` });
        expect(r.luckyNumber).toBeGreaterThanOrEqual(1);
        expect(r.luckyNumber).toBeLessThanOrEqual(99);
        expect(r.luckyNumber).not.toBe(r.personalDay);
        expect(r.luckyNumberNote).toMatch(/誕生数/);
      }
    }
  });
});

describe("生年月日占い v2：今日の運勢レア度", () => {
  it("MIRACLE は「総合運と4つの運勢すべて★5」のときだけ。MIRACLE には専用メッセージと祝福がある", () => {
    for (let d = 0; d < 365; d++) {
      const date = jstDateString(nowAt(d));
      for (const b of BIRTHS) {
        const { stars: s, rarity } = standardDay(date, birthdaySubject(b));
        const allFive = s.overall === 5 && s.love === 5 && s.work === 5 && s.money === 5 && s.health === 5;
        expect(rarity === "MIRACLE").toBe(allFive);
      }
    }
    const date = Array.from({ length: 3000 }, (_, d) => d).find((d) => standardDay(jstDateString(nowAt(d)), birthdaySubject(BIRTHS[0])).rarity === "MIRACLE")!;
    const r = generateBirthday(BIRTHS[0], { now: nowAt(date), purchaseSeed: "m" });
    expect(r.rarity.key).toBe("MIRACLE");
    expect(MIRACLE_MESSAGES).toContain(r.rarity.special);
    expect(r.blessing).toBeTruthy();
  });

  it("出現率が目標どおり（10年分 × 300人、MIRACLE 約2%）", () => {
    const target: Record<RarityKey, [number, number]> = {
      MIRACLE: [2.0, 0.3],
      FULL_MOON: [8.0, 1.5],
      HALF_MOON: [20.0, 1.5],
      CRESCENT: [36.0, 2.0],
      NEW_MOON: [34.0, 2.0],
    };
    const count = Object.fromEntries(RARITY_KEYS.map((k) => [k, 0])) as Record<RarityKey, number>;
    let n = 0;
    for (let d = 0; d < 3653; d++) {
      const date = jstDateString(nowAt(d));
      for (const b of BIRTHS) {
        count[standardDay(date, birthdaySubject(b)).rarity]++;
        n++;
      }
    }
    for (const k of RARITY_KEYS) {
      const rate = (100 * count[k]) / n;
      expect(Math.abs(rate - target[k][0]), `${k}: ${rate.toFixed(2)}%`).toBeLessThanOrEqual(target[k][1]);
    }
  });
});

describe("生年月日占い v2：文章の品質と整合性", () => {
  const samples = Array.from({ length: 150 }, (_, d) => d).flatMap((d) =>
    BIRTHS.filter((_, i) => (i + d) % 6 === 0).map((b, i) => {
      const now = new Date(START + d * 86_400_000 + ((d * 5 + i * 7) % 24) * 3_600_000);
      return { now, r: generateBirthday(b, { now, purchaseSeed: `p${d}-${i}` }) };
    }),
  );

  it("読む文章は 600〜900 文字", () => {
    for (const { r } of samples) {
      const n = charCount(readingTexts(r));
      expect(n, `${r.dateLabel} ${r.sign.name}${r.lifePath} ${r.rarity.key}: ${n}字`).toBeGreaterThanOrEqual(600);
      expect(n).toBeLessThanOrEqual(900);
    }
  });

  it("禁止語を使わない（文章データすべて）", () => {
    for (const s of allStrings(birthdayContent)) for (const w of BANNED) expect(s.includes(w), `「${w}」: ${s}`).toBe(false);
  });

  it("差し込み文字の閉じ忘れがない", () => {
    for (const { r } of samples) expect(JSON.stringify(r)).not.toMatch(/\{\w+\}/);
  });

  it("季節外れのラッキーアイテムは出ない", () => {
    for (const { now, r } of samples) {
      const item = LUCKY_ITEMS.find((t) => t.text === r.luckyItem)!;
      expect(!item.season || item.season.includes(momentOf(now).season), r.luckyItem).toBe(true);
    }
  });

  it("★と文章の調子が食い違わない（起こりやすいこと・おすすめの行動・一言）", () => {
    for (const { r } of samples) {
      const tone = r.overall.stars >= 4 ? "high" : r.overall.stars === 3 ? "mid" : "low";
      const find = (pool: readonly { text: string; tone?: readonly string[] }[], text: string) =>
        pool.find((x) => x.text === text || new RegExp("^" + x.text.replace(/[.*+?^$()|[\]\\]/g, "\\$&").replace(/\{\w+\}/g, ".+?") + "$").test(text));
      for (const [pool, text] of [
        [birthdayContent.EVENTS[r.personalDay], r.events],
        [birthdayContent.ACTIONS[r.personalDay], r.action],
        [birthdayContent.MESSAGES, r.message],
      ] as const) {
        const t = find(pool, text);
        expect(t, text).toBeDefined();
        expect(!t!.tone || t!.tone.includes(tone), `${text} @${tone}`).toBe(true);
      }
      expect(birthdayContent.CAUTIONS[r.personalDay]).toContain(r.caution);
      // 今日のテーマも★の調子に合わせて選ばれる（★1〜2の日に「成果が形になる」などと言わない）
      const bridgeText = r.theme.text.slice(birthdayContent.PERSONAL_DAYS[r.personalDay].meaning.length).replace(birthdayContent.SAME_NUMBER_NOTE, "");
      const bridge = find(birthdayContent.THEME_BRIDGES[r.personalDay], bridgeText);
      expect(bridge, bridgeText).toBeDefined();
      expect(!bridge!.tone || bridge!.tone.includes(tone), `${bridgeText} @${tone}`).toBe(true);
    }
  });

  it("基本タイプ・今日のテーマに、星座・誕生数・今日のナンバーが組み合わさっている", () => {
    for (const { r } of samples) {
      expect(r.typeDescription).toContain(r.sign.name);
      expect(r.typeDescription).toContain(`誕生数${r.lifePath}`);
      expect(r.typeDescription).toContain(`${r.birthMonth}月生まれ`);
      expect(birthdayContent.PERSONAL_DAYS[r.personalDay].keyword).toBe(r.theme.keyword);
      expect(r.theme.text.startsWith(birthdayContent.PERSONAL_DAYS[r.personalDay].meaning)).toBe(true);
    }
  });

  it("新月の日は整え方を3項目表示し、満月・奇跡の星夜には専用メッセージ", () => {
    for (const { r } of samples) {
      if (r.rarity.key === "NEW_MOON") expect(r.care.caution && r.care.style && r.care.reset).toBeTruthy();
      if (r.rarity.key === "FULL_MOON") expect(FULL_MOON_MESSAGES).toContain(r.rarity.special);
      if (r.rarity.key !== "MIRACLE") expect(r.blessing).toBeUndefined();
      if (r.rarity.level <= 3) expect(r.rarity.special).toBeUndefined();
    }
  });
});
