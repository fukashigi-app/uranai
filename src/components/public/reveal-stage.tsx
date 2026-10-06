"use client";

import { useCallback, useEffect, useLayoutEffect, useReducer, useState } from "react";
import type { RarityInfo } from "@/lib/fortune/types";
import { REVEAL_FADE_MS, REVEAL_SHOOTING, REVEAL_STARS, REVEAL_TIMING, revealReducer, shootingStars, starField } from "@/lib/fortune/reveal";
import { MoonPhase } from "./moon-phase";

/**
 * 結果表示の演出：占い中（入力画面） → 今日の月が現れる → レア度が判明 → 結果本文。
 *
 * - その結果をこのブラウザで初めて表示したときだけ演出する（localStorage に「見た」印だけを記録。結果データは変更しない）
 * - 再読み込み・再表示ではすぐに完成状態を表示。「演出をもう一度見る」で再生できる
 * - 画面タップ／「結果を見る」でいつでもスキップ
 * - prefers-reduced-motion では演出を出さず、すぐに完成状態（月・レア度は結果カードに静的に表示）
 * - JavaScript が動かない場合も、CSS のタイムラインだけで演出画面は自動で消える
 */

export type RevealMode = "auto" | "intro" | "final" | "reduced";
type RevealRarity = Pick<RarityInfo, "key" | "level" | "en" | "ja" | "tagline">;

const SKIP_ATTR = "data-fx-skip";

/** サーバー描画直後（JS 読み込み前）に、見たことのある結果・動きを減らす設定なら演出を隠す */
function inlineSkipScript(storageKey: string): string {
  return `try{var k=${JSON.stringify(storageKey)};var r=window.matchMedia&&window.matchMedia("(prefers-reduced-motion: reduce)").matches;if(r||localStorage.getItem(k)==="1"){document.documentElement.setAttribute("${SKIP_ATTR}","1")}else{document.documentElement.removeAttribute("${SKIP_ATTR}")}}catch(e){}`;
}

export function RevealStage({
  storageKey,
  rarity,
  mode = "auto",
  children,
}: {
  storageKey: string | null;
  rarity?: RevealRarity;
  mode?: RevealMode;
  children: React.ReactNode;
}) {
  const enabled = Boolean(storageKey && rarity);
  const [phase, dispatch] = useReducer(revealReducer, enabled && mode !== "final" && mode !== "reduced" ? "init" : "done");
  const [run, setRun] = useState(0);
  const [canReplay, setCanReplay] = useState(false);

  // 表示前（描画前）に「初めてか／見たことがあるか／動きを減らす設定か」を判断する
  useLayoutEffect(() => {
    if (!enabled || !storageKey) return;
    const root = document.documentElement;
    const reduce = mode === "reduced" || window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let seen = false;
    try {
      seen = localStorage.getItem(storageKey) === "1";
    } catch {
      // 保存できない環境（プライベートモード等）では毎回初回として扱う
    }
    // eslint-disable-next-line react-hooks/set-state-in-effect -- ブラウザでしか分からない状態を、描画前に1回だけ反映する
    setCanReplay(!reduce);
    if (mode === "final" || reduce || (seen && mode !== "intro")) {
      root.setAttribute(SKIP_ATTR, "1");
      dispatch(reduce ? "reduced-motion" : "already-seen");
      return;
    }
    root.removeAttribute(SKIP_ATTR);
    try {
      localStorage.setItem(storageKey, "1");
    } catch {
      // 記録できなくても演出は再生する
    }
    dispatch("start");
  }, [enabled, storageKey, mode]);

  const skip = useCallback(() => {
    document.documentElement.setAttribute(SKIP_ATTR, "1");
    dispatch("skip");
  }, []);

  // 演出中：時間が来たら完成状態へ／Esc でスキップ／背景のスクロールを止める
  useEffect(() => {
    if (phase !== "play" || !rarity) return;
    const t = window.setTimeout(() => dispatch("finish"), REVEAL_TIMING[rarity.key].out + REVEAL_FADE_MS + 250);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") skip();
    };
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", onKey);
    return () => {
      window.clearTimeout(t);
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [phase, rarity, run, skip]);

  const replay = () => {
    window.scrollTo({ top: 0 });
    document.documentElement.removeAttribute(SKIP_ATTR);
    setRun((r) => r + 1);
    dispatch("replay");
  };

  const timing = rarity ? REVEAL_TIMING[rarity.key] : null;
  const showOverlay = enabled && rarity && storageKey && phase !== "done";
  return (
    <div
      className={`fx-stage ${mode === "reduced" ? "fx-force-reduced" : ""}`}
      data-fx-phase={phase}
      style={timing ? ({ "--fx-out": `${timing.out}ms` } as React.CSSProperties) : undefined}
    >
      {enabled && storageKey && phase === "init" && mode === "auto" ? <script dangerouslySetInnerHTML={{ __html: inlineSkipScript(storageKey) }} /> : null}
      {showOverlay ? <RevealOverlay key={run} rarity={rarity} seed={storageKey} onSkip={skip} onEnd={() => dispatch("finish")} /> : null}
      <div className={`fx-body ${enabled && phase !== "done" ? "" : "fx-body-instant"}`}>{children}</div>
      {enabled && phase === "done" && canReplay ? (
        <div className="mt-4 text-center">
          <button type="button" onClick={replay} className="rounded-full border border-white/10 px-4 py-2 text-[12px] text-ink-muted transition-colors hover:text-gold-200">
            ✦ 演出をもう一度見る
          </button>
        </div>
      ) : null}
    </div>
  );
}

const TIER_CLASS: Record<RevealRarity["key"], string> = {
  NEW_MOON: "fx-tier-new",
  CRESCENT: "fx-tier-crescent",
  HALF_MOON: "fx-tier-half",
  FULL_MOON: "fx-tier-full",
  MIRACLE: "fx-tier-miracle",
};

/** 演出画面（今日の月 → レア度名 → 添え書き）。装飾はすべて aria-hidden（結果カードに同じ情報を文字で表示している） */
export function RevealOverlay({ rarity, seed, onSkip, onEnd }: { rarity: RevealRarity; seed: string; onSkip?: () => void; onEnd?: () => void }) {
  const stars = starField(seed, REVEAL_STARS[rarity.key]);
  const shooting = shootingStars(seed, REVEAL_SHOOTING[rarity.key]);
  const miracle = rarity.key === "MIRACLE";
  const bright = rarity.key === "FULL_MOON" || miracle;
  return (
    <div
      className={`fx-reveal-overlay ${TIER_CLASS[rarity.key]}`}
      data-fx="reveal"
      data-fx-tier={rarity.key}
      onClick={onSkip}
      // 演出画面が消え終わったら、すぐに完成状態へ（スクロールの停止も解除）
      onAnimationEnd={(e) => {
        if (e.target === e.currentTarget && e.animationName === "fx-overlay-out") onEnd?.();
      }}
    >
      <div className="fx-sky" aria-hidden="true">
        {stars.map((s, i) => (
          <span
            key={i}
            className="fx-star"
            data-fx-star=""
            style={
              {
                left: `${s.x}%`,
                top: `${s.y}%`,
                width: `${s.size}px`,
                height: `${s.size}px`,
                animationDelay: `${s.delay}ms`,
                "--fx-sx": `${s.sx}px`,
                "--fx-sy": `${s.sy}px`,
              } as React.CSSProperties
            }
          />
        ))}
        {shooting.map((s, i) => (
          <span
            key={`s${i}`}
            className="fx-shooting"
            data-fx-shooting=""
            style={{ top: `${s.top}%`, left: `${s.left}%`, width: `${s.length}px`, animationDelay: `${s.delay}ms`, "--fx-angle": `${s.angle}deg` } as React.CSSProperties}
          />
        ))}
        {miracle ? <span className="fx-goldlight" /> : null}
        <div className="fx-center">
          {bright ? <span className="fx-halo" /> : null}
          <div className="fx-moon" data-moon-level={rarity.level}>
            <MoonPhase level={rarity.level} className="h-28 w-28" />
          </div>
          <p className="fx-label">今日の運勢レア度</p>
          <p className="fx-name-en">{rarity.en}</p>
          <p className="fx-name-ja">{rarity.ja}</p>
          <p className="fx-tagline">「{rarity.tagline}」</p>
        </div>
      </div>
      <button
        type="button"
        className="fx-skip"
        onClick={(e) => {
          e.stopPropagation();
          onSkip?.();
        }}
      >
        結果を見る
      </button>
    </div>
  );
}
