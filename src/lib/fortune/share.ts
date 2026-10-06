import type { FortuneResultData } from "@/lib/db/schema";

const stars = (n: number) => "★".repeat(n) + "☆".repeat(5 - n);

/**
 * 共有用の短い文章。個人情報（生年月日など）は含めない。
 * 将来 SNS 用の画像を作る場合も、この関数が返す要素（占いの種類・レア度・順位・総合運）だけを使う。
 */
export function shareSummary(r: FortuneResultData, typeLabel: string): string {
  if (r.v === 2) {
    const rank = r.kind === "ZODIAC" ? `（12星座中${r.rank}位）` : "";
    return `${typeLabel}で今日の運勢レア度は「${r.rarity.en}｜${r.rarity.ja}」${rank}でした！総合運${stars(r.overall.stars)}`;
  }
  return `${typeLabel}で今日の総合運は${stars(r.overall.stars)}でした！ラッキーアイテムは「${r.luckyItem}」`;
}
