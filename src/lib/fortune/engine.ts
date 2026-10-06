import { z } from "zod";
import type { FortuneResultData, FortuneTypeValue } from "@/lib/db/schema";
import type { GenerateContext } from "./context";
import { legacyGenerate } from "./legacy";
import { generateBlood } from "./blood-fortune";
import { generateZodiac } from "./zodiac-fortune";
import { BLOOD_TYPES, isValidBirthDate, ZODIAC_KEYS, type ZodiacKey } from "./zodiac";

export type { GenerateContext } from "./context";

export type FortuneInput =
  | { type: "BIRTHDAY"; birthDate: string }
  | { type: "ZODIAC"; sign: ZodiacKey }
  | { type: "BLOOD"; bloodType: (typeof BLOOD_TYPES)[number]; birthMonth: number };

export const fortuneInputSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("BIRTHDAY"),
    birthDate: z.string().refine((v) => isValidBirthDate(v), "生年月日を正しく入力してください（未来の日付や存在しない日付は選べません）"),
  }),
  z.object({ type: z.literal("ZODIAC"), sign: z.enum(ZODIAC_KEYS) }),
  z.object({
    type: z.literal("BLOOD"),
    bloodType: z.enum(BLOOD_TYPES),
    // 血液型占いは誕生月（1〜12）だけを使う。誕生日の日付は聞かない
    birthMonth: z.number({ error: "生まれた月を選んでください" }).int("生まれた月を選んでください").min(1, "生まれた月を選んでください").max(12, "生まれた月を選んでください"),
  }),
]);

/** 将来 AI 占い等を追加する場合は、このインターフェースを実装する */
export interface FortuneEngine {
  readonly id: string;
  /**
   * ctx.now … 結果を作る時刻（日付・季節・ラッキータイムに使う）
   * ctx.purchaseSeed … 購入ごとの値。文章・ラッキー系など「購入ごとに変わる部分」だけに使う
   */
  generate(input: FortuneInput, ctx: GenerateContext): Promise<FortuneResultData>;
}

/**
 * template-v2: 12星座占い・血液型占い（48タイプ）は新方式（レア度付き）。
 * 生年月日占いは新方式に移行するまで旧方式の結果を返す。
 */
export const templateEngine: FortuneEngine = {
  id: "template-v2",
  async generate(input, ctx) {
    if (input.type === "ZODIAC") return generateZodiac(input.sign, ctx);
    if (input.type === "BLOOD") return generateBlood(input.bloodType, input.birthMonth, ctx);
    return legacyGenerate(input, ctx.now);
  },
};

const engines: Record<string, FortuneEngine> = { [templateEngine.id]: templateEngine };

export function getFortuneEngine(id = process.env.FORTUNE_ENGINE ?? templateEngine.id): FortuneEngine {
  return engines[id] ?? templateEngine;
}

export const FORTUNE_TYPES: readonly FortuneTypeValue[] = ["BIRTHDAY", "ZODIAC", "BLOOD"];
