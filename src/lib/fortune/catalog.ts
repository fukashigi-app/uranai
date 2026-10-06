import type { FortuneTypeValue } from "@/lib/db/schema";

/** 画面表示用の占いカタログ（クライアントでも利用） */
export const FORTUNE_CATALOG: Record<
  FortuneTypeValue,
  { slug: string; label: string; short: string; description: string; inputLabel: string }
> = {
  BIRTHDAY: {
    slug: "birthday",
    label: "生年月日占い",
    short: "生年月日",
    description: "生まれた日の星と数字から、あなただけの今日の運勢を読み解きます。",
    inputLabel: "生年月日",
  },
  ZODIAC: {
    slug: "zodiac",
    label: "星座占い",
    short: "星座",
    description: "12星座の巡りから、今日のあなたの運勢と星座ランキングをお届け。",
    inputLabel: "星座",
  },
  BLOOD: {
    slug: "blood",
    label: "血液型占い",
    short: "血液型",
    description: "血液型×生まれた月の48タイプから、あなたらしい今日の過ごし方をアドバイス。",
    inputLabel: "血液型と生まれた月",
  },
};

export function fortuneTypeFromSlug(slug: string | undefined | null): FortuneTypeValue | null {
  const entry = Object.entries(FORTUNE_CATALOG).find(([, v]) => v.slug === slug);
  return (entry?.[0] as FortuneTypeValue | undefined) ?? null;
}
