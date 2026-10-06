import type { Rng } from "./rng";
import type { Season, TimeOfDay } from "./context";
import type { Stars } from "./types";

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
