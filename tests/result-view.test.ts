import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ResultView } from "@/components/public/result-view";
import type { LegacyFortuneResult } from "@/lib/db/schema";
import { generateBirthday } from "@/lib/fortune/birthday-fortune";
import { generateBlood } from "@/lib/fortune/blood-fortune";
import { generateZodiac } from "@/lib/fortune/zodiac-fortune";
import { shareSummary } from "@/lib/fortune/share";

/** 以前の血液型占い（旧形式・v なし）で保存された結果の例 */
const legacyBlood: LegacyFortuneResult = {
  title: "今日の運勢",
  subject: "A型のあなた",
  dateLabel: "2026-10-05",
  overall: { stars: 3, comment: "良くも悪くも平穏な一日。" },
  love: { stars: 2, comment: "期待しすぎると疲れてしまいそう。" },
  work: { stars: 1, comment: "今日は守りに徹して吉。" },
  money: { stars: 1, comment: "今日は現金を多めに持ち歩かないのが吉。" },
  health: { stars: 4, comment: "体調は良好。" },
  luckyColor: { name: "ローズピンク", hex: "#e08aa5" },
  luckyItem: "季節の花",
  luckyNumber: 3,
  luckyTime: "17:00〜19:00",
  message: "焦らず一歩ずつ進むことで、思わぬチャンスが見えてきそう。",
  advice: "開運アクション：コップ1杯の水をゆっくり飲む",
  traits: "几帳面で思いやりのあるA型さん。",
};

const html = (r: Parameters<typeof ResultView>[0]["result"]) => renderToStaticMarkup(createElement(ResultView, { result: r }));

describe("結果画面の表示（旧形式との互換）", () => {
  it("旧形式の血液型占いの結果を、新方式で作り直さずそのまま表示できる", () => {
    const out = html(legacyBlood);
    expect(out).toContain("A型のあなた");
    expect(out).toContain("ラッキーナンバー");
    expect(out).toContain("コップ1杯の水をゆっくり飲む");
    expect(out).not.toContain("今日の運勢レア度"); // 旧結果にはレア度が無い → カードを出さない
    expect(shareSummary(legacyBlood, "血液型占い")).toContain("ラッキーアイテムは「季節の花」");
  });

  it("血液型占い v2 はタイプ名・相性・レア度を表示する", () => {
    const r = generateBlood("AB", 9, { now: new Date("2026-10-07T20:00:00+09:00"), purchaseSeed: "view" });
    const out = html(r);
    for (const w of ["今日の運勢レア度", r.rarity.en, "月見の調停役", r.typeCatch, "今日うまくいく行動", "今日気をつけたいこと", "今日相性のいい血液型", "ラッキーナンバー", "今日の一言"]) {
      expect(out, w).toContain(w);
    }
    expect(shareSummary(r, "血液型占い")).toContain("月見の調停役");
  });

  it("12星座占い v2 も引き続き表示できる", () => {
    const r = generateZodiac("leo", { now: new Date("2026-10-07T20:00:00+09:00"), purchaseSeed: "view" });
    const out = html(r);
    expect(out).toContain("今日の12星座ランキング");
    expect(out).toContain(r.rarity.en);
  });

  it("旧形式の生年月日占いの結果を、そのまま表示できる", () => {
    const legacyBirthday: LegacyFortuneResult = {
      ...legacyBlood,
      subject: "獅子座 × 誕生数33",
      highlight: "火のエレメント・獅子座",
      traits: "誕生数33：無償の愛のマスターナンバー。",
    };
    const out = html(legacyBirthday);
    expect(out).toContain("獅子座 × 誕生数33");
    expect(out).toContain("火のエレメント・獅子座");
    expect(out).not.toContain("あなたを表す3つのサイン");
  });

  it("生年月日占い v2 は3つのサイン・基本タイプ・今日のテーマを表示し、生年月日そのものは表示しない", () => {
    const r = generateBirthday("1990-05-12", { now: new Date("2026-10-07T20:00:00+09:00"), purchaseSeed: "view" });
    const out = html(r);
    for (const w of ["今日の運勢レア度", "あなたを表す3つのサイン", "牡牛座", "誕生数", "今日のナンバー", "あなたの基本タイプ", r.typeName, "あなたの強み", "気をつけたいところ", "今日のテーマ", "今日起こりやすいこと", "今日おすすめの行動", "今日気をつけたいこと", "ラッキーナンバー", "あなたへの一言"]) {
      expect(out, w).toContain(w);
    }
    expect(out).not.toContain("1990-05-12");
    expect(out).not.toContain("5月12日");
    expect(shareSummary(r, "生年月日占い")).toContain("牡牛座×誕生数9");
  });
});
