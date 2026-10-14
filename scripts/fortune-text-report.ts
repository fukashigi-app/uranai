/**
 * 占い文章の品質を数字で確かめる（開発用）。
 *   npx tsx scripts/fortune-text-report.ts [sample]
 * 文字数・再購入時に変わる文章の割合・同じ言い回しの回数を表示する。
 */
import { generateBirthday } from "@/lib/fortune/birthday-fortune";
import { generateBlood } from "@/lib/fortune/blood-fortune";
import type { BloodTypeValue } from "@/lib/fortune/types";
import { BLOOD_TYPES, ZODIAC_KEYS } from "@/lib/fortune/zodiac";
import { generateZodiac } from "@/lib/fortune/zodiac-fortune";
import { jstDateString } from "@/lib/time";
import { birthdayReading, bloodReading, changedShare, zodiacReadingTexts } from "../tests/helpers/fortune";

const START = Date.UTC(2026, 0, 1, 3);
const at = (d: number, h: number) => new Date(START + d * 86_400_000 + h * 3_600_000);
const BIRTHS = Array.from({ length: 200 }, (_, i) => jstDateString(new Date(Date.UTC(1955, 0, 1) + i * 211 * 86_400_000)));
const stat = (xs: number[]) => `平均 ${(xs.reduce((a, b) => a + b, 0) / xs.length).toFixed(1)} / 最小 ${Math.min(...xs)} / 最大 ${Math.max(...xs)}`;
const count = (s: string, w: string) => s.split(w).length - 1;

function report(name: string, pairs: [string[], string[]][]) {
  const len = pairs.map(([a]) => a.reduce((n, t) => n + [...t].length, 0));
  const share = pairs.map(([a, b]) => changedShare(a, b));
  const anata = pairs.map(([a]) => count(a.join(""), "あなた"));
  const hi = pairs.map(([a]) => count(a.join(""), "日です"));
  console.log(`\n## ${name}（${pairs.length}件）`);
  console.log(`文字数: ${stat(len)}`);
  console.log(`再購入で変わる文章の割合: 平均 ${(100 * share.reduce((a, b) => a + b, 0) / share.length).toFixed(1)}%`);
  console.log(`「あなた」: ${stat(anata)} / 「日です」: ${stat(hi)}`);
}

const z: [string[], string[]][] = [];
const b: [string[], string[]][] = [];
const d: [string[], string[]][] = [];
for (let day = 0; day < 60; day++) {
  for (const k of ZODIAC_KEYS) z.push([zodiacReadingTexts(generateZodiac(k, { now: at(day, 2), purchaseSeed: `a${day}` })), zodiacReadingTexts(generateZodiac(k, { now: at(day, 2), purchaseSeed: `b${day}` }))]);
  for (const bt of BLOOD_TYPES as readonly BloodTypeValue[]) for (const mo of [1, 4, 8, 11]) b.push([bloodReading(generateBlood(bt, mo, { now: at(day, 2), purchaseSeed: `a${day}` })), bloodReading(generateBlood(bt, mo, { now: at(day, 2), purchaseSeed: `b${day}` }))]);
  for (const birth of BIRTHS.slice(0, 50)) d.push([birthdayReading(generateBirthday(birth, { now: at(day, 2), purchaseSeed: `a${day}` })), birthdayReading(generateBirthday(birth, { now: at(day, 2), purchaseSeed: `b${day}` }))]);
}
report("星座占い", z);
report("血液型占い", b);
report("生年月日占い", d);

if (process.argv[2] === "sample") {
  for (let i = 0; i < Number(process.argv[3] ?? 4); i++) {
    const r = generateBirthday(BIRTHS[i * 17], { now: at(i * 3, 2), purchaseSeed: `s${i}` });
    console.log("\n----", r.sign.name, `誕生数${r.lifePath}`, `今日${r.personalDay}`, r.rarity.key, `★${r.overall.stars}`);
    console.log(birthdayReading(r).filter(Boolean).join("\n"));
  }
}
