import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { stripeConfig, stripeLiveConfig, stripeTestConfig, STRIPE_LIVE_DENY_MESSAGE, STRIPE_TEST_DENY_MESSAGE } from "@/lib/payments/stripe-guard";
import { productionConfigIssues } from "@/lib/env";
import { checkProductionEnv } from "@/lib/ops/env-check";

// 環境変数の組み合わせだけを判定する（Stripe・Firebase には接続しない。キーはすべて形だけの偽物）
type E = Record<string, string | undefined>;
const LIVE: E = {
  VERCEL_ENV: "production",
  STRIPE_LIVE_CHECKOUT: "on",
  STRIPE_SECRET_KEY: "sk_live_x",
  STRIPE_WEBHOOK_SECRET: "whsec_live_unit",
  FIREBASE_PROJECT_ID: "uranai-b6edf",
  PRODUCTION_FIREBASE_PROJECT_ID: "uranai-b6edf",
  SITE_STATUS: "open",
};
const PREVIEW: E = {
  VERCEL_ENV: "preview",
  STRIPE_TEST_CHECKOUT: "on",
  STRIPE_SECRET_KEY: "sk_test_unit",
  STRIPE_WEBHOOK_SECRET: "whsec_unit_secret",
  FIREBASE_PROJECT_ID: "uranai-preview",
  STRIPE_TEST_FIREBASE_PROJECT_ID: "uranai-preview",
  PRODUCTION_FIREBASE_PROJECT_ID: "uranai-b6edf",
  FIREBASE_CLIENT_EMAIL: "stripe-test@uranai-preview.iam.gserviceaccount.com",
};
const LOCAL: E = { STRIPE_TEST_CHECKOUT: "on", STRIPE_SECRET_KEY: "sk_test_unit", STRIPE_WEBHOOK_SECRET: "whsec_unit_secret", FIRESTORE_EMULATOR_HOST: "127.0.0.1:8080", FIREBASE_PROJECT_ID: "demo-stripe-unit" };

describe("Stripe の本番（Live）の判定（Production だけ・sk_live_ だけ・uranai-b6edf だけ）", () => {
  it("すべての条件がそろうときだけ有効。公開中は一般のお客さん、開発モードは運営の本番テストのスイッチがあるときだけ運営", () => {
    expect(stripeLiveConfig(LIVE)).toMatchObject({ ok: true, mode: "live", audience: "public" });
    expect(stripeLiveConfig({ ...LIVE, SITE_STATUS: undefined })).toMatchObject({ ok: true, audience: "public" }); // 未設定＝公開中
    expect(stripeLiveConfig({ ...LIVE, SITE_STATUS: "development", STRIPE_LIVE_OPERATOR_TEST: "on" })).toMatchObject({ ok: true, audience: "operator" });
  });

  it("設定の不足・キーの混在・Firebase の接続先の間違い・危険な設定では拒否する", () => {
    const cases: [E, string][] = [
      [{ ...LIVE, VERCEL_ENV: "preview" }, "not_production"],
      [{ ...LIVE, VERCEL_ENV: undefined }, "not_production"],
      [{ ...LIVE, STRIPE_LIVE_CHECKOUT: undefined }, "not_enabled"],
      [{ ...LIVE, STRIPE_LIVE_CHECKOUT: "true" }, "not_enabled"],
      [{ ...LIVE, STRIPE_TEST_CHECKOUT: "on" }, "test_flag_in_production"],
      [{ ...LIVE, STRIPE_API_BASE: "http://127.0.0.1:12111" }, "api_base_not_allowed"],
      [{ ...LIVE, FIRESTORE_EMULATOR_HOST: "127.0.0.1:8080" }, "unsupported_environment"],
      [{ ...LIVE, FIREBASE_PROJECT_ID: "uranai-preview" }, "production_project_mismatch"],
      [{ ...LIVE, FIREBASE_PROJECT_ID: undefined }, "production_project_mismatch"],
      [{ ...LIVE, PRODUCTION_FIREBASE_PROJECT_ID: undefined }, "production_project_mismatch"],
      [{ ...LIVE, FIREBASE_PROJECT_ID: "other", PRODUCTION_FIREBASE_PROJECT_ID: "other" }, "production_project_mismatch"],
      [{ ...LIVE, STRIPE_SECRET_KEY: undefined }, "secret_key_missing"],
      [{ ...LIVE, STRIPE_SECRET_KEY: "sk_test_x" }, "secret_key_not_live"], // テスト用キーの取り違え
      [{ ...LIVE, STRIPE_SECRET_KEY: "rk_live_x" }, "secret_key_not_live"], // 制限付きキーは当面使わない
      [{ ...LIVE, STRIPE_SECRET_KEY: "pk_live_x" }, "secret_key_not_live"],
      [{ ...LIVE, STRIPE_WEBHOOK_SECRET: undefined }, "webhook_secret_missing"],
      [{ ...LIVE, STRIPE_WEBHOOK_SECRET: "secret" }, "webhook_secret_missing"],
      [{ ...LIVE, NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY: "pk_test_x" }, "test_key_present"],
      [{ ...LIVE, STRIPE_PUBLISHABLE_KEY: "pk_test_x" }, "test_key_present"],
      [{ ...LIVE, STRIPE_RESTRICTED_KEY: "rk_test_x" }, "test_key_present"],
      [{ ...LIVE, PAYMENT_PROVIDER: "mock" }, "dangerous_config"],
      [{ ...LIVE, ALLOW_MOCK_PAYMENTS_IN_PRODUCTION: "true" }, "dangerous_config"],
      [{ ...LIVE, ENABLE_TEST_PAYMENT: "true" }, "dangerous_config"],
      [{ ...LIVE, SITE_STATUS: "development" }, "live_not_open"], // 開発モードでは運営の本番テストのスイッチが必要
      [{ ...LIVE, SITE_STATUS: "coming_soon" }, "live_not_open"],
      [{ ...LIVE, SITE_STATUS: "coming_soon", STRIPE_LIVE_OPERATOR_TEST: "on" }, "live_not_open"],
      [{ ...LIVE, SITE_STATUS: "typo" }, "live_not_open"], // 不明な値は準備中扱い
    ];
    for (const [env, reason] of cases) expect(stripeLiveConfig(env), JSON.stringify(env)).toEqual({ ok: false, reason });
  });
});

describe("実行環境でモードが決まる（Production → 本番だけ、Preview・ローカル → テストだけ）", () => {
  it("Production は本番、Preview・ローカルはテスト、それ以外は使えない", () => {
    expect(stripeConfig(LIVE)).toMatchObject({ ok: true, mode: "live", audience: "public" });
    expect(stripeConfig(PREVIEW)).toMatchObject({ ok: true, mode: "test", runtime: "preview", apiBase: null });
    expect(stripeConfig(LOCAL)).toMatchObject({ ok: true, mode: "test", runtime: "local" });
    expect(stripeConfig({ ...PREVIEW, VERCEL_ENV: "development" })).toEqual({ ok: false, mode: "none", reason: "unsupported_environment" });
  });

  it("Production にテストの設定を入れても、Preview に本番の設定を入れても使えない", () => {
    // Production にテストの設定（sk_test_・STRIPE_TEST_CHECKOUT）だけ → 本番の判定で拒否。テスト決済にもならない
    expect(stripeConfig({ ...PREVIEW, VERCEL_ENV: "production" })).toEqual({ ok: false, mode: "live", reason: "not_enabled" });
    expect(stripeConfig({ ...LIVE, STRIPE_SECRET_KEY: "sk_test_x" })).toEqual({ ok: false, mode: "live", reason: "secret_key_not_live" });
    // Preview に本番用キー・本番のスイッチ → テストの判定で拒否。本番決済にもならない
    expect(stripeConfig({ ...PREVIEW, STRIPE_SECRET_KEY: "sk_live_x" })).toEqual({ ok: false, mode: "test", reason: "secret_key_not_test" });
    expect(stripeConfig({ ...PREVIEW, NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY: "pk_live_x" })).toEqual({ ok: false, mode: "test", reason: "live_key_present" });
    expect(stripeConfig({ ...PREVIEW, STRIPE_LIVE_CHECKOUT: "on" })).toEqual({ ok: false, mode: "test", reason: "live_flag_in_test" });
    expect(stripeConfig({ ...LIVE, VERCEL_ENV: "preview" })).toMatchObject({ ok: false, mode: "test" });
  });
});

describe("テスト（Sandbox）の判定の追加の条件", () => {
  it("Preview は Firebase の uranai-preview だけ。本番のスイッチがテストの環境にあれば拒否", () => {
    expect(stripeTestConfig(PREVIEW)).toMatchObject({ ok: true, mode: "preview" });
    expect(stripeTestConfig({ ...PREVIEW, FIREBASE_PROJECT_ID: "uranai-staging", STRIPE_TEST_FIREBASE_PROJECT_ID: "uranai-staging" })).toEqual({ ok: false, reason: "preview_project_mismatch" });
    expect(stripeTestConfig({ ...PREVIEW, STRIPE_LIVE_CHECKOUT: "on" })).toEqual({ ok: false, reason: "live_flag_in_test" });
    expect(stripeTestConfig({ ...PREVIEW, STRIPE_LIVE_OPERATOR_TEST: "on" })).toEqual({ ok: false, reason: "live_flag_in_test" });
    expect(stripeTestConfig({ ...LOCAL, STRIPE_LIVE_CHECKOUT: "on" })).toEqual({ ok: false, reason: "live_flag_in_test" });
  });

  it("本番決済はまだ有効にしない：本番の条件がそろっていても、決済の処理が使うテストの判定は拒否する", () => {
    expect(stripeLiveConfig(LIVE).ok).toBe(true);
    expect(stripeTestConfig(LIVE)).toEqual({ ok: false, reason: "not_enabled" });
    expect(stripeTestConfig({ ...LIVE, STRIPE_TEST_CHECKOUT: "on" })).toEqual({ ok: false, reason: "production" });
  });

  it("拒否の理由には、すべて説明の文がある（値は含めない）", () => {
    for (const m of [...Object.values(STRIPE_TEST_DENY_MESSAGE), ...Object.values(STRIPE_LIVE_DENY_MESSAGE)]) {
      expect(m.length).toBeGreaterThan(5);
      expect(m).not.toMatch(/sk_live_[A-Za-z0-9]|whsec_[A-Za-z0-9]/);
    }
  });

  it("決済の処理（API・画面・Webhook）はまだ本番の判定を使っていない", () => {
    const files: string[] = [];
    const walk = (d: string) => {
      for (const f of readdirSync(d)) {
        const p = path.join(d, f);
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.(ts|tsx)$/.test(f)) files.push(p);
      }
    };
    const src = path.resolve(__dirname, "..", "src");
    walk(src);
    const allowed = new Set(["lib/payments/stripe-guard.ts", "lib/env.ts", "lib/ops/env-check.ts"].map((f) => path.join(src, f)));
    const users = files.filter((f) => !allowed.has(f) && /\bstripe(Live)?Config\(/.test(readFileSync(f, "utf8")));
    expect(users.map((f) => path.relative(src, f))).toEqual([]);
  });
});

describe("本番の設定の確認（/api/health・check:env）：本番決済のスイッチがあるときに条件を確かめる（値は出さない）", () => {
  it("条件がそろわなければ error（理由だけ）。そろっていれば「未実装」の warning", () => {
    const bad = productionConfigIssues({ ...LIVE, STRIPE_SECRET_KEY: "sk_test_SECRETVALUE", CRON_SECRET: "x".repeat(32) });
    expect(bad.find((i) => i.key === "STRIPE_LIVE_CHECKOUT")).toMatchObject({ level: "error" });
    expect(JSON.stringify(bad)).not.toContain("SECRETVALUE");
    const good = productionConfigIssues({ ...LIVE, CRON_SECRET: "x".repeat(32) });
    expect(good.find((i) => i.key === "STRIPE_LIVE_CHECKOUT")).toMatchObject({ level: "warning" });
    expect(productionConfigIssues({ VERCEL_ENV: "production", CRON_SECRET: "x".repeat(32) }).some((i) => i.key === "STRIPE_LIVE_CHECKOUT")).toBe(false);

    const cli = checkProductionEnv({ ...LIVE, FIREBASE_PROJECT_ID: "uranai-preview", STRIPE_SECRET_KEY: "sk_live_SECRETVALUE" });
    expect(cli.find((r) => r.key === "STRIPE_LIVE_CHECKOUT")).toMatchObject({ level: "error" });
    expect(JSON.stringify(cli)).not.toContain("SECRETVALUE");
  });
});
