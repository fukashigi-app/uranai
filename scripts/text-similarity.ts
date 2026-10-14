/**
 * 3種類の占いの本文に、同じ文・ほぼ同じ文がどれだけあるかを数える（開発用の確認スクリプト）。
 *   npx tsx scripts/text-similarity.ts
 */
import { generateBirthday } from "@/lib/fortune/birthday-fortune";
import { generateBlood } from "@/lib/fortune/blood-fortune";
import type { BloodTypeValue } from "@/lib/fortune/types";
import { BLOOD_TYPES, ZODIAC_KEYS } from "@/lib/fortune/zodiac";
import { generateZodiac } from "@/lib/fortune/zodiac-fortune";
import { jstDateString } from "@/lib/time";
import { birthdayBody, bloodBody, crossPairs, sentences, zodiacBody } from "../tests/helpers/similarity";

const START = Date.UTC(2026, 0, 1, 3);
const at = (d: number, h: number) => new Date(START + d * 86_400_000 + h * 3_600_000);
const z = new Set<string>();
const b = new Set<string>();
const d = new Set<string>();
for (let day = 0; day < 120; day++) {
  for (const k of ZODIAC_KEYS) for (const s of sentences(zodiacBody(generateZodiac(k, { now: at(day, day % 14), purchaseSeed: `z${day}` })))) z.add(s);
  for (const bt of BLOOD_TYPES as readonly BloodTypeValue[]) for (let m = 1; m <= 12; m++) for (const s of sentences(bloodBody(generateBlood(bt, m, { now: at(day, 3), purchaseSeed: `b${day}` })))) b.add(s);
  for (let i = 0; i < 40; i++) {
    const birth = jstDateString(new Date(Date.UTC(1955, 0, 1) + (i * 401 + day * 37) * 86_400_000));
    for (const s of sentences(birthdayBody(generateBirthday(birth, { now: at(day, 5), purchaseSeed: `d${day}-${i}` })))) d.add(s);
  }
}
const report = (name: string, x: Set<string>, y: Set<string>) => {
  const pairs = crossPairs(x, y, Number(process.env.THRESH ?? 0.7));
  const exact = pairs.filter((p) => p.score === 1).length;
  console.log(`\n## ${name}: 完全一致 ${exact} / ほぼ一致 ${pairs.length - exact}（合計 ${pairs.length}）`);
  for (const p of pairs.sort((a, c) => c.score - a.score).slice(0, Number(process.env.SHOW ?? 60))) console.log(`${p.score.toFixed(2)}  ${p.a}  ⇔  ${p.b}`);
};
console.log(`文の種類: 星座 ${z.size} / 血液型 ${b.size} / 生年月日 ${d.size}`);
report("星座 × 血液型", z, b);
report("星座 × 生年月日", z, d);
report("血液型 × 生年月日", b, d);
