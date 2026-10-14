import { similarity, splitSentences } from "@/lib/fortune/similarity";
import type { BirthdayResultV2, BloodResultV2, ZodiacResultV2 } from "@/lib/fortune/types";

/**
 * 占い本文の「書き分け」を確かめるための道具。
 * 結果の本文を文（。！で区切る）に分け、記号を除いて比べる。色名・アイテム名・レア度の共通文言は比べない。
 */

export { similarity };

/** 文章を文に分け、記号を除く（短すぎる断片は比べない） */
export function sentences(texts: string[]): string[] {
  return texts.flatMap(splitSentences);
}

/** この値以上を「ほぼ同じ文」とみなす（例: 「お金の貸し借りは避けたほうが無難な日です」と「〜無難です」は 0.89） */
export const NEAR_DUPLICATE = 0.7;

export type Pair = { a: string; b: string; score: number };

export function crossPairs(left: Set<string>, right: Set<string>, threshold = NEAR_DUPLICATE): Pair[] {
  const out: Pair[] = [];
  const r = [...right];
  for (const a of left) {
    for (const b of r) {
      // 長さが大きく違う文は似ていない（計算を省く）
      const la = [...a].length;
      const lb = [...b].length;
      if (Math.min(la, lb) / Math.max(la, lb) < threshold * 0.6) continue;
      const score = similarity(a, b);
      if (score >= threshold) out.push({ a, b, score });
    }
  }
  return out;
}

/** 本文（比べる対象）：ラッキーカラー・アイテム・時間、レア度の名前と理由・共通メッセージは除く */
export function zodiacBody(r: ZodiacResultV2): string[] {
  return [r.rankHeadline, r.signNote, r.overall.comment, r.point, r.love.comment, r.work.comment, r.money.comment, r.health.comment, r.starMessage, r.goodSign.reason, r.cautionSign.reason, r.action, r.care.caution ?? "", r.care.style ?? "", r.care.reset ?? ""];
}

export function bloodBody(r: BloodResultV2): string[] {
  return [r.typeCatch, r.typeFeature, r.typeToday, r.overall.comment, r.love.comment, r.work.comment, r.money.comment, r.health.comment, r.goodAction, r.caution, r.goodBlood.reason, r.message, r.care.caution ?? "", r.care.style ?? "", r.care.reset ?? ""];
}

export function birthdayBody(r: BirthdayResultV2): string[] {
  return [
    r.typeDescription,
    r.strengths,
    r.weakPoints,
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
    r.message,
    r.blessing ?? "",
    r.care.caution ?? "",
    r.care.style ?? "",
    r.care.reset ?? "",
  ];
}
