import type { FortuneResultData } from "@/lib/db/schema";
import { createRng, hashString } from "./rng";
import type { RarityKey } from "./types";

/**
 * 結果表示の演出（今日の月が現れる → レア度が判明 → 結果本文）の設定。
 * 表示だけに使い、占い結果の内容・保存データには一切影響しない。
 */

/** 演出の時間（ミリ秒）。out = 演出画面が消え始める時刻、FADE_MS かけて消える */
export const REVEAL_TIMING: Record<RarityKey, { out: number }> = {
  NEW_MOON: { out: 1500 },
  CRESCENT: { out: 1500 },
  HALF_MOON: { out: 1650 },
  FULL_MOON: { out: 2000 },
  MIRACLE: { out: 2700 },
};
export const REVEAL_FADE_MS = 400;

/** 演出画面の星の数（低スペック端末でも軽いよう最小限に） */
export const REVEAL_STARS: Record<RarityKey, number> = {
  NEW_MOON: 5,
  CRESCENT: 8,
  HALF_MOON: 11,
  FULL_MOON: 14,
  MIRACLE: 24,
};

/** 流れ星は奇跡の星夜だけ */
export const REVEAL_SHOOTING: Record<RarityKey, number> = {
  NEW_MOON: 0,
  CRESCENT: 0,
  HALF_MOON: 0,
  FULL_MOON: 0,
  MIRACLE: 3,
};

/** 演出を「このブラウザで見たか」を記録するキー（結果ごとに異なる。結果データは変更しない） */
export function revealStorageKey(r: FortuneResultData): string | null {
  if (r.v !== 2) return null; // 旧形式の結果にはレア度が無い → 演出なし
  return `fx-reveal:${r.kind}:${r.generatedAt}`;
}

export type StarPos = { x: number; y: number; size: number; delay: number; sx: number; sy: number };
export type ShootingPos = { top: number; left: number; angle: number; delay: number; length: number };

/**
 * 星の位置（結果ごとに少しずつ違うが、同じ結果なら毎回同じ）。中央の文字の周りは避ける。
 * sx/sy は奇跡の星夜で「星が集まる」ときの出発点のずれ（px）。
 */
export function starField(seed: string, n: number): StarPos[] {
  const rng = createRng(hashString(`stars|${seed}`));
  const out: StarPos[] = [];
  while (out.length < n) {
    const x = 4 + rng.next() * 92;
    const y = 4 + rng.next() * 88;
    // 中央（月と文字）付近は空ける
    if (x > 22 && x < 78 && y > 30 && y < 72) continue;
    const dx = (x - 50) * 2.2;
    const dy = (y - 50) * 2.2;
    out.push({ x, y, size: 1.5 + rng.next() * 2.5, delay: Math.round(rng.next() * 700), sx: Math.round(dx), sy: Math.round(dy) });
  }
  return out;
}

/** 流れ星（画面の右上の外から入り、左下へ抜ける。開始位置と角度を結果ごとに少し変える） */
export function shootingStars(seed: string, n: number): ShootingPos[] {
  const rng = createRng(hashString(`shooting|${seed}`));
  return Array.from({ length: n }, (_, i) => ({
    top: Math.round(-5 + i * 18 + rng.next() * 10),
    left: Math.round(55 + rng.next() * 40),
    angle: Math.round(28 + rng.next() * 14),
    delay: 1000 + i * 250 + Math.round(rng.next() * 80),
    length: Math.round(90 + rng.next() * 60),
  }));
}

/** 演出の状態。init=サーバー描画直後 / play=演出中 / done=完成状態 */
export type RevealPhase = "init" | "play" | "done";
export type RevealAction = "start" | "skip" | "finish" | "already-seen" | "reduced-motion" | "replay";

export function revealReducer(phase: RevealPhase, action: RevealAction): RevealPhase {
  switch (action) {
    case "start":
    case "replay":
      return "play";
    case "skip":
    case "finish":
    case "already-seen":
    case "reduced-motion":
      return "done";
  }
  return phase;
}
