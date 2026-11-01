import type Stripe from "stripe";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSimulatedStripeRuntime, isOtherStripeEnv, stripeEnvTag, stripeRuntime, validateStripeSession } from "@/lib/payments/stripe-checkout";

// 決済の環境の識別（同じ Sandbox を使う別の Firestore の決済を見分ける）。Stripe API・Firestore には接続しない
const LOCAL = { STRIPE_TEST_CHECKOUT: "on", STRIPE_SECRET_KEY: "sk_test_unit", STRIPE_WEBHOOK_SECRET: "whsec_unit_secret", FIRESTORE_EMULATOR_HOST: "127.0.0.1:8080", FIREBASE_PROJECT_ID: "demo-env-unit" };
const PREVIEW = { STRIPE_TEST_CHECKOUT: "on", STRIPE_SECRET_KEY: "sk_test_unit", STRIPE_WEBHOOK_SECRET: "whsec_unit_secret", VERCEL_ENV: "preview", FIREBASE_PROJECT_ID: "uranai-preview", STRIPE_TEST_FIREBASE_PROJECT_ID: "uranai-preview", PRODUCTION_FIREBASE_PROJECT_ID: "uranai-b6edf", FIREBASE_CLIENT_EMAIL: "stripe-test@uranai-preview.iam.gserviceaccount.com" };

describe("環境を表す値（stripeEnvTag）", () => {
  it("Firestore のプロジェクトごとに決まり、同じプロジェクトなら同じ値。プロジェクト ID そのものは含まない", () => {
    expect(stripeEnvTag("uranai-preview")).toBe(stripeEnvTag("uranai-preview"));
    expect(stripeEnvTag("uranai-preview")).not.toBe(stripeEnvTag("demo-uranai"));
    expect(stripeEnvTag("uranai-preview")).not.toBe(stripeEnvTag("uranai-b6edf"));
    expect(stripeEnvTag("uranai-preview")).toMatch(/^fp_[0-9a-f]{16}$/);
    expect(stripeEnvTag("uranai-preview")).not.toContain("uranai");
  });

  it("別の環境と判断するのは、正しい形の値があって、この環境の値と違うときだけ（値が無い以前の決済・形が違う値は判断しない）", () => {
    const rt = { envTag: stripeEnvTag("uranai-preview") };
    expect(isOtherStripeEnv(stripeEnvTag("demo-uranai"), rt)).toBe(true);
    expect(isOtherStripeEnv(rt.envTag, rt)).toBe(false);
    for (const v of [undefined, null, "", "preview", "fp_xyz", 1, `${rt.envTag}x`]) expect(isOtherStripeEnv(v, rt), String(v)).toBe(false);
  });
});

describe("Stripe との接続の環境を表す値は、サーバーの設定（FIREBASE_PROJECT_ID）だけから決まる", () => {
  afterEach(() => vi.unstubAllEnvs());
  const stub = (e: Record<string, string>) => {
    for (const k of ["VERCEL_ENV", "FIRESTORE_EMULATOR_HOST", "STRIPE_TEST_FIREBASE_PROJECT_ID", "PRODUCTION_FIREBASE_PROJECT_ID", "FIREBASE_CLIENT_EMAIL"]) vi.stubEnv(k, "");
    for (const [k, v] of Object.entries(e)) vi.stubEnv(k, v);
  };

  it("ローカル（Emulator）と Preview で別の値（同じ Sandbox を使っても見分けられる）", () => {
    stub(LOCAL);
    const local = stripeRuntime().envTag;
    expect(local).toBe(stripeEnvTag("demo-env-unit"));
    stub(PREVIEW);
    const preview = stripeRuntime().envTag;
    expect(preview).toBe(stripeEnvTag("uranai-preview"));
    expect(local).not.toBe(preview);
  });

  it("自動テストの接続も同じ規則（指定があればそれを使う＝別の環境の再現）", () => {
    const EMU = { FIRESTORE_EMULATOR_HOST: "127.0.0.1:8080", FIREBASE_PROJECT_ID: "demo-env-sim" };
    const opts = { apiBase: "http://127.0.0.1:12111", secretKey: "sk_test_x", webhookSecret: "whsec_x" };
    expect(createSimulatedStripeRuntime("test", opts, EMU).envTag).toBe(stripeEnvTag("demo-env-sim"));
    expect(createSimulatedStripeRuntime("test", { ...opts, envTag: stripeEnvTag("other") }, EMU).envTag).toBe(stripeEnvTag("other"));
  });
});

// ---- Session の検証（環境を表す値の照合） ----
const CO = "0f5c2f6e-1c1a-4c79-9a59-0f2f3c3b1a10";
function session(md: Record<string, string>, pmd: Record<string, string> = md): Stripe.Checkout.Session {
  const ch = { id: "ch_test_1", object: "charge", livemode: false, status: "succeeded", paid: true, captured: true, refunded: false, amount_refunded: 0, currency: "jpy", amount: 100, payment_intent: "pi_test_1", created: 1_790_000_000, payment_method_details: { type: "card", card: { wallet: null } }, balance_transaction: null };
  const p = { id: "pi_test_1", object: "payment_intent", livemode: false, status: "succeeded", currency: "jpy", amount: 100, amount_received: 100, metadata: pmd, latest_charge: ch };
  return { id: "cs_test_abc", object: "checkout.session", livemode: false, mode: "payment", status: "complete", payment_status: "paid", currency: "jpy", amount_total: 100, client_reference_id: CO, metadata: md, payment_intent: p } as unknown as Stripe.Checkout.Session;
}

describe("Session の検証での環境を表す値", () => {
  const base = { checkoutId: CO, storeId: "store-1", fortuneType: "ZODIAC" };
  const tag = stripeEnvTag("uranai-preview");
  it("Session の値を決済の情報に含める。値が無い以前の Session は null（今までどおり）", () => {
    expect(validateStripeSession(session({ ...base, uranaiEnv: tag }))).toMatchObject({ ok: true, facts: { envTag: tag } });
    expect(validateStripeSession(session(base))).toMatchObject({ ok: true, facts: { envTag: null } });
  });
  it("Session と PaymentIntent で値が違う・片方だけにあるなら拒否（書き換え・作り間違いを受け付けない）", () => {
    const other = stripeEnvTag("demo-x");
    for (const [md, pmd] of [
      [{ ...base, uranaiEnv: tag }, { ...base, uranaiEnv: other }],
      [{ ...base, uranaiEnv: tag }, base],
      [base, { ...base, uranaiEnv: tag }],
    ]) expect(validateStripeSession(session(md, pmd))).toEqual({ ok: false, status: "rejected", reason: "payment_intent_metadata_mismatch" });
  });
});
