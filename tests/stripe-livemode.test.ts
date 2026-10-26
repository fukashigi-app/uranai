import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import Stripe from "stripe";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSimulatedStripeRuntime, isStripeSessionId, stripeRuntime, validateStripeSession, type StripeMode } from "@/lib/payments/stripe-checkout";

// Stripe API・Firestore には接続しない（すべて模擬）。キーはすべて形だけの偽物
const CO = "0f5c2f6e-1c1a-4c79-9a59-0f2f3c3b1a10";
function session(mode: StripeMode, over: { s?: Record<string, unknown>; pi?: Record<string, unknown>; ch?: Record<string, unknown> } = {}): Stripe.Checkout.Session {
  const live = mode === "live";
  const md = { checkoutId: CO, storeId: "store-1", fortuneType: "ZODIAC" };
  const ch = { id: "ch_1", object: "charge", livemode: live, status: "succeeded", paid: true, captured: true, refunded: false, amount_refunded: 0, currency: "jpy", amount: 100, payment_intent: "pi_1", created: 1_790_000_000, payment_method_details: { type: "card", card: { wallet: null } }, balance_transaction: { id: "txn_1", object: "balance_transaction", currency: "jpy", fee: 4 }, ...over.ch };
  const pi = { id: "pi_1", object: "payment_intent", livemode: live, status: "succeeded", currency: "jpy", amount: 100, amount_received: 100, metadata: md, latest_charge: ch, ...over.pi };
  return { id: `cs_${mode}_abc`, object: "checkout.session", livemode: live, mode: "payment", status: "complete", payment_status: "paid", currency: "jpy", amount_total: 100, client_reference_id: CO, metadata: md, payment_intent: pi, ...over.s } as unknown as Stripe.Checkout.Session;
}

describe("Stripe の決済の照合：モード（テスト／本番）と livemode・ID の一致", () => {
  it("本番モードは cs_live_ と livemode=true の Session・PaymentIntent・Charge だけ。記録する livemode は true", () => {
    expect(validateStripeSession(session("live"), "live")).toMatchObject({ ok: true, facts: { livemode: true, amount: 100, sessionId: "cs_live_abc" } });
    expect(validateStripeSession(session("test"), "test")).toMatchObject({ ok: true, facts: { livemode: false, sessionId: "cs_test_abc" } });
    expect(validateStripeSession(session("test"))).toMatchObject({ ok: true, facts: { livemode: false } }); // 既定はテスト
  });

  it("モードが違う決済・livemode が混ざった決済は拒否する（記録しない）", () => {
    const cases: [Stripe.Checkout.Session, StripeMode, string][] = [
      [session("test"), "live", "not_live_session"], // 本番の環境にテストの Session
      [session("live"), "test", "not_test_session"], // テストの環境に本番の Session
      [session("live", { s: { livemode: false } }), "live", "livemode"], // ID は本番だが livemode=false
      [session("test", { s: { livemode: true } }), "test", "livemode"],
      [session("live", { pi: { livemode: false } }), "live", "livemode"],
      [session("live", { ch: { livemode: false } }), "live", "livemode"],
      [session("test", { ch: { livemode: true } }), "test", "livemode"],
      [session("live", { s: { id: "cs_test_abc" } }), "live", "not_live_session"],
    ];
    for (const [s, mode, reason] of cases) expect(validateStripeSession(s, mode), `${mode}:${reason}:${s.id}`).toEqual({ ok: false, status: "rejected", reason });
    // 本番でも、金額・注文・支払い方法・未払いなどの既存の照合はそのまま
    expect(validateStripeSession(session("live", { s: { amount_total: 200 } }), "live")).toMatchObject({ ok: false, reason: "amount_mismatch" });
    expect(validateStripeSession(session("live", { s: { payment_status: "unpaid" }, pi: { status: "processing" } }), "live")).toMatchObject({ ok: false, status: "not_paid" });
    expect(validateStripeSession(session("live", { ch: { payment_method_details: { type: "link" } } }), "live")).toMatchObject({ ok: false, reason: "payment_method_not_allowed" });
  });

  it("Session の ID の形はモードごと", () => {
    expect(isStripeSessionId("cs_live_a1", "live")).toBe(true);
    expect(isStripeSessionId("cs_test_a1", "live")).toBe(false);
    expect(isStripeSessionId("cs_test_a1", "test")).toBe(true);
    expect(isStripeSessionId("cs_live_a1", "test")).toBe(false);
    for (const v of ["", "cs_live_", "cs_live_a b", "cs_live_a/../x", null, 1]) expect(isStripeSessionId(v, "live")).toBe(false);
  });
});

describe("Stripe との接続（StripeRuntime）：アプリはテストだけ。本番モードはローカルの自動テストの模擬サーバーでだけ", () => {
  afterEach(() => vi.unstubAllEnvs());
  const EMU = { FIRESTORE_EMULATOR_HOST: "127.0.0.1:8080", FIREBASE_PROJECT_ID: "demo-live-unit" };
  const opts = { apiBase: "http://127.0.0.1:12112", secretKey: "sk_live_e2e_dummy", webhookSecret: "whsec_live_unit" };

  it("アプリの接続（stripeRuntime）は、本番の設定がそろっていても本番モードを返さない", async () => {
    const LIVE = { VERCEL_ENV: "production", STRIPE_LIVE_CHECKOUT: "on", STRIPE_SECRET_KEY: "sk_live_x", STRIPE_WEBHOOK_SECRET: "whsec_live_unit", FIREBASE_PROJECT_ID: "uranai-b6edf", PRODUCTION_FIREBASE_PROJECT_ID: "uranai-b6edf", SITE_STATUS: "open" };
    for (const [k, v] of Object.entries(LIVE)) vi.stubEnv(k, v);
    expect(() => stripeRuntime()).toThrow(/not available/);
    vi.unstubAllEnvs();
    for (const [k, v] of Object.entries({ STRIPE_TEST_CHECKOUT: "on", STRIPE_SECRET_KEY: "sk_test_unit", STRIPE_WEBHOOK_SECRET: "whsec_unit_secret", ...EMU })) vi.stubEnv(k, v);
    expect(stripeRuntime().mode).toBe("test");
  });

  it("模擬の接続は、Emulator（demo-）・localhost の接続先・モードに合ったキーのときだけ作れる", () => {
    expect(createSimulatedStripeRuntime("live", opts, EMU).mode).toBe("live");
    expect(createSimulatedStripeRuntime("test", { ...opts, secretKey: "sk_test_x" }, EMU).mode).toBe("test");
    const bad: [Record<string, string | undefined>, typeof opts][] = [
      [{ ...EMU, VERCEL_ENV: "preview" }, opts], // Vercel 上では作れない
      [{ ...EMU, VERCEL_ENV: "production" }, opts],
      [{ FIREBASE_PROJECT_ID: "demo-live-unit" }, opts], // Emulator が無い（本物の Firestore）
      [{ ...EMU, FIRESTORE_EMULATOR_HOST: "firestore.googleapis.com:443" }, opts],
      [{ ...EMU, FIREBASE_PROJECT_ID: "uranai-b6edf" }, opts], // demo- 以外
      [{ ...EMU, FIREBASE_PROJECT_ID: "uranai-preview" }, opts],
      [EMU, { ...opts, apiBase: "https://api.stripe.com" }], // 本物の Stripe
      [EMU, { ...opts, apiBase: "http://evil.example:12112" }],
      [EMU, { ...opts, apiBase: "http://127.0.0.1:12112/v1" }],
      [EMU, { ...opts, secretKey: "sk_test_x" }], // モードとキーが合わない
      [EMU, { ...opts, webhookSecret: "secret" }],
    ];
    for (const [e, o] of bad) expect(() => createSimulatedStripeRuntime("live", o, e), JSON.stringify([e, o])).toThrow();
  });

  it("模擬の接続はアプリのコードから使われていない（自動テスト専用）", () => {
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
    const users = files.filter((f) => !f.endsWith(path.join("lib", "payments", "stripe-checkout.ts")) && readFileSync(f, "utf8").includes("createSimulatedStripeRuntime"));
    expect(users.map((f) => path.relative(src, f))).toEqual([]);
  });
});

// ---- Webhook：通知の livemode とモードの一致（Firestore と確定処理は模擬） ----
const calls = vi.hoisted(() => ({ list: [] as string[] }));
vi.mock("@/lib/firestore/payments", () => ({
  beginWebhookEvent: async () => true,
  finishWebhookEvent: async () => undefined,
}));
vi.mock("@/lib/payments/stripe-confirm", () => ({
  confirmStripeCheckout: async (id: string, rt: { mode: string }) => (calls.list.push(`confirm:${id}:${rt.mode}`), { status: "confirmed", transactionId: "stripe_pi" }),
  closeStripeCheckout: async () => false,
  syncStripeRefunds: async (id: string, rt: { mode: string }) => (calls.list.push(`refund:${id}:${rt.mode}`), "refunded"),
  refreshStripeFee: async () => false,
}));

describe("Stripe の Webhook：署名の確認と、通知の livemode とモードの一致", () => {
  const EMU = { FIRESTORE_EMULATOR_HOST: "127.0.0.1:8080", FIREBASE_PROJECT_ID: "demo-live-unit" };
  const live = createSimulatedStripeRuntime("live", { apiBase: "http://127.0.0.1:12112", secretKey: "sk_live_e2e_dummy", webhookSecret: "whsec_live_unit" }, EMU);
  const test = createSimulatedStripeRuntime("test", { apiBase: "http://127.0.0.1:12113", secretKey: "sk_test_e2e_dummy", webhookSecret: "whsec_test_unit" }, EMU);
  const signer = new Stripe("sk_test_signer");
  const signed = (event: Record<string, unknown>, secret: string) => {
    const payload = JSON.stringify(event);
    return { payload, sig: signer.webhooks.generateTestHeaderString({ payload, secret }) };
  };
  const ev = (livemode: boolean, type = "checkout.session.completed", object: Record<string, unknown> = { id: livemode ? "cs_live_abc" : "cs_test_abc" }) => ({ id: `evt_${livemode ? "live" : "test"}_${type}`, object: "event", type, livemode, data: { object } });
  beforeEach(() => {
    calls.list = [];
  });

  it("本番の接続は、本番の署名の値で署名された livemode=true の通知だけを処理する", async () => {
    const { handleStripeWebhook } = await import("@/lib/payments/stripe-webhook");
    const ok = signed(ev(true), "whsec_live_unit");
    expect(await handleStripeWebhook(ok.payload, ok.sig, live)).toEqual({ status: 200, body: { received: true, outcome: "confirmed" } });
    const refund = signed(ev(true, "refund.updated", { id: "re_1", charge: "ch_1" }), "whsec_live_unit");
    await handleStripeWebhook(refund.payload, refund.sig, live);
    expect(calls.list).toEqual(["confirm:cs_live_abc:live", "refund:ch_1:live"]);
  });

  it("モードの違う通知・署名の値の違う通知は 400（処理しない）", async () => {
    const { handleStripeWebhook } = await import("@/lib/payments/stripe-webhook");
    const testEventToLive = signed(ev(false), "whsec_live_unit");
    expect((await handleStripeWebhook(testEventToLive.payload, testEventToLive.sig, live)).status).toBe(400);
    const liveEventToTest = signed(ev(true), "whsec_test_unit");
    expect((await handleStripeWebhook(liveEventToTest.payload, liveEventToTest.sig, test)).status).toBe(400);
    const testSecretToLive = signed(ev(true), "whsec_test_unit"); // Sandbox の送信先の署名で本番に送られた
    expect((await handleStripeWebhook(testSecretToLive.payload, testSecretToLive.sig, live)).status).toBe(400);
    expect((await handleStripeWebhook(testSecretToLive.payload, null, live)).status).toBe(400);
    expect(calls.list).toEqual([]);
  });
});
