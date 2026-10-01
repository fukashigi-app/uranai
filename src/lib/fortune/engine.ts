import { z } from "zod";
import type { FortuneResultData, FortuneTypeValue } from "@/lib/db/schema";
import { jstDateString } from "@/lib/time";
import { createRng, hashString, type Rng } from "./rng";
import {
  ADVICE,
  BLOOD_TRAITS,
  ELEMENT_LABEL,
  HEALTH,
  LIFE_PATH_TRAITS,
  LOVE,
  LUCKY_COLORS,
  LUCKY_ITEMS,
  LUCKY_TIMES,
  MESSAGES,
  MONEY,
  OVERALL,
  WORK,
  ZODIAC_TRAITS,
} from "./templates";
import {
  BLOOD_TYPES,
  isValidBirthDate,
  lifePathNumber,
  ZODIAC_KEYS,
  ZODIAC_SIGNS,
  zodiacFromDate,
  zodiacInfo,
  type ZodiacKey,
} from "./zodiac";

export type FortuneInput =
  | { type: "BIRTHDAY"; birthDate: string }
  | { type: "ZODIAC"; sign: ZodiacKey }
  | { type: "BLOOD"; bloodType: (typeof BLOOD_TYPES)[number] };

export const fortuneInputSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("BIRTHDAY"),
    birthDate: z.string().refine((v) => isValidBirthDate(v), "生年月日を正しく入力してください（未来の日付や存在しない日付は選べません）"),
  }),
  z.object({ type: z.literal("ZODIAC"), sign: z.enum(ZODIAC_KEYS) }),
  z.object({ type: z.literal("BLOOD"), bloodType: z.enum(BLOOD_TYPES) }),
]);

/** 将来 AI 占い等を追加する場合は、このインターフェースを実装する */
export interface FortuneEngine {
  readonly id: string;
  generate(input: FortuneInput, now: Date): Promise<FortuneResultData>;
}

type Stars = 1 | 2 | 3 | 4 | 5;
const OVERALL_WEIGHTS = [5, 15, 35, 30, 15] as const; // ★1〜★5
const OFFSET_WEIGHTS = [5, 25, 35, 25, 10] as const; // -2〜+2

function clampStars(n: number): Stars {
  return Math.min(5, Math.max(1, n)) as Stars;
}

function seedFor(engineId: string, date: string, key: string, salt: string): Rng {
  return createRng(hashString(`${engineId}|${date}|${key}|${salt}`));
}

/** 入力から「同一人物・同一条件」を表すキーを作る（保存はしない） */
function subjectKey(input: FortuneInput): string {
  switch (input.type) {
    case "BIRTHDAY":
      return `B:${input.birthDate}`;
    case "ZODIAC":
      return `Z:${input.sign}`;
    case "BLOOD":
      return `T:${input.bloodType}`;
  }
}

function overallStars(engineId: string, date: string, key: string): { stars: Stars; score: number } {
  const rng = seedFor(engineId, date, key, "overall");
  const stars = (rng.weighted(OVERALL_WEIGHTS) + 1) as Stars;
  return { stars, score: stars + rng.next() };
}

function categoryStars(rng: Rng, base: Stars): Stars {
  return clampStars(base + rng.weighted(OFFSET_WEIGHTS) - 2);
}

export const templateEngine: FortuneEngine = {
  id: "template-v1",
  async generate(input, now) {
    const date = jstDateString(now);
    const key = subjectKey(input);
    const { stars: overall } = overallStars(this.id, date, key);
    const rng = seedFor(this.id, date, key, "detail");

    const love = categoryStars(rng, overall);
    const work = categoryStars(rng, overall);
    const money = categoryStars(rng, overall);
    // 健康運は別系列の乱数で（既存カテゴリの結果を変えないため）
    const healthRng = seedFor(this.id, date, key, "health");
    const health = categoryStars(healthRng, overall);

    let subject = "";
    let traits = "";
    let highlight: string | undefined;

    if (input.type === "BIRTHDAY") {
      const [y, m, d] = input.birthDate.split("-").map(Number);
      const sign = zodiacInfo(zodiacFromDate(m, d));
      const lp = lifePathNumber(y, m, d);
      subject = `${sign.name} × 誕生数${lp}`;
      traits = LIFE_PATH_TRAITS[lp] ?? "";
      highlight = `${ELEMENT_LABEL[sign.element]}・${sign.name}`;
    } else if (input.type === "ZODIAC") {
      const sign = zodiacInfo(input.sign);
      subject = `${sign.symbol}\uFE0E ${sign.name}`;
      traits = ZODIAC_TRAITS[input.sign];
      // 12星座の今日のランキング（全星座を同じ seed で計算して順位付け）
      const ranking = ZODIAC_SIGNS.map((s) => ({ key: s.key, score: overallStars(this.id, date, `Z:${s.key}`).score })).sort(
        (a, b) => b.score - a.score,
      );
      highlight = `今日の12星座ランキング ${ranking.findIndex((r) => r.key === input.sign) + 1}位`;
    } else {
      subject = `${input.bloodType}型のあなた`;
      traits = BLOOD_TRAITS[input.bloodType];
    }

    return {
      title: "今日の運勢",
      subject,
      dateLabel: date,
      overall: { stars: overall, comment: rng.pick(OVERALL[overall]) },
      love: { stars: love, comment: rng.pick(LOVE[love]) },
      work: { stars: work, comment: rng.pick(WORK[work]) },
      money: { stars: money, comment: rng.pick(MONEY[money]) },
      health: { stars: health, comment: healthRng.pick(HEALTH[health]) },
      luckyColor: rng.pick(LUCKY_COLORS),
      luckyItem: rng.pick(LUCKY_ITEMS),
      luckyNumber: rng.int(1, 9),
      luckyTime: rng.pick(LUCKY_TIMES),
      message: rng.pick(MESSAGES),
      advice: rng.pick(ADVICE),
      traits,
      highlight,
    };
  },
};

const engines: Record<string, FortuneEngine> = { [templateEngine.id]: templateEngine };

export function getFortuneEngine(id = process.env.FORTUNE_ENGINE ?? templateEngine.id): FortuneEngine {
  return engines[id] ?? templateEngine;
}

export const FORTUNE_TYPES: readonly FortuneTypeValue[] = ["BIRTHDAY", "ZODIAC", "BLOOD"];
