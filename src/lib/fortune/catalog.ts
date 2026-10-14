import type { FortuneTypeValue } from "@/lib/db/schema";

export type FortuneCatalogItem = {
  slug: string;
  /** 占いの名前（選択画面・支払い画面・結果画面・共有文で共通） */
  label: string;
  /** 管理画面などの短い表示 */
  short: string;
  /** 選択カードの一言キャッチ */
  catch: string;
  description: string;
  /** 入力するもの（選択カードに表示） */
  inputHint: string;
  /** おすすめする人（選択カードに表示） */
  forWhom: string;
  /** 支払い画面に出す「この占いでわかること」（3項目） */
  learn: readonly [string, string, string];
  inputLabel: string;
};

/** 画面表示用の占いカタログ（クライアントでも利用） */
export const FORTUNE_CATALOG: Record<FortuneTypeValue, FortuneCatalogItem> = {
  ZODIAC: {
    slug: "zodiac",
    label: "星座占い",
    short: "星座",
    catch: "今日の12星座ランキング、あなたは何位？",
    description: "12星座を今日の運勢で順位付け。友達と順位を見比べて楽しめます。",
    inputHint: "星座を選ぶ",
    forWhom: "みんなで比べたい人に",
    learn: ["今日の12星座ランキング", "5つの運勢", "相性のいい星座＆ラッキー情報"],
    inputLabel: "星座",
  },
  BLOOD: {
    slug: "blood",
    label: "血液型占い",
    short: "血液型",
    catch: "血液型×生まれ月の48タイプ診断",
    description: "あなたのタイプ名と、今日うまくいく行動・相性のいい血液型がわかります。",
    inputHint: "血液型＋生まれ月",
    forWhom: "タイプ診断が好きな人に",
    learn: ["あなたの48タイプ", "今日うまくいく行動", "相性のいい血液型＆5つの運勢"],
    inputLabel: "血液型と生まれた月",
  },
  BIRTHDAY: {
    slug: "birthday",
    label: "生年月日占い",
    short: "生年月日",
    catch: "星座×誕生数×今日のナンバーの本格占い",
    description: "生年月日から3つのサインを読み解き、あなたの性質と今日のテーマを詳しく占います。",
    inputHint: "生年月日",
    forWhom: "じっくり占いたい人に",
    learn: ["あなたの基本タイプ", "今日のテーマ", "5つの運勢＆ラッキー情報"],
    inputLabel: "生年月日",
  },
};

/** 選択画面での並び順（気軽なもの → じっくり読むもの） */
export const FORTUNE_ORDER: readonly FortuneTypeValue[] = ["ZODIAC", "BLOOD", "BIRTHDAY"];

export function fortuneTypeFromSlug(slug: string | undefined | null): FortuneTypeValue | null {
  const entry = Object.entries(FORTUNE_CATALOG).find(([, v]) => v.slug === slug);
  return (entry?.[0] as FortuneTypeValue | undefined) ?? null;
}
