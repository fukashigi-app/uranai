import type { ZodiacResultV2 } from "@/lib/fortune/types";

/** 1回の結果でユーザーが実際に読む文章（ランキングの星座名一覧や見出しラベルは含めない） */
export function zodiacReadingTexts(r: ZodiacResultV2): string[] {
  return [
    r.rankHeadline,
    r.signNote,
    r.overall.comment,
    r.point,
    r.love.comment,
    r.work.comment,
    r.money.comment,
    r.health.comment,
    r.starMessage,
    r.goodSign.reason,
    r.cautionSign.reason,
    r.luckyColor.name,
    r.luckyItem,
    r.luckyTime,
    r.action,
    r.care.caution ?? "",
    r.care.style ?? "",
    r.care.reset ?? "",
    r.rarity.tagline,
    ...r.rarity.reasons,
    r.rarity.special ?? "",
  ];
}

export const charCount = (texts: string[]) => texts.reduce((n, t) => n + [...t].length, 0);
