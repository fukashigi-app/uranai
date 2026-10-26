import { describe, expect, it } from "vitest";
import { stripeReturnOrigin } from "@/lib/payments/stripe-return-origin";

// Vercel の Preview の例（デプロイ固有の URL とブランチの固定 URL）
const DEPLOY = "uranai-nfa02ju1q-fukashigi-apps-projects.vercel.app";
const BRANCH = "uranai-git-feature-stripe-checkout-fukashigi-apps-projects.vercel.app";
const APP = `https://${BRANCH}`;
const ENV = { VERCEL_URL: DEPLOY, VERCEL_BRANCH_URL: BRANCH };
const pick = (origin: string | null, env: Record<string, string | undefined> = ENV, mode: "preview" | "local" = "preview", app = APP) => stripeReturnOrigin(origin, app, mode, env);

describe("Stripe Checkout の戻り先（決済を始めたドメイン。許可リストで確認）", () => {
  it("このデプロイ自身の URL（デプロイ固有・ブランチの固定・APP_URL）なら、そのドメインに戻す", () => {
    expect(pick(`https://${DEPLOY}`)).toBe(`https://${DEPLOY}`);
    expect(pick(`https://${BRANCH}`)).toBe(`https://${BRANCH}`);
    expect(pick("https://uranai.example.jp", ENV, "preview", "https://uranai.example.jp/")).toBe("https://uranai.example.jp");
    expect(pick(`https://${DEPLOY.toUpperCase()}`)).toBe(`https://${DEPLOY}`); // 大文字は小文字にそろえる
    expect(pick(`https://${DEPLOY}`, { VERCEL_URL: `https://${DEPLOY}/` })).toBe(`https://${DEPLOY}`); // 環境変数の形の違い
  });

  it("許可リストに無い・形が正しくない Origin は使わず、公開URL（APP_URL）に戻す", () => {
    for (const o of [
      "https://evil.example",
      "https://uranai-other-project.vercel.app", // vercel.app の別のプロジェクト
      `https://${DEPLOY}.evil.example`,
      `https://evil.example/${DEPLOY}`,
      `https://${DEPLOY}/payment`, // パス付き
      `https://user:pass@${DEPLOY}`,
      `http://${DEPLOY}`, // Preview では http を使わない
      `https://${DEPLOY}:8443`, // ポートが違う
      "null",
      "",
      `javascript://${DEPLOY}`,
      ` https://${DEPLOY}\nhttps://evil.example`,
    ]) {
      expect(pick(o), o).toBe(APP);
    }
    expect(pick(null)).toBe(APP);
  });

  it("Vercel の環境変数が無ければ APP_URL だけを許可する", () => {
    expect(pick(`https://${DEPLOY}`, {})).toBe(APP);
    expect(pick(APP, {})).toBe(APP);
  });

  it("http の localhost・127.0.0.1 はローカルの自動テストだけ", () => {
    expect(pick("http://127.0.0.1:3000", {}, "local", "http://localhost:3000")).toBe("http://127.0.0.1:3000");
    expect(pick("http://localhost:3000", {}, "local", "http://localhost:3000")).toBe("http://localhost:3000");
    expect(pick("http://127.0.0.1:3000", ENV, "preview")).toBe(APP);
    expect(pick("http://evil.example:3000", {}, "local", "http://localhost:3000")).toBe("http://localhost:3000");
  });
});
