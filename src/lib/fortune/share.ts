import type { FortuneResultData } from "@/lib/db/schema";

const stars = (n: number) => "★".repeat(n) + "☆".repeat(5 - n);

/**
 * 共有用の短い文章。個人情報（生年月日など）は含めない（星座・血液型・生まれ月・誕生数・タイプ名だけ）。
 * 例: 「血液型占いをしたら、O型×8月の『真夏の太陽リーダー』でした！今日の運勢レア度は『NEW MOON｜新月』、総合運★★★☆☆」
 * 将来 SNS 用の画像を作る場合も、この関数が返す要素（占いの種類・レア度・順位やタイプ・総合運）だけを使う。
 */
export function shareSummary(r: FortuneResultData, typeLabel: string): string {
  if (r.v === 2) {
    const who =
      r.kind === "ZODIAC"
        ? `${r.sign.name}は今日12星座中${r.rank}位`
        : r.kind === "BLOOD"
          ? `${r.bloodType}型×${r.birthMonth}月の「${r.typeName}」`
          : `${r.sign.name}×誕生数${r.lifePath}の「${r.typeName}」`;
    return `${typeLabel}をしたら、${who}でした！今日の運勢レア度は「${r.rarity.en}｜${r.rarity.ja}」、総合運${stars(r.overall.stars)}`;
  }
  return `${typeLabel}で今日の総合運は${stars(r.overall.stars)}でした！ラッキーアイテムは「${r.luckyItem}」`;
}
