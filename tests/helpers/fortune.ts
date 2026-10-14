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

import type { BirthdayResultV2, BloodResultV2 } from "@/lib/fortune/types";

/** 血液型占いで読む文章 */
export function bloodReading(r: BloodResultV2): string[] {
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

/** 生年月日占いで読む文章（固定部分 → 購入ごとに変わる部分の順） */
export function birthdayReading(r: BirthdayResultV2): string[] {
  return [
    r.typeName,
    r.typeDescription,
    r.strengths,
    r.weakPoints,
    `今日のナンバー${r.personalDay}「${r.theme.keyword}」`,
    r.theme.text,
    r.themeNote ?? "",
    r.overall.comment,
    r.love.comment,
    r.work.comment,
    r.money.comment,
    r.health.comment,
    r.events,
    r.eventsNote ?? "",
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

/** 同じ項目どうしを比べ、変わった文章の文字数の割合（0〜1） */
export function changedShare(a: string[], b: string[]): number {
  let total = 0;
  let changed = 0;
  a.forEach((t, i) => {
    const n = [...t].length;
    total += n;
    if (t !== b[i]) changed += n;
  });
  return total ? changed / total : 0;
}
