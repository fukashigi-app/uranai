/**
 * 文章どうしの似ている度合い（同じ結果の中の重複を避ける・3種類の占いの書き分けを確かめるために使う）。
 * 記号を除いた文字の2文字ずつの並び（2-gram）がどれだけ重なるかで測る。0〜1、1は同じ文。
 */

export function normalizeSentence(s: string): string {
  return s.replace(/[\s「」『』（）()、。！？!?・…〜ー—\-]/g, "");
}

/** 文章を文（。！？で区切る）に分け、記号を除く。短すぎる断片は比べない */
export function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[。！？])/)
    .map(normalizeSentence)
    .filter((s) => [...s].length >= 8);
}

function bigrams(s: string): Map<string, number> {
  const m = new Map<string, number>();
  const a = [...s];
  for (let i = 0; i < a.length - 1; i++) {
    const g = a[i] + a[i + 1];
    m.set(g, (m.get(g) ?? 0) + 1);
  }
  return m;
}

export function similarity(a: string, b: string): number {
  if (a === b) return 1;
  const x = bigrams(a);
  const y = bigrams(b);
  let inter = 0;
  let total = 0;
  for (const [g, n] of x) {
    inter += Math.min(n, y.get(g) ?? 0);
    total += n;
  }
  for (const n of y.values()) total += n;
  return total ? (2 * inter) / total : 0;
}

type Grams = { size: number; map: Map<string, number> };
const cache = new Map<string, Grams[]>();

/** 文章ごとの 2-gram（同じ文章を何度も比べるので覚えておく） */
function sentenceGrams(text: string): Grams[] {
  let g = cache.get(text);
  if (!g) {
    g = splitSentences(text).map((s) => {
      const map = bigrams(s);
      let size = 0;
      for (const n of map.values()) size += n;
      return { size, map };
    });
    if (cache.size > 50_000) cache.clear();
    cache.set(text, g);
  }
  return g;
}

function gramSimilarity(x: Grams, y: Grams): number {
  const total = x.size + y.size;
  if (!total) return 0;
  const [small, large] = x.map.size <= y.map.size ? [x.map, y.map] : [y.map, x.map];
  let inter = 0;
  for (const [g, n] of small) inter += Math.min(n, large.get(g) ?? 0);
  return (2 * inter) / total;
}

/** 2つの文章の中で、いちばん似ている文どうしの類似度 */
export function maxSentenceSimilarity(a: string, b: string): number {
  let max = 0;
  for (const x of sentenceGrams(a)) for (const y of sentenceGrams(b)) max = Math.max(max, gramSimilarity(x, y));
  return max;
}

/** 2つの文章に、類似度が threshold 以上の文どうしがあるか（長さの差で計算を省く） */
export function hasSimilarSentence(a: string, b: string, threshold: number): boolean {
  const ys = sentenceGrams(b);
  for (const x of sentenceGrams(a)) {
    for (const y of ys) {
      if ((2 * Math.min(x.size, y.size)) / (x.size + y.size) < threshold) continue;
      if (gramSimilarity(x, y) >= threshold) return true;
    }
  }
  return false;
}
