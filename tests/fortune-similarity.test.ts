import { describe, expect, it } from "vitest";
import * as common from "@/lib/fortune/content/common";
import { generateBirthday } from "@/lib/fortune/birthday-fortune";
import { generateBlood } from "@/lib/fortune/blood-fortune";
import { maxSentenceSimilarity } from "@/lib/fortune/similarity";
import type { BloodTypeValue } from "@/lib/fortune/types";
import { BLOOD_TYPES, ZODIAC_KEYS } from "@/lib/fortune/zodiac";
import { generateZodiac } from "@/lib/fortune/zodiac-fortune";
import { jstDateString } from "@/lib/time";
import { birthdayBody, bloodBody, crossPairs, NEAR_DUPLICATE, sentences, zodiacBody } from "./helpers/similarity";

/**
 * 3種類の占いの本文が「書き分け」られていることを確かめる。
 * 実際に結果を作り、文ごとに比べて「同じ文」「ほぼ同じ文（類似度 0.7 以上）」が無いこと。
 * 共通で使ってよいのは色名・アイテム名・時間帯と、レア度の共通文言（名前・理由・満月／奇跡の星夜のメッセージ）だけ。
 */

const START = Date.UTC(2026, 0, 1, 3);
const at = (d: number, h: number) => new Date(START + d * 86_400_000 + h * 3_600_000);

function corpus() {
  const z = new Set<string>();
  const b = new Set<string>();
  const d = new Set<string>();
  const zr = [];
  const br = [];
  const dr = [];
  for (let day = 0; day < 45; day++) {
    for (const k of ZODIAC_KEYS) {
      const r = generateZodiac(k, { now: at(day, day % 14), purchaseSeed: `z${day}` });
      zr.push(zodiacBody(r));
      for (const s of sentences(zodiacBody(r))) z.add(s);
    }
    for (const bt of BLOOD_TYPES as readonly BloodTypeValue[]) {
      for (let m = 1; m <= 12; m++) {
        const r = generateBlood(bt, m, { now: at(day, 3), purchaseSeed: `b${day}` });
        br.push(bloodBody(r));
        for (const s of sentences(bloodBody(r))) b.add(s);
      }
    }
    for (let i = 0; i < 30; i++) {
      const birth = jstDateString(new Date(Date.UTC(1955, 0, 1) + (i * 401 + day * 37) * 86_400_000));
      const r = generateBirthday(birth, { now: at(day, 5), purchaseSeed: `d${day}-${i}` });
      dr.push(birthdayBody(r));
      for (const s of sentences(birthdayBody(r))) d.add(s);
    }
  }
  return { z, b, d, zr, br, dr };
}

describe("3種類の占いの本文の書き分け", () => {
  const c = corpus();
  const show = (pairs: { a: string; b: string; score: number }[]) => pairs.slice(0, 5).map((p) => `${p.score.toFixed(2)} ${p.a} ⇔ ${p.b}`).join("\n");

  it("12星座占い × 血液型占い：同じ文・ほぼ同じ文が無い", () => {
    const pairs = crossPairs(c.z, c.b, NEAR_DUPLICATE);
    expect(pairs.length, show(pairs)).toBe(0);
  });

  it("12星座占い × 生年月日占い：同じ文・ほぼ同じ文が無い", () => {
    const pairs = crossPairs(c.z, c.d, NEAR_DUPLICATE);
    expect(pairs.length, show(pairs)).toBe(0);
  });

  it("血液型占い × 生年月日占い：同じ文・ほぼ同じ文が無い", () => {
    const pairs = crossPairs(c.b, c.d, NEAR_DUPLICATE);
    expect(pairs.length, show(pairs)).toBe(0);
  });

  it("共通ファイルに置くのは、色名・アイテム名・時間帯だけ（占いの本文は置かない）", () => {
    expect(Object.keys(common).sort()).toEqual(["LUCKY_COLORS", "LUCKY_ITEMS", "LUCKY_TIME_WINDOWS"]);
  });

  it("同じ結果の中に、ほぼ同じ意味の文が並ばない（12星座占い・血液型占い）", () => {
    for (const texts of [...c.zr, ...c.br]) {
      const t = texts.filter((x) => [...x].length >= 12);
      for (let i = 0; i < t.length; i++) for (let j = i + 1; j < t.length; j++) expect(maxSentenceSimilarity(t[i], t[j]), `${t[i]} / ${t[j]}`).toBeLessThan(0.7);
    }
  });
});
