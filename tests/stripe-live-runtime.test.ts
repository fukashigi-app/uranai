import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Stripe の本番（Live）の接続を、実際の決済の処理が使うようにした部分の単体テスト。
 * Stripe・Firebase には接続しない（キー・アカウントの ID はすべて形だけの偽物。Stripe の SDK の呼び出しは偽物の client で置き換える）。
 */
const auth = vi.hoisted(() => ({ user: null as null | { id: string; role: "OPERATOR" | "STORE" } }));
vi.mock("@/lib/auth/session", () => ({
  getSessionUser: async () => auth.user,
  currentSessionHash: async () => (auth.user ? "hash" : null),
}));

const STRONG_SECRET = "unit-Xq7#mP2$vL9@wR4!nT6&kB8*hJ3%";
const KEYS = [
  "VERCEL_ENV",
  "SITE_STATUS",
  "PAYMENT_PROVIDER",
  "ENABLE_TEST_PAYMENT",
  "ALLOW_MOCK_PAYMENTS_IN_PRODUCTION",
  "STRIPE_TEST_CHECKOUT",
  "STRIPE_LIVE_CHECKOUT",
  "STRIPE_NEW_CHECKOUT",
  "STRIPE_LIVE_OPERATOR_TEST",
  "STRIPE_SECRET_KEY",
  "STRIPE_WEBHOOK_SECRET",
  "STRIPE_ACCOUNT_ID",
  "STRIPE_API_BASE",
  "STRIPE_PUBLISHABLE_KEY",
  "NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY",
  "STRIPE_RESTRICTED_KEY",
  "STRIPE_TEST_FIREBASE_PROJECT_ID",
  "FIREBASE_PROJECT_ID",
  "PRODUCTION_FIREBASE_PROJECT_ID",
  "FIRESTORE_EMULATOR_HOST",
  "DB_PROVIDER",
  "SESSION_SECRET",
  "FIREBASE_CLIENT_EMAIL",
  "VERCEL_GIT_COMMIT_REF",
] as const;
const LIVE_PUBLIC: Record<string, string> = {
  VERCEL_ENV: "production",
  SITE_STATUS: "open",
  PAYMENT_PROVIDER: "stripe",
  STRIPE_LIVE_CHECKOUT: "on",
  STRIPE_NEW_CHECKOUT: "on",
  STRIPE_SECRET_KEY: "sk_live_unit_fake",
  STRIPE_WEBHOOK_SECRET: "whsec_unit_live_fake",
  STRIPE_ACCOUNT_ID: "acct_unitLive123",
  FIREBASE_PROJECT_ID: "uranai-b6edf",
  PRODUCTION_FIREBASE_PROJECT_ID: "uranai-b6edf",
  DB_PROVIDER: "firestore",
  SESSION_SECRET: STRONG_SECRET,
};
const LIVE_OPERATOR = { ...LIVE_PUBLIC, SITE_STATUS: "development", STRIPE_LIVE_OPERATOR_TEST: "on" };
const PREVIEW: Record<string, string> = {
  VERCEL_ENV: "preview",
  VERCEL_GIT_COMMIT_REF: "preview/stripe-verification",
  SITE_STATUS: "open",
  PAYMENT_PROVIDER: "stripe",
  STRIPE_TEST_CHECKOUT: "on",
  STRIPE_NEW_CHECKOUT: "on",
  STRIPE_SECRET_KEY: "sk_test_unit_fake",
  STRIPE_WEBHOOK_SECRET: "whsec_unit_test_fake",
  FIREBASE_PROJECT_ID: "uranai-preview",
  STRIPE_TEST_FIREBASE_PROJECT_ID: "uranai-preview",
  PRODUCTION_FIREBASE_PROJECT_ID: "uranai-b6edf",
  FIREBASE_CLIENT_EMAIL: "stripe-test@uranai-preview.iam.gserviceaccount.com",
  DB_PROVIDER: "firestore",
  SESSION_SECRET: STRONG_SECRET,
};

function stub(e: Record<string, string>) {
  for (const k of KEYS) vi.stubEnv(k, "");
  for (const [k, v] of Object.entries(e)) vi.stubEnv(k, v);
}
afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
  auth.user = null;
});

describe("決済の処理の接続（stripeRuntime）：Production は本番、Preview はテスト", () => {
  it("Production で本番の条件がそろえば本番の接続（http の戻り先は許さない・アカウントと受け付ける相手を持つ）", async () => {
    stub(LIVE_PUBLIC);
    const { stripeRuntime } = await import("@/lib/payments/stripe-checkout");
    const rt = stripeRuntime();
    expect([rt.mode, rt.allowHttpOrigin, rt.accountId, rt.liveAudience]).toEqual(["live", false, "acct_unitLive123", "public"]);
    expect(stripeRuntime()).toBe(rt); // 同じ設定なら同じ接続
    stub(LIVE_OPERATOR);
    expect(stripeRuntime().liveAudience).toBe("operator");
  });

  it("Preview はテストの接続のまま（アカウントの確認なし）。本番のスイッチ・本番用キーが混ざれば使えない", async () => {
    stub(PREVIEW);
    const { stripeRuntime } = await import("@/lib/payments/stripe-checkout");
    const rt = stripeRuntime();
    expect([rt.mode, rt.accountId, rt.liveAudience]).toEqual(["test", undefined, undefined]);
    for (const extra of [{ STRIPE_LIVE_CHECKOUT: "on" }, { STRIPE_SECRET_KEY: "sk_live_unit_fake" }, { STRIPE_LIVE_OPERATOR_TEST: "on" }] as Record<string, string>[]) {
      stub({ ...PREVIEW, ...extra });
      expect(() => stripeRuntime(), JSON.stringify(extra)).toThrow(/Stripe checkout is not available/);
    }
  });

  it("Production の設定の不足・テストの設定の混在は fail-closed（例外。決済・Webhook・定期処理を受け付けない）", async () => {
    const { stripeRuntime } = await import("@/lib/payments/stripe-checkout");
    const bad: Record<string, string>[] = [
      { ...LIVE_PUBLIC, STRIPE_LIVE_CHECKOUT: "" },
      { ...LIVE_PUBLIC, STRIPE_SECRET_KEY: "sk_test_unit_fake" },
      { ...LIVE_PUBLIC, STRIPE_SECRET_KEY: "rk_live_unit_fake" },
      { ...LIVE_PUBLIC, STRIPE_ACCOUNT_ID: "" },
      { ...LIVE_PUBLIC, STRIPE_TEST_CHECKOUT: "on" },
      { ...LIVE_PUBLIC, STRIPE_API_BASE: "http://127.0.0.1:12111" },
      { ...LIVE_PUBLIC, NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY: "pk_test_unit_fake" },
      { ...LIVE_PUBLIC, FIREBASE_PROJECT_ID: "uranai-preview" },
      { ...LIVE_PUBLIC, FIRESTORE_EMULATOR_HOST: "127.0.0.1:8080" },
      { ...PREVIEW, VERCEL_ENV: "production" }, // Production にテストの設定だけ
    ];
    for (const e of bad) {
      stub(e);
      expect(() => stripeRuntime(), JSON.stringify(e)).toThrow(/Stripe checkout is not available/);
    }
  });

  it("新規の決済の受付だけを止める設定では、本番の接続は作り（Webhook・定期処理・運営の操作に使う）、新規の決済は受け付けない", async () => {
    const stopped: [Record<string, string>, string][] = [
      [{ ...LIVE_PUBLIC, STRIPE_NEW_CHECKOUT: "off" }, "new_checkout_off"],
      [{ ...LIVE_PUBLIC, STRIPE_NEW_CHECKOUT: "" }, "new_checkout_not_set"],
      [{ ...LIVE_PUBLIC, STRIPE_NEW_CHECKOUT: "yes" }, "new_checkout_invalid"],
      [{ ...LIVE_PUBLIC, SITE_STATUS: "development" }, "live_not_open"], // 運営テストのスイッチ無しの開発モード
      [{ ...LIVE_PUBLIC, SITE_STATUS: "coming_soon" }, "live_not_open"],
      [{ ...LIVE_PUBLIC, STRIPE_LIVE_OPERATOR_TEST: "on" }, "operator_test_while_open"], // 公開中に運営テストのスイッチが残っている
    ];
    for (const [e, reason] of stopped) {
      stub(e);
      vi.resetModules();
      const m = await import("@/lib/payments/stripe-checkout");
      const a = await import("@/lib/payments/stripe-access");
      const rt = m.stripeRuntime();
      expect(rt, JSON.stringify(e)).toMatchObject({ mode: "live", webhookSecret: "whsec_unit_live_fake", accountId: "acct_unitLive123", newCheckout: { ok: false, reason } });
      expect(rt.liveAudience).toBeUndefined();
      expect(m.acceptsNewCheckout(rt)).toBe(false);
      expect(await a.stripeCheckoutAccess()).toEqual({ ok: false });
      expect(a.stripeNewCheckoutState()).toEqual({ connection: true, mode: "live", accepting: false, reason });
      // Stripe API を呼ばずに止める（模擬の接続を使わない。呼べば実際の Stripe への接続になるので、例外の種類で確かめる）
      await expect(m.createStripeCheckoutSession({ checkoutId: "co_unit", storeId: "st_unit", fortuneType: "ZODIAC", productName: "x", origin: "https://example.test", expiresAt: new Date(Date.now() + 40 * 60_000) }, rt)).rejects.toBeInstanceOf(m.StripeNewCheckoutStoppedError);
    }
  });
});

describe("キーのアカウントの確認（ensureStripeAccount）", () => {
  const client = (id: string | Error) => {
    const retrieveCurrent = vi.fn(async () => {
      if (id instanceof Error) throw id;
      return { id };
    });
    return { accounts: { retrieveCurrent } } as unknown as import("stripe").default & { accounts: { retrieveCurrent: typeof retrieveCurrent } };
  };

  it("設定したアカウントのキーなら通す（同じ接続では1回だけ確かめる）", async () => {
    const { ensureStripeAccount } = await import("@/lib/payments/stripe-checkout");
    const c = client("acct_unitLive123");
    await ensureStripeAccount({ client: c, accountId: "acct_unitLive123" });
    await ensureStripeAccount({ client: c, accountId: "acct_unitLive123" });
    expect(c.accounts.retrieveCurrent).toHaveBeenCalledTimes(1);
  });

  it("別のアカウントのキーなら拒否（毎回確かめ直す）。Stripe API の失敗も拒否（覚えずに次回やり直す）", async () => {
    const { ensureStripeAccount, StripeAccountMismatchError } = await import("@/lib/payments/stripe-checkout");
    const other = client("acct_someoneElse99");
    await expect(ensureStripeAccount({ client: other, accountId: "acct_unitLive123" })).rejects.toBeInstanceOf(StripeAccountMismatchError);
    await expect(ensureStripeAccount({ client: other, accountId: "acct_unitLive123" })).rejects.toBeInstanceOf(StripeAccountMismatchError);
    expect(other.accounts.retrieveCurrent).toHaveBeenCalledTimes(2);
    const down = client(Object.assign(new Error("down"), { name: "StripeConnectionError" }));
    await expect(ensureStripeAccount({ client: down, accountId: "acct_unitLive123" })).rejects.toThrow("down");
    await expect(ensureStripeAccount({ client: down, accountId: "acct_unitLive123" })).rejects.toThrow("down");
    expect(down.accounts.retrieveCurrent).toHaveBeenCalledTimes(2);
    // 形の不正なアカウントの ID は Stripe に問い合わせずに拒否
    const any = client("acct_x");
    await expect(ensureStripeAccount({ client: any, accountId: "bad" })).rejects.toBeInstanceOf(StripeAccountMismatchError);
    expect(any.accounts.retrieveCurrent).not.toHaveBeenCalled();
  });

  it("テスト（Sandbox）の接続（アカウントの指定なし）は確かめない（Preview の動作は変えない）", async () => {
    const { ensureStripeAccount } = await import("@/lib/payments/stripe-checkout");
    const c = client("acct_whatever1");
    await ensureStripeAccount({ client: c, accountId: undefined });
    expect(c.accounts.retrieveCurrent).not.toHaveBeenCalled();
  });
});

describe("誰の本番決済を受け付けるか（一般のお客さん・運営だけの本番テスト）", () => {
  async function load(e: Record<string, string>) {
    stub(e);
    return import("@/lib/payments/stripe-access");
  }

  it("公開中（open）：一般のお客さんの本番決済を受け付ける（ログイン不要）", async () => {
    const m = await load(LIVE_PUBLIC);
    expect(m.stripePublicCheckoutAccess()).toEqual({ ok: true, mode: "live" });
    expect(await m.stripeCheckoutAccess()).toEqual({ ok: true, audience: "public", mode: "live" });
    expect(await m.stripeLiveOperatorAccess()).toEqual({ ok: false, reason: "not_operator_audience" });
  });

  it("開発モード＋STRIPE_LIVE_OPERATOR_TEST=on：運営アカウントだけが本番決済を使える。一般の方・店舗アカウントは使えない", async () => {
    const m = await load(LIVE_OPERATOR);
    // 一般の方（ログインなし）
    expect(m.stripePublicCheckoutAccess()).toMatchObject({ ok: false });
    expect(await m.stripeCheckoutAccess()).toEqual({ ok: false });
    expect(await m.stripeLiveOperatorAccess()).toEqual({ ok: false, reason: "not_logged_in" });
    // 店舗アカウント
    auth.user = { id: "store-user", role: "STORE" };
    expect(await (await load(LIVE_OPERATOR)).stripeCheckoutAccess()).toEqual({ ok: false });
    // 運営アカウント
    auth.user = { id: "op-1", role: "OPERATOR" };
    const m2 = await load(LIVE_OPERATOR);
    expect(await m2.stripeOperatorAccess()).toMatchObject({ ok: true, mode: "live" });
    expect(await m2.stripeCheckoutAccess()).toEqual({ ok: true, audience: "operator_test", mode: "live" });
    // 一般のお客さんの判定は、運営がログインしていても受け付けない（開発モード）
    expect(m2.stripePublicCheckoutAccess()).toMatchObject({ ok: false });
  });

  it("運営テストのスイッチがあっても、本番の条件が欠けていれば運営も使えない（受付全体を止める）", async () => {
    auth.user = { id: "op-1", role: "OPERATOR" };
    for (const e of [{ ...LIVE_OPERATOR, STRIPE_ACCOUNT_ID: "" }, { ...LIVE_OPERATOR, STRIPE_SECRET_KEY: "sk_test_unit_fake" }, { ...LIVE_OPERATOR, VERCEL_ENV: "preview" }]) {
      const m = await load(e);
      expect(await m.stripeCheckoutAccess(), JSON.stringify(e)).toEqual({ ok: false });
      const env = await import("@/lib/env");
      expect(env.serviceStopReason(), JSON.stringify(e)).toBe("dangerous_config");
    }
  });

  it("Preview の運営のテスト決済は今までどおり（Sandbox）", async () => {
    auth.user = { id: "op-1", role: "OPERATOR" };
    const m = await load({ ...PREVIEW, SITE_STATUS: "development" });
    expect(await m.stripeCheckoutAccess()).toEqual({ ok: true, audience: "operator_test", mode: "test" });
  });
});

describe("開発モードの本番用キーの停止（isDevModeLiveKeyConflict）と運営の本番テストの例外", () => {
  it("開発モードで本番用キー：スイッチが無ければ受付を全部止める。スイッチがあり条件がそろえば止めない（一般の方は開発モードのまま）", async () => {
    stub({ ...LIVE_PUBLIC, SITE_STATUS: "development" });
    let env = await import("@/lib/env");
    expect([env.isDevModeLiveKeyConflict(), env.serviceStopReason()]).toEqual([true, "dangerous_config"]);
    vi.resetModules();
    stub(LIVE_OPERATOR);
    env = await import("@/lib/env");
    expect([env.isDevModeLiveKeyConflict(), env.isPaidFlowBlocked(), env.serviceStopReason()]).toEqual([false, false, "development"]);
    expect(env.dangerousConfigReasons()).toEqual([]);
  });

  it("スイッチがあるのに条件が欠けている：危険な設定として止める（理由に変数の値は含めない）", async () => {
    stub({ ...LIVE_OPERATOR, STRIPE_ACCOUNT_ID: "" });
    const env = await import("@/lib/env");
    expect(env.dangerousConfigReasons()).toEqual([{ kind: "live_operator_test_invalid" }]);
    expect(env.pausedMessage(env.dangerousConfigReasons())).toMatch(/STRIPE_LIVE_OPERATOR_TEST=on/);
    expect(env.pausedMessage(env.dangerousConfigReasons())).not.toMatch(/sk_live_unit_fake/);
  });
});
