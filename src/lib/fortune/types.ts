/**
 * 占い結果（v2）の型。結果はこの形のまま fortuneResults に保存され、表示時に計算し直さない。
 * v を持たない結果は旧形式（LegacyFortuneResult）として扱う。
 */

export type Stars = 1 | 2 | 3 | 4 | 5;
export type StarComment = { stars: Stars; comment: string };

/** 4つの運勢（総合運以外） */
export const CATEGORY_KEYS = ["love", "work", "money", "health"] as const;
export type CategoryKey = (typeof CATEGORY_KEYS)[number];
export const CATEGORY_LABELS: Record<CategoryKey, string> = { love: "恋愛運", work: "仕事運", money: "金運", health: "健康運" };

/** その日の基本運勢の★（固定部分。購入ごとに変わらない） */
export type DayStars = { overall: Stars } & Record<CategoryKey, Stars>;

export const RARITY_KEYS = ["NEW_MOON", "CRESCENT", "HALF_MOON", "FULL_MOON", "MIRACLE"] as const;
export type RarityKey = (typeof RARITY_KEYS)[number];

export type RarityInfo = {
  key: RarityKey;
  /** 1（新月）〜5（奇跡の星夜） */
  level: 1 | 2 | 3 | 4 | 5;
  en: string;
  ja: string;
  tagline: string;
  /** なぜこのレア度なのか（画面に見えている運勢だけで説明） */
  reasons: string[];
  /** 満月・奇跡の星夜だけの専用メッセージ */
  special?: string;
};

/** 運勢が控えめな日ほど充実させる「整えるためのヒント」 */
export type CareSection = {
  /** 今日気をつけたいこと（注意すれば避けられること） */
  caution?: string;
  /** おすすめの過ごし方 */
  style?: string;
  /** 運気を整える行動 */
  reset?: string;
};

export type ZodiacSignRef = { key: string; name: string; symbol: string };

export type ZodiacResultV2 = {
  v: 2;
  kind: "ZODIAC";
  dateLabel: string;
  generatedAt: string;
  sign: ZodiacSignRef & { element: string };
  rank: number;
  /** 今日の12星座ランキング（1位から順に。★は総合運） */
  ranking: (ZodiacSignRef & { stars: Stars })[];
  rankHeadline: string;
  signNote: string;
  overall: StarComment;
  /** 今日のポイント（星座の持ち味と今日の調子のひとこと） */
  point: string;
  love: StarComment;
  work: StarComment;
  money: StarComment;
  health: StarComment;
  starMessage: string;
  goodSign: ZodiacSignRef & { reason: string };
  cautionSign: ZodiacSignRef & { reason: string };
  luckyColor: { name: string; hex: string };
  luckyItem: string;
  luckyTime: string;
  action: string;
  care: CareSection;
  rarity: RarityInfo;
};

export type FortuneResultV2 = ZodiacResultV2;
