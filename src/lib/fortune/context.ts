import { jstDateString } from "@/lib/time";
import { createRng, hashString, type Rng } from "./rng";

/**
 * 占いを作るときの状況（日付・季節・時刻）と、2層構造の乱数。
 *
 *  - 固定層 dayRng      … 日付＋入力だけで決まる（★・ランキング・レア度・相性など）。再購入しても同じ
 *  - 購入層 purchaseRng … 日付＋入力＋購入ごとの値で決まる（補足文・一言・開運行動・ラッキー系）
 *
 * Math.random() は使わない。同じ条件なら必ず同じ結果になる。
 */

export type Season = "spring" | "summer" | "autumn" | "winter";
export type TimeOfDay = "morning" | "day" | "night";

export type GenerateContext = {
  /** 結果を作った時刻 */
  now: Date;
  /** 購入ごとに異なる値（fortuneSession ID 由来。テストモードはテストセッションID由来） */
  purchaseSeed: string;
};

const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

export type Moment = {
  date: string;
  /** JST の時（0〜23）と分 */
  hour: number;
  minute: number;
  month: number;
  season: Season;
  timeOfDay: TimeOfDay;
};

export function seasonOfMonth(month: number): Season {
  if (month >= 3 && month <= 5) return "spring";
  if (month >= 6 && month <= 8) return "summer";
  if (month >= 9 && month <= 11) return "autumn";
  return "winter";
}

export function timeOfDayOf(hour: number): TimeOfDay {
  if (hour >= 5 && hour < 11) return "morning";
  if (hour >= 11 && hour < 17) return "day";
  return "night";
}

export function momentOf(now: Date): Moment {
  const j = new Date(now.getTime() + JST_OFFSET_MS);
  const hour = j.getUTCHours();
  const month = j.getUTCMonth() + 1;
  return { date: jstDateString(now), hour, minute: j.getUTCMinutes(), month, season: seasonOfMonth(month), timeOfDay: timeOfDayOf(hour) };
}

const VERSION = "v2";

/** 固定層：日付＋入力（＋用途）だけで決まる乱数 */
export function dayRng(date: string, subject: string, salt: string): Rng {
  return createRng(hashString(`${VERSION}|day|${date}|${subject}|${salt}`));
}

/** 購入層：日付＋入力＋購入ごとの値で決まる乱数 */
export function purchaseRng(date: string, subject: string, purchaseSeed: string, salt: string): Rng {
  return createRng(hashString(`${VERSION}|buy|${date}|${subject}|${purchaseSeed}|${salt}`));
}
