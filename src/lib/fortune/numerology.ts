import { lifePathNumber } from "./zodiac";

/**
 * 数秘術の計算（生年月日占いで使用）。
 *
 *  誕生数（ライフパスナンバー）… 既存の lifePathNumber をそのまま使う
 *    生年月日の数字をすべて足し、1桁になるまで足し続ける。途中で 11・22・33 になったらマスターナンバーとして残す
 *  今日の個人日数（パーソナルデイナンバー）… 一般的な数秘術の方式
 *    誕生月 ＋ 誕生日 ＋ 今日の年 ＋ 今日の月 ＋ 今日の日 の数字をすべて足し、1〜9 の1桁にする
 *    （マスターナンバーは使わない。同じ人でも日付が変わると数字が変わる）
 */

export { lifePathNumber };

export function digitSum(n: number | string): number {
  return String(n)
    .replace(/\D/g, "")
    .split("")
    .reduce((s, c) => s + Number(c), 0);
}

/** 1〜9 の1桁になるまで足す */
export function reduceToDigit(n: number): number {
  let v = n;
  while (v > 9) v = digitSum(v);
  return v;
}

export const isMasterNumber = (n: number) => n === 11 || n === 22 || n === 33;

/** マスターナンバーを1桁に（11→2 / 22→4 / 33→6） */
export const lifePathDigit = (n: number) => reduceToDigit(n);

/** 今日の個人日数（1〜9）。date は日本時間の "YYYY-MM-DD" */
export function personalDayNumber(birthMonth: number, birthDay: number, date: string): number {
  const [y, m, d] = date.split("-").map(Number);
  return reduceToDigit(digitSum(birthMonth) + digitSum(birthDay) + digitSum(y) + digitSum(m) + digitSum(d));
}
