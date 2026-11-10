import { afterEach, describe, expect, it, vi } from "vitest";
import { stripePublicDecision } from "@/lib/payments/stripe-public";
import { productionConfigIssues } from "@/lib/env";

/** 一般のお客さんの Stripe Checkout の受付（ログイン不要）。値はすべて形だけの偽物 */
const GOOD = { paymentProvider: "stripe", stop: null, freeTestEnabled: false, runtimeMode: "test", firestore: true, strongSecret: true } as const;

const STRONG_SECRET = "unit-Xq7#mP2$vL9@wR4!nT6&kB8*hJ3%";
const LOCAL = {
  SESSION_SECRET: STRONG_SECRET,
  SITE_STATUS: "open",
  PAYMENT_PROVIDER: "stripe",
  STRIPE_TEST_CHECKOUT: "on",
  STRIPE_NEW_CHECKOUT: "on",
  STRIPE_SECRET_KEY: "sk_test_unit",
  STRIPE_WEBHOOK_SECRET: "whsec_unit_secret",
  FIRESTORE_EMULATOR_HOST: "127.0.0.1:8080",
  FIREBASE_PROJECT_ID: "demo-stripe-public-unit",
};

function stubAll(e: Record<string, string>) {
  for (const k of ["VERCEL_ENV", "ENABLE_TEST_PAYMENT", "STRIPE_API_BASE", "STRIPE_LIVE_CHECKOUT", "STRIPE_LIVE_OPERATOR_TEST", "STRIPE_NEW_CHECKOUT", "PAYJP_SECRET_KEY", "PAYJP_PUBLIC_KEY", "PAYJP_WEBHOOK_TOKEN", "DB_PROVIDER"]) vi.stubEnv(k, "");
  for (const [k, v] of Object.entries(e)) vi.stubEnv(k, v);
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("一般のお客さんの Stripe 決済の受付（判定）", () => {
  it("PAYMENT_PROVIDER=stripe・公開中・Stripe との接続あり・Firestore・安全な SESSION_SECRET がそろえば受け付ける", () => {
    expect(stripePublicDecision(GOOD)).toEqual({ ok: true, mode: "test" });
  });

  it("1つでも欠けたら受け付けない", () => {
    expect(stripePublicDecision({ ...GOOD, paymentProvider: undefined })).toEqual({ ok: false, reason: "provider_not_stripe" });
    expect(stripePublicDecision({ ...GOOD, paymentProvider: "payjp" })).toEqual({ ok: false, reason: "provider_not_stripe" });
    expect(stripePublicDecision({ ...GOOD, paymentProvider: "mock" })).toEqual({ ok: false, reason: "provider_not_stripe" });
    for (const stop of ["development", "coming_soon", "dangerous_config"] as const) {
      expect(stripePublicDecision({ ...GOOD, stop })).toEqual({ ok: false, reason: "service_stopped" });
    }
    expect(stripePublicDecision({ ...GOOD, freeTestEnabled: true })).toEqual({ ok: false, reason: "free_test_enabled" });
    expect(stripePublicDecision({ ...GOOD, runtimeMode: null })).toEqual({ ok: false, reason: "stripe_unavailable" });
    expect(stripePublicDecision({ ...GOOD, firestore: false })).toEqual({ ok: false, reason: "not_firestore" });
    expect(stripePublicDecision({ ...GOOD, strongSecret: false })).toEqual({ ok: false, reason: "weak_secret" });
  });
});

describe("一般のお客さんの Stripe 決済の受付（環境変数から）", () => {
  async function access(e: Record<string, string>) {
    stubAll(e);
    const m = await import("@/lib/payments/stripe-access");
    return m.stripePublicCheckoutAccess();
  }

  it("ローカルの自動テスト（Emulator の demo- プロジェクト・sk_test_）で公開中なら受け付ける（テストモード）", async () => {
    expect(await access(LOCAL)).toEqual({ ok: true, mode: "test" });
  });

  it("開発モード・準備中・不明な公開状態（live など）では受け付けない", async () => {
    expect(await access({ ...LOCAL, SITE_STATUS: "development" })).toEqual({ ok: false, reason: "service_stopped" });
    expect(await access({ ...LOCAL, SITE_STATUS: "coming_soon" })).toEqual({ ok: false, reason: "service_stopped" });
    expect(await access({ ...LOCAL, SITE_STATUS: "live" })).toEqual({ ok: false, reason: "service_stopped" });
  });

  it("PAYMENT_PROVIDER が stripe 以外・無料テストあり・Stripe のテストのスイッチ無しでは受け付けない", async () => {
    expect(await access({ ...LOCAL, PAYMENT_PROVIDER: "" })).toEqual({ ok: false, reason: "provider_not_stripe" });
    expect(await access({ ...LOCAL, ENABLE_TEST_PAYMENT: "true" })).toEqual({ ok: false, reason: "free_test_enabled" });
    expect(await access({ ...LOCAL, STRIPE_TEST_CHECKOUT: "" })).toEqual({ ok: false, reason: "stripe_unavailable" });
  });

  it("新規の決済の受付を止める（STRIPE_NEW_CHECKOUT が on 以外）と受け付けない。接続は残る（Webhook・定期処理は続く）", async () => {
    for (const v of ["off", "", "yes"]) {
      expect(await access({ ...LOCAL, STRIPE_NEW_CHECKOUT: v }), v).toEqual({ ok: false, reason: "new_checkout_stopped" });
      const m = await import("@/lib/payments/stripe-access");
      expect(m.stripeNewCheckoutState()).toMatchObject({ connection: true, mode: "test", accepting: false });
      expect(m.isStripeNewCheckoutPaused()).toBe(true);
      expect(await m.stripeCheckoutAccess()).toEqual({ ok: false });
      const c = await import("@/lib/payments/stripe-checkout");
      expect(c.stripeRuntime()).toMatchObject({ mode: "test", newCheckout: { ok: false } }); // 接続（Webhook の署名の確認に使う）は作れる
      vi.resetModules();
    }
    expect(stripePublicDecision({ ...GOOD, newCheckoutStopped: true })).toEqual({ ok: false, reason: "new_checkout_stopped" });
  });

  it("本番用のキー・本番決済のスイッチが混ざっていたら受け付けない（テストと本番の取り違え）", async () => {
    expect(await access({ ...LOCAL, STRIPE_SECRET_KEY: "sk_live_unit" })).toEqual({ ok: false, reason: "stripe_unavailable" });
    expect(await access({ ...LOCAL, STRIPE_LIVE_CHECKOUT: "on" })).toEqual({ ok: false, reason: "stripe_unavailable" });
    expect(await access({ ...LOCAL, STRIPE_RESTRICTED_KEY: "rk_live_unit" })).toEqual({ ok: false, reason: "stripe_unavailable" });
  });

  it("PAY.JP は廃止：PAYJP_* や PAYMENT_PROVIDER=payjp が残っていても PAY.JP には切り替えない", async () => {
    // PAYJP_* は読まないので、Stripe の受付には影響しない（PAY.JP へは決して流れない）
    expect(await access({ ...LOCAL, PAYJP_SECRET_KEY: "sk_live_unit_payjp", PAYJP_PUBLIC_KEY: "pk_live_unit", PAYJP_WEBHOOK_TOKEN: "whook_unit" })).toEqual({ ok: true, mode: "test" });
    // PAYMENT_PROVIDER=payjp は「設定なし」：Stripe も疑似決済も使わない
    expect(await access({ ...LOCAL, PAYMENT_PROVIDER: "payjp" })).toEqual({ ok: false, reason: "provider_not_stripe" });
    stubAll({ ...LOCAL, PAYMENT_PROVIDER: "payjp", PAYJP_PUBLIC_KEY: "pk_test_unit", PAYJP_SECRET_KEY: "sk_test_unit_payjp", PAYJP_WEBHOOK_TOKEN: "whook_unit" });
    vi.resetModules();
    const { env } = await import("@/lib/env");
    expect(env().PAYMENT_PROVIDER).toBeNull();
    const payments = await import("@/lib/payments");
    expect(() => payments.activeProvider()).toThrow(payments.PaymentUnavailableError);
    expect(payments.isProviderId("payjp")).toBe(false);
  });

  it("Vercel の本番では、本番決済の条件がそろわなければ受け付けない（テストの接続も本番では使えない）", async () => {
    expect(await access({ ...LOCAL, VERCEL_ENV: "production", FIRESTORE_EMULATOR_HOST: "", FIREBASE_PROJECT_ID: "uranai-b6edf", PRODUCTION_FIREBASE_PROJECT_ID: "uranai-b6edf" })).toMatchObject({ ok: false });
    expect(
      await access({
        ...LOCAL,
        VERCEL_ENV: "production",
        FIRESTORE_EMULATOR_HOST: "",
        FIREBASE_PROJECT_ID: "uranai-b6edf",
        PRODUCTION_FIREBASE_PROJECT_ID: "uranai-b6edf",
        STRIPE_TEST_CHECKOUT: "",
        STRIPE_LIVE_CHECKOUT: "on",
        STRIPE_SECRET_KEY: "sk_live_unit",
      }),
    ).toMatchObject({ ok: false });
  });

  it("PAYMENT_PROVIDER=stripe のときは PAY.JP のキーが残っていても PAY.JP では決済しない", async () => {
    stubAll({ ...LOCAL, PAYJP_PUBLIC_KEY: "pk_test_unit", PAYJP_SECRET_KEY: "sk_test_unit_payjp", PAYJP_WEBHOOK_TOKEN: "whook_unit" });
    const { env } = await import("@/lib/env");
    expect(env().PAYMENT_PROVIDER).toBeNull();
  });

  it("本番で PAYMENT_PROVIDER=stripe：本番決済の設定が不足しているときだけ警告する（「未実装」の古い警告は出さない）", () => {
    const issues = productionConfigIssues({ VERCEL_ENV: "production", PAYMENT_PROVIDER: "stripe", CRON_SECRET: "x" });
    const pp = issues.filter((i) => i.key === "PAYMENT_PROVIDER");
    expect(pp.map((i) => i.level)).toEqual(["warning"]);
    expect(pp[0].message).toBe("Stripe本番決済に必要な設定が不足しています。設定を確認してください（STRIPE_LIVE_CHECKOUT=on が設定されていません）。");
    expect(JSON.stringify(issues)).not.toMatch(/未実装/);
  });
});

describe("PAYMENT_PROVIDER=stripe の警告（B-4）：本番決済の設定の有無だけで判定し、決済の受付・停止は変えない", () => {
  const LIVE_COMPLETE = {
    VERCEL_ENV: "production",
    PAYMENT_PROVIDER: "stripe",
    CRON_SECRET: "x".repeat(32),
    FIREBASE_PROJECT_ID: "uranai-b6edf",
    PRODUCTION_FIREBASE_PROJECT_ID: "uranai-b6edf",
    STRIPE_LIVE_CHECKOUT: "on",
    STRIPE_SECRET_KEY: "sk_live_unit_dummy",
    STRIPE_WEBHOOK_SECRET: "whsec_unit_dummy",
    STRIPE_ACCOUNT_ID: "acct_unitdummy01",
    SITE_STATUS: "development",
    STRIPE_NEW_CHECKOUT: "off",
  };

  it("本番決済の設定がそろっている：PAYMENT_PROVIDER の警告は出さない。公開の停止（development・STRIPE_NEW_CHECKOUT=off）は保たれる", async () => {
    const issues = productionConfigIssues(LIVE_COMPLETE);
    expect(issues.filter((i) => i.key === "PAYMENT_PROVIDER")).toEqual([]);
    const { stripeLiveConfig } = await import("@/lib/payments/stripe-guard");
    const live = stripeLiveConfig(LIVE_COMPLETE);
    expect(live.ok).toBe(true);
    if (live.ok) {
      expect(live.audience).toBeNull(); // 一般のお客さんの決済は受け付けない
      expect(live.newCheckout.ok).toBe(false);
    }
    // 受付の停止は従来どおり表示する（PAYMENT_PROVIDER の警告とは別）
    expect(issues.map((i) => i.key)).toContain("STRIPE_NEW_CHECKOUT");
    // 値（キー）は表示しない
    expect(JSON.stringify(issues)).not.toMatch(/sk_live_unit_dummy|whsec_unit_dummy|acct_unitdummy01/);
  });

  it("本番決済のスイッチがあって条件が欠けている：従来の STRIPE_LIVE_CHECKOUT の error で示し、PAYMENT_PROVIDER の警告は重ねない", () => {
    const issues = productionConfigIssues({ ...LIVE_COMPLETE, STRIPE_SECRET_KEY: "" });
    expect(issues.filter((i) => i.key === "PAYMENT_PROVIDER")).toEqual([]);
    expect(issues.find((i) => i.key === "STRIPE_LIVE_CHECKOUT")).toMatchObject({ level: "error" });
  });

  it("mock・payjp・未設定・Preview・開発環境の判定は従来どおり", () => {
    const prod = { VERCEL_ENV: "production", CRON_SECRET: "x".repeat(32) };
    expect(productionConfigIssues({ ...prod, PAYMENT_PROVIDER: "mock" }).filter((i) => i.key === "PAYMENT_PROVIDER").map((i) => i.level)).toEqual(["error"]);
    expect(productionConfigIssues({ ...prod, PAYMENT_PROVIDER: "payjp" }).map((i) => i.key)).toEqual(["PAYJP_KEYS"]);
    expect(productionConfigIssues(prod)).toEqual([]);
    expect(productionConfigIssues({ VERCEL_ENV: "preview", PAYMENT_PROVIDER: "stripe" })).toEqual([]);
    expect(productionConfigIssues({ PAYMENT_PROVIDER: "stripe" })).toEqual([]);
  });
});
