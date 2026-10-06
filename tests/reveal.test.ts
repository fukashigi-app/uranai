import { readFileSync } from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { FortuneResult } from "@/components/public/fortune-result";
import type { FortuneResultData, LegacyFortuneResult } from "@/lib/db/schema";
import { birthdaySubject, generateBirthday } from "@/lib/fortune/birthday-fortune";
import { bloodSubject, generateBlood } from "@/lib/fortune/blood-fortune";
import { standardDay } from "@/lib/fortune/day-stars";
import { REVEAL_FADE_MS, REVEAL_TIMING, revealReducer, revealStorageKey, starField } from "@/lib/fortune/reveal";
import { RARITY_KEYS, type RarityKey } from "@/lib/fortune/types";
import { generateZodiac, zodiacDay } from "@/lib/fortune/zodiac-fortune";
import type { RevealMode } from "@/components/public/reveal-stage";
import { jstDateString } from "@/lib/time";

const BASE = Date.UTC(2026, 0, 1, 3);
const dateAt = (i: number) => jstDateString(new Date(BASE + i * 86_400_000));
const at20 = (date: string) => new Date(`${date}T20:00:00+09:00`);
const BIRTHS = Array.from({ length: 120 }, (_, i) => jstDateString(new Date(Date.UTC(1960, 0, 1) + i * 211 * 86_400_000)));

/** 指定のレア度になる本物の結果（占い生成ロジックはそのまま使う） */
function example(kind: "ZODIAC" | "BLOOD" | "BIRTHDAY", want: RarityKey): FortuneResultData {
  for (let i = 0; i < 3000; i++) {
    const date = dateAt(i);
    if (kind === "ZODIAC") {
      const hit = zodiacDay(date).find((d) => d.rarity === want);
      if (hit) return generateZodiac(hit.key, { now: at20(date), purchaseSeed: "t" });
    } else if (kind === "BLOOD") {
      for (const bt of ["A", "B", "O", "AB"] as const)
        for (let m = 1; m <= 12; m++) if (standardDay(date, bloodSubject(bt, m)).rarity === want) return generateBlood(bt, m, { now: at20(date), purchaseSeed: "t" });
    } else {
      for (const b of BIRTHS) if (standardDay(date, birthdaySubject(b)).rarity === want) return generateBirthday(b, { now: at20(date), purchaseSeed: "t" });
    }
  }
  throw new Error("not found");
}

const render = (result: FortuneResultData, mode: RevealMode = "auto") => renderToStaticMarkup(createElement(FortuneResult, { result, mode }));
const count = (html: string, needle: string) => html.split(needle).length - 1;
/** 演出画面の部分だけ */
const overlayOf = (html: string) => {
  const start = html.indexOf('data-fx="reveal"');
  const end = html.indexOf('class="fx-body');
  return start >= 0 ? html.slice(start, end) : "";
};

const KINDS = ["ZODIAC", "BLOOD", "BIRTHDAY"] as const;
const SPECIFIC_UI = { ZODIAC: "今日の12星座ランキング", BLOOD: "あなたのタイプ", BIRTHDAY: "あなたを表す3つのサイン" };

describe("結果表示の演出：3種類すべて同じ演出を使い、各占い専用の画面を維持する", () => {
  for (const kind of KINDS) {
    it(`${kind}：初回は演出画面＋結果本文（専用UI）`, () => {
      const html = render(example(kind, "HALF_MOON"));
      expect(html).toContain('data-fx="reveal"');
      expect(html).toContain("今日の運勢レア度");
      expect(html).toContain(SPECIFIC_UI[kind]);
    });
  }

  it("5つのレア度で正しい月を表示する（新月=1 … 満月=4・奇跡の星夜=5）", () => {
    const level: Record<RarityKey, number> = { NEW_MOON: 1, CRESCENT: 2, HALF_MOON: 3, FULL_MOON: 4, MIRACLE: 5 };
    for (const kind of KINDS) {
      for (const k of RARITY_KEYS) {
        const html = render(example(kind, k));
        expect(overlayOf(html), `${kind} ${k}`).toContain(`data-moon-level="${level[k]}"`);
        expect(overlayOf(html)).toContain(`data-fx-tier="${k}"`);
      }
    }
  });

  it("流れ星は奇跡の星夜だけ（2〜3本）", () => {
    for (const kind of KINDS) {
      for (const k of RARITY_KEYS) {
        const n = count(overlayOf(render(example(kind, k))), "data-fx-shooting");
        if (k === "MIRACLE") expect(n).toBeGreaterThanOrEqual(2);
        if (k === "MIRACLE") expect(n).toBeLessThanOrEqual(3);
        else expect(n, `${kind} ${k}`).toBe(0);
      }
    }
  });

  it("満月と奇跡の星夜は見た目が区別される（満月=光の横切り / 奇跡の星夜=流れ星・金色の光・星座の背景）", () => {
    const full = render(example("ZODIAC", "FULL_MOON"));
    const miracle = render(example("ZODIAC", "MIRACLE"));
    expect(full).toContain("fx-tier-full");
    expect(full).toContain("rarity-sweep");
    expect(full).not.toContain("fx-goldlight");
    expect(full).not.toContain("<polyline");
    expect(miracle).toContain("fx-tier-miracle");
    expect(miracle).toContain("fx-goldlight");
    expect(miracle).toContain("<polyline"); // 星座を思わせる背景（演出後も残る）
    expect(miracle).not.toContain("rarity-sweep");
  });

  it("新月はハズレ表現にしない（「整える日」として表示）", () => {
    for (const kind of KINDS) {
      const html = render(example(kind, "NEW_MOON"));
      expect(overlayOf(html)).toContain("整える日");
      for (const w of ["ハズレ", "はずれ", "凶", "残念", "最悪"]) expect(html.includes(w), w).toBe(false);
    }
  });

  it("星や粒の数は控えめ（通常15個まで・満月20個まで・奇跡の星夜40個まで）", () => {
    const limit: Record<RarityKey, number> = { NEW_MOON: 15, CRESCENT: 15, HALF_MOON: 15, FULL_MOON: 20, MIRACLE: 40 };
    for (const kind of KINDS) {
      for (const k of RARITY_KEYS) {
        const html = render(example(kind, k));
        const n = count(html, "data-fx-star") + count(html, "data-fx-shooting") + count(html, "rarity-particle") + count(html, "rarity-twinkle");
        expect(n, `${kind} ${k}: ${n}`).toBeLessThanOrEqual(limit[k]);
      }
    }
  });

  it("装飾（星・流れ星・光・月）は aria-hidden。「結果を見る」ボタンは読み上げ対象", () => {
    const html = render(example("BIRTHDAY", "MIRACLE"));
    const overlay = overlayOf(html);
    const sky = overlay.slice(overlay.indexOf('class="fx-sky"'));
    expect(overlay).toMatch(/class="fx-sky" aria-hidden="true"/);
    const skyEnd = sky.indexOf('class="fx-skip"');
    expect(sky.slice(0, skyEnd)).toContain("data-fx-star");
    expect(sky.slice(0, skyEnd)).toContain("data-fx-shooting");
    expect(overlay).toMatch(/<button type="button" class="fx-skip">結果を見る<\/button>/);
    // 結果カードの装飾も読み上げない。レア度は文字でも表示する
    expect(html).toContain('aria-label="今日の運勢レア度 MIRACLE｜奇跡の星夜"');
    expect(html).toMatch(/<svg class="pointer-events-none absolute inset-0[^"]*"[^>]*aria-hidden="true"/);
  });
});

describe("演出の状態（スキップ・完成状態・動きを減らす設定）", () => {
  it("スキップ・終了・見たことがある・動きを減らす設定 → すぐ完成状態", () => {
    for (const a of ["skip", "finish", "already-seen", "reduced-motion"] as const) expect(revealReducer("play", a)).toBe("done");
    expect(revealReducer("init", "skip")).toBe("done");
    expect(revealReducer("done", "replay")).toBe("play");
  });

  it("完成状態（final）では演出画面を出さず、本文をすぐ表示する", () => {
    const html = render(example("BLOOD", "MIRACLE"), "final");
    expect(html).not.toContain('data-fx="reveal"');
    expect(html).toContain("fx-body fx-body-instant");
    expect(html).toContain("MIRACLE"); // 完成状態でもレア度は結果カードに残る
  });

  it("動きを減らす設定（reduced）では演出画面を出さず、アニメーションを止めるクラスを付ける", () => {
    const html = render(example("ZODIAC", "MIRACLE"), "reduced");
    expect(html).not.toContain('data-fx="reveal"');
    expect(html).toContain("fx-force-reduced");
  });

  it("CSS：prefers-reduced-motion で演出画面・流れ星・光の横切り・粒子を止める", () => {
    const css = readFileSync(path.resolve(__dirname, "../src/app/globals.css"), "utf8");
    const block = css.slice(css.indexOf("/* 動きを減らす設定"), css.indexOf(".fx-force-reduced .fx-body"));
    expect(block).toContain("@media (prefers-reduced-motion: reduce)");
    expect(block).toMatch(/\.fx-reveal-overlay \{ display: none; \}/);
    expect(block).toMatch(/\.rarity-sweep, \.rarity-particle \{ display: none; \}/);
    expect(block).toMatch(/animation: none !important/);
    // 一度見た結果の再表示では演出画面を出さない（サーバー描画直後でも）
    expect(css).toMatch(/html\[data-fx-skip\] \.fx-reveal-overlay \{ display: none; \}/);
  });

  it("演出時間：通常2.1秒以内・満月2.5秒以内・奇跡の星夜3.1秒以内", () => {
    const total = (k: RarityKey) => REVEAL_TIMING[k].out + REVEAL_FADE_MS;
    for (const k of ["NEW_MOON", "CRESCENT", "HALF_MOON"] as const) expect(total(k)).toBeLessThanOrEqual(2100);
    expect(total("FULL_MOON")).toBeLessThanOrEqual(2500);
    expect(total("MIRACLE")).toBeLessThanOrEqual(3100);
    expect(total("MIRACLE")).toBeGreaterThanOrEqual(2000);
  });

  it("星の位置は結果ごとに少し変わり、同じ結果なら毎回同じ。中央の文字には重ならない", () => {
    expect(starField("a", 24)).toEqual(starField("a", 24));
    expect(starField("a", 24)).not.toEqual(starField("b", 24));
    for (const s of starField("c", 40)) expect(s.x > 22 && s.x < 78 && s.y > 30 && s.y < 72).toBe(false);
  });
});

describe("保存済みの結果との関係", () => {
  const legacy: LegacyFortuneResult = {
    title: "今日の運勢",
    subject: "獅子座 × 誕生数33",
    dateLabel: "2026-10-05",
    overall: { stars: 3, comment: "穏やかな一日。" },
    love: { stars: 2, comment: "a" },
    work: { stars: 1, comment: "b" },
    money: { stars: 1, comment: "c" },
    luckyColor: { name: "ローズピンク", hex: "#e08aa5" },
    luckyItem: "季節の花",
    luckyNumber: 3,
    luckyTime: "17:00〜19:00",
    message: "m",
    advice: "開運アクション：水を飲む",
  };

  it("旧形式の保存結果（レア度なし）は演出なしでそのまま表示し、エラーにならない", () => {
    expect(revealStorageKey(legacy)).toBeNull();
    const html = render(legacy);
    expect(html).not.toContain('data-fx="reveal"');
    expect(html).toContain("獅子座 × 誕生数33");
    expect(html).not.toContain("演出をもう一度見る");
  });

  it("演出は結果データを変更しない（凍結した結果をそのまま表示できる）", () => {
    const deepFreeze = <T,>(o: T): T => {
      if (o && typeof o === "object") {
        Object.values(o).forEach(deepFreeze);
        Object.freeze(o);
      }
      return o;
    };
    for (const kind of KINDS) {
      const r = example(kind, "MIRACLE");
      const before = JSON.stringify(r);
      deepFreeze(r);
      for (const mode of ["auto", "intro", "final", "reduced"] as const) render(r, mode);
      expect(JSON.stringify(r)).toBe(before);
    }
  });

  it("「見た」印のキーは結果ごとに異なり、結果の中身は含まない", () => {
    const a = example("ZODIAC", "MIRACLE");
    const b = generateZodiac("leo", { now: new Date("2026-10-07T20:00:00+09:00"), purchaseSeed: "z" });
    expect(revealStorageKey(a)).not.toBe(revealStorageKey(b));
    expect(revealStorageKey(b)).toBe(`fx-reveal:ZODIAC:${b.generatedAt}`);
  });
});
