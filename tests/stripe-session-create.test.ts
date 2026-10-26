import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Stripe の SDK を模擬して、Checkout Session の作成で送る内容を確かめる（Stripe API には接続しない）
const sdk = vi.hoisted(() => ({ calls: [] as { params: Record<string, unknown>; opts: Record<string, unknown> }[], response: {} as Record<string, unknown> }));
vi.mock("stripe", () => ({
  default: class {
    checkout = {
      sessions: {
        create: async (params: Record<string, unknown>, opts: Record<string, unknown>) => {
          sdk.calls.push({ params, opts });
          return { expires_at: params.expires_at, ...sdk.response };
        },
      },
    };
  },
}));

const LOCAL = { STRIPE_TEST_CHECKOUT: "on", STRIPE_SECRET_KEY: "sk_test_unit", STRIPE_WEBHOOK_SECRET: "whsec_unit_secret", FIRESTORE_EMULATOR_HOST: "127.0.0.1:8080", FIREBASE_PROJECT_ID: "demo-stripe-unit" };
const CO = "0f5c2f6e-1c1a-4c79-9a59-0f2f3c3b1a10";
const okResponse = () => ({
  id: "cs_test_unit",
  object: "checkout.session",
  livemode: false,
  url: "https://checkout.stripe.com/c/pay/cs_test_unit",
  client_reference_id: CO,
  metadata: { checkoutId: CO, storeId: "store-1", fortuneType: "ZODIAC" },
  payment_method_types: ["card", "paypay"],
  managed_payments: { enabled: false },
});

describe("Checkout Session の作成で送る内容", () => {
  beforeEach(() => {
    for (const [k, v] of Object.entries(LOCAL)) vi.stubEnv(k, v);
    sdk.calls = [];
    sdk.response = okResponse();
    vi.resetModules();
  });
  afterEach(() => vi.unstubAllEnvs());

  const create = async (expiresAt?: Date) => {
    const m = await import("@/lib/payments/stripe-checkout");
    return m.createStripeCheckoutSession({ checkoutId: CO, storeId: "store-1", fortuneType: "ZODIAC", productName: "占い", origin: "http://localhost:3000", expiresAt: expiresAt ?? m.stripeSessionExpiry() });
  };

  it("managed_payments.enabled=false・カードと PayPay だけ・100円・期限は作成から30分より後・冪等キーは注文と期限から", async () => {
    const r = await create();
    expect(r).toMatchObject({ id: "cs_test_unit", url: expect.stringContaining("cs_test_unit") });
    const { params, opts } = sdk.calls[0];
    expect(params.managed_payments).toEqual({ enabled: false });
    expect(params.allowed_payment_method_types).toEqual(["card", "paypay"]);
    expect(params).not.toHaveProperty("payment_method_types");
    expect(params).not.toHaveProperty("payment_method_configuration");
    // Stripe Connect の自動分配はしない（店舗の取り分はアプリ内で計算・記録し、運営が銀行振込する）
    expect((params.payment_intent_data as Record<string, unknown>).transfer_data).toBeUndefined();
    expect(params).not.toHaveProperty("transfer_data");
    expect((params.payment_intent_data as Record<string, unknown>).application_fee_amount).toBeUndefined();
    expect(params.line_items).toEqual([{ quantity: 1, price_data: { currency: "jpy", unit_amount: 100, product_data: { name: "占い" } } }]);
    expect(Number(params.expires_at) * 1000).toBeGreaterThanOrEqual(Date.now() + 30 * 60_000);
    expect(opts.idempotencyKey).toBe(`uranai-checkout-v2-${CO}-${params.expires_at}`);
    expect(r.expiresAt.getTime()).toBe(Number(params.expires_at) * 1000);
  });

  it("期限が作成から30分未満なら Stripe に送らない", async () => {
    await expect(create(new Date(Date.now() + 29 * 60_000))).rejects.toThrow(/too early/);
    expect(sdk.calls).toHaveLength(0);
  });

  it("応答が Managed Payments・想定外の支払い方法・期限の食い違いなら、決済画面に移動させない", async () => {
    sdk.response = { ...okResponse(), managed_payments: { enabled: true } };
    await expect(create()).rejects.toThrow(/managed payments/);
    sdk.response = { ...okResponse(), payment_method_types: ["card", "link"] };
    await expect(create()).rejects.toThrow(/unexpected payment methods/);
    sdk.response = { ...okResponse(), expires_at: 1 }; // 送った期限と違う期限の Session
    await expect(create()).rejects.toThrow(/expiry mismatch/);
  });
});
