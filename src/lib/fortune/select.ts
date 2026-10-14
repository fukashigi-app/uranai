import type { Rng } from "./rng";
import type { Season, TimeOfDay } from "./context";
import type { Stars } from "./types";
import { hasSimilarSentence } from "./similarity";

/**
 * 「札」付きの文章から、条件に合うものだけを選ぶ仕組み。
 *  tone   … 好調(high: ★4〜5) / 普通(mid: ★3) / 控えめ(low: ★1〜2)。省略はどれでも可
 *  season … 季節。省略は通年
 *  time   … 時間帯。省略はいつでも
 */
export type Tone = "high" | "mid" | "low";
export type Tagged = { text: string; tone?: readonly Tone[]; season?: readonly Season[]; time?: readonly TimeOfDay[] };
export type Condition = { tone?: Tone; season?: Season; time?: TimeOfDay };

export function toneOf(stars: Stars): Tone {
  return stars >= 4 ? "high" : stars === 3 ? "mid" : "low";
}

export function matches(t: Tagged, c: Condition): boolean {
  if (c.tone && t.tone && !t.tone.includes(c.tone)) return false;
  if (c.season && t.season && !t.season.includes(c.season)) return false;
  if (c.time && t.time && !t.time.includes(c.time)) return false;
  return true;
}

export function candidates<T extends Tagged>(pool: readonly T[], c: Condition): T[] {
  return pool.filter((t) => matches(t, c));
}

/** 条件に合う中から1つ選ぶ。used に入っている文章は避ける（同じ結果の中で重複させない） */
export function pickTagged<T extends Tagged>(rng: Rng, pool: readonly T[], c: Condition, used?: Set<string>): T {
  const all = candidates(pool, c);
  if (all.length === 0) throw new Error("no fortune text matches the condition");
  const fresh = used ? all.filter((t) => !used.has(t.text)) : all;
  const chosen = rng.pick(fresh.length ? fresh : all);
  used?.add(chosen.text);
  return chosen;
}

/** {name} 形式の差し込み。未定義の差し込みが残っていたらエラー（テストで検出） */
export function fill(template: string, vars: Record<string, string | number>): string {
  const out = template.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m));
  if (/\{\w+\}/.test(out)) throw new Error(`unfilled placeholder in: ${template}`);
  return out;
}

const SLOT = /\{(\w+)\}/g;
export const slotsOf = (template: string) => [...template.matchAll(SLOT)].map((m) => m[1]);

/** 同じ結果の中で「似た文」とみなす類似度 */
export const SIMILAR_IN_RESULT = 0.55;

export type ComposerOptions = {
  /** 1つの結果で1回だけ使いたい差し込み（星座・誕生数の特徴など） */
  tracked?: readonly string[];
  /** 1つの結果で使う回数の上限（「あなた」「日です」など、続くと単調になる言い回し） */
  limits?: Readonly<Record<string, number>>;
  /** 組み立てる文章の合計文字数の目安（超えない候補を優先する） */
  maxLength?: number;
};

/**
 * 1つの結果の文章を組み立てる道具。候補の中から、
 *  ① すでに選んだ文と似ていない文、② まだ使っていない特徴の差し込み、③ 言い回しの回数上限と文字数の目安
 * を満たすものを優先して選ぶ（満たすものが無ければ、回数上限 → 特徴の重複 → 文字数 の順に条件をゆるめる。似た文を避けることを最優先）。
 * 乱数の使い方は候補の数だけで決まるので、同じ条件なら必ず同じ結果になる。
 */
export function createComposer(vars: Record<string, string | number>, opts: ComposerOptions = {}) {
  const tracked = new Set(opts.tracked ?? []);
  const limits = Object.entries(opts.limits ?? {});
  const usedSlots = new Set<string>();
  const texts: string[] = [];
  const count = (s: string, w: string) => s.split(w).length - 1;

  const register = (template: string, filled: string) => {
    for (const s of slotsOf(template)) if (tracked.has(s)) usedSlots.add(s);
    texts.push(filled);
    return filled;
  };

  return {
    texts,
    /** 固定部分など、選び方が決まっている文章を登録する（以降の選択で重複を避ける対象になる） */
    add(template: string): string {
      return register(template, fill(template, vars));
    },
    pick(rng: Rng, pool: readonly (string | Tagged)[], c: Condition = {}): string {
      const all = pool.map((t) => (typeof t === "string" ? { text: t } : t)).filter((t) => matches(t, c));
      if (all.length === 0) throw new Error("no fortune text matches the condition");
      const items = all.map((t) => ({ template: t.text, filled: fill(t.text, vars) }));
      const notSimilar = (x: (typeof items)[number]) => texts.every((t) => !hasSimilarSentence(x.filled, t, SIMILAR_IN_RESULT));
      const freshSlots = (x: (typeof items)[number]) => slotsOf(x.template).every((s) => !usedSlots.has(s));
      const length = texts.reduce((n, t) => n + [...t].length, 0);
      const fitsLength = (x: (typeof items)[number]) => !opts.maxLength || length + [...x.filled].length <= opts.maxLength;
      const withinLimits = (x: (typeof items)[number]) =>
        limits.every(([w, max]) => count(x.filled, w) === 0 || texts.reduce((n, t) => n + count(t, w), 0) + count(x.filled, w) <= max);
      // 乱数で並べた順に確かめ、条件を満たす最初の候補を選ぶ（似ているかどうかの計算は重いので必要な分だけ）
      const order = [...items];
      for (let i = order.length - 1; i > 0; i--) {
        const j = Math.floor(rng.next() * (i + 1));
        [order[i], order[j]] = [order[j], order[i]];
      }
      const stages = [
        [fitsLength, freshSlots, withinLimits, notSimilar],
        [fitsLength, freshSlots, notSimilar],
        [fitsLength, notSimilar],
        [notSimilar],
      ];
      const chosen = stages.map((fs) => order.find((x) => fs.every((f) => f(x)))).find(Boolean) ?? order[0];
      return register(chosen.template, chosen.filled);
    },
  };
}

export type Composer = ReturnType<typeof createComposer>;
