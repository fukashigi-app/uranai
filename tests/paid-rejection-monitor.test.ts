import Stripe from "stripe";
import { FieldValue, type DocumentReference, type DocumentSnapshot, type Transaction } from "firebase-admin/firestore";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * 支払い済みなのに許可しない支払い方法のため確定を拒否した決済（paid_payment_method_not_allowed）の記録。
 * Firestore には接続しない（記録の関数・Stripe API の取得は模擬）。Firestore での重複・確認済みの扱いは E2E（e2e-stripe.ts）で確かめる。
 */
const state = vi.hoisted(() => ({
  session: null as unknown,
  reviewFails: false,
  reviews: [] as Record<string, unknown>[],
  alerts: [] as { input: Record<string, unknown>; opts: unknown }[],
  webhook: { finished: 0, failures: 0 },
}));

vi.mock("@/lib/firestore/payment-reviews", async (orig) => ({
  ...(await orig<typeof import("@/lib/firestore/payment-reviews")>()),
  recordRequiredPaymentReview: async (input: Record<string, unknown>) => {
    if (state.reviewFails) throw Object.assign(new Error("payment review could not be recorded"), { name: "PaymentReviewRecordError" });
    state.reviews.push(input);
  },
  recordPaymentReview: async () => undefined,
}));
vi.mock("@/lib/firestore/payment-alerts", async (orig) => ({
  ...(await orig<typeof import("@/lib/firestore/payment-alerts")>()),
  recordPaymentAlert: async (input: Record<string, unknown>, _now?: Date, opts?: unknown) => (state.alerts.push({ input, opts }), true),
}));
vi.mock("@/lib/payments/stripe-checkout", async (orig) => ({
  ...(await orig<typeof import("@/lib/payments/stripe-checkout")>()),
  retrieveStripeSession: async () => state.session,
}));
vi.mock("@/lib/firestore/payments", async (orig) => ({
  ...(await orig<typeof import("@/lib/firestore/payments")>()),
  acquireWebhookEventLease: async () => ({ status: "acquired", token: "lease_unit", attempts: 1 }),
  finishWebhookEventWithLease: async () => (state.webhook.finished++, "finished"),
  recordWebhookEventFailure: async () => (state.webhook.failures++, true),
}));

const CO = "0f5c2f6e-1c1a-4c79-9a59-0f2f3c3b1a10";
const EMAIL = "customer@example.com";
const NAME = "山田 太郎";
function session(charge: Record<string, unknown> = {}, over: Record<string, unknown> = {}): Stripe.Checkout.Session {
  const md = { checkoutId: CO, storeId: "store-1", fortuneType: "ZODIAC" };
  const ch = {
    id: "ch_test_1",
    object: "charge",
    livemode: false,
    status: "succeeded",
    paid: true,
    captured: true,
    refunded: false,
    amount_refunded: 0,
    currency: "jpy",
    amount: 100,
    payment_intent: "pi_test_1",
    created: 1_790_000_000,
    billing_details: { email: EMAIL, name: NAME, phone: "+819012345678" },
    payment_method_details: { type: "card", card: { brand: "visa", last4: "4242", wallet: null } },
    balance_transaction: { id: "txn_test_1", object: "balance_transaction", currency: "jpy", fee: 4 },
    ...charge,
  };
  const p = { id: "pi_test_1", object: "payment_intent", livemode: false, status: "succeeded", currency: "jpy", amount: 100, amount_received: 100, metadata: md, latest_charge: ch };
  return {
    id: "cs_test_abc",
    object: "checkout.session",
    livemode: false,
    mode: "payment",
    status: "complete",
    payment_status: "paid",
    currency: "jpy",
    amount_total: 100,
    client_reference_id: CO,
    customer_details: { email: EMAIL, name: NAME },
    metadata: md,
    payment_intent: p,
    ...over,
  } as unknown as Stripe.Checkout.Session;
}
const card = (wallet: string | null) => ({ payment_method_details: { type: "card", card: { brand: "visa", last4: "4242", wallet: wallet ? { type: wallet } : null } } });
const PII = [EMAIL, NAME, "+819012345678", "4242", "visa"];

beforeEach(() => {
  state.session = null;
  state.reviewFails = false;
  state.reviews = [];
  state.alerts = [];
  state.webhook = { finished: 0, failures: 0 };
});

describe("確定の判定：許可しない支払い方法だけ、支払い済みの情報を付ける（判定は変えない）", () => {
  it("Link・Samsung Pay・konbini・カードの明細なし：reason は今までどおり、paidRejection に ID と種類の名前だけ", async () => {
    const { validateStripeSession } = await import("@/lib/payments/stripe-checkout");
    const cases: [Record<string, unknown>, string][] = [
      [{ payment_method_details: { type: "link", link: { email: EMAIL } } }, "link"],
      [card("samsung_pay"), "card:samsung_pay"],
      [card("link"), "card:link"],
      [{ payment_method_details: { type: "konbini", konbini: {} } }, "konbini"],
      [{ payment_method_details: { type: "card" } }, "card:no_details"],
      [{ payment_method_details: { type: "Weird Type!" } }, "unknown"],
    ];
    for (const [charge, type] of cases) {
      const v = validateStripeSession(session(charge));
      expect(v, type).toEqual({
        ok: false,
        status: "rejected",
        reason: "payment_method_not_allowed",
        paidRejection: { checkoutId: CO, storeId: "store-1", sessionId: "cs_test_abc", paymentIntentId: "pi_test_1", chargeId: "ch_test_1", amount: 100, livemode: false, paymentMethodType: type },
      });
      const json = JSON.stringify(v);
      for (const s of PII) expect(json, `${type}: ${s}`).not.toContain(s);
    }
  });

  it("カード・Apple Pay・Google Pay・PayPay は今までどおり確定できる（paidRejection は付かない）", async () => {
    const { validateStripeSession } = await import("@/lib/payments/stripe-checkout");
    for (const [charge, method] of [
      [card(null), "card"],
      [card("apple_pay"), "apple_pay"],
      [card("google_pay"), "google_pay"],
      [{ payment_method_details: { type: "paypay", paypay: {} } }, "paypay"],
    ] as const) {
      const v = validateStripeSession(session(charge));
      expect(v, method).toMatchObject({ ok: true, facts: { paymentMethod: method, amount: 100 } });
      expect(v).not.toHaveProperty("paidRejection");
    }
  });

  it("未払い・ほかの拒否には paidRejection を付けない（支払い済みと確かめたものだけ）", async () => {
    const { validateStripeSession } = await import("@/lib/payments/stripe-checkout");
    const link = { payment_method_details: { type: "link", link: {} } };
    for (const s of [
      session(link, { payment_status: "unpaid" }), // 未払い（支払い方法の確認より前）
      session({ ...link, captured: false }),
      session({ ...link, amount: 1000 }),
      session(link, { amount_total: 200 }),
      session(link, { currency: "usd" }),
    ]) {
      const v = validateStripeSession(s);
      expect(v.ok).toBe(false);
      expect(v).not.toHaveProperty("paidRejection");
    }
  });
});

describe("確定の処理：記録と、記録の失敗の扱い", () => {
  const rt = () => ({ mode: "test", client: {} as Stripe, webhookSecret: "whsec_unit", allowHttpOrigin: false, envTag: "fp_0000000000000000" }) as unknown as import("@/lib/payments/stripe-checkout").StripeRuntime;
  const processing = { id: CO, provider: "stripe", status: "PROCESSING", providerPaymentId: "cs_test_abc", expiresAt: new Date(Date.now() + 30 * 60_000), storeId: "store-1", fortuneType: "ZODIAC" };

  it("支払い済み・許可しない方法：決済要確認（必須）と決済監視（1回だけ）に記録し、rejected＋paidReview を返す（確定・付与はしない）", async () => {
    state.session = session({ payment_method_details: { type: "link", link: { email: EMAIL } } });
    const { confirmStripeCheckout } = await import("@/lib/payments/stripe-confirm");
    const r = await confirmStripeCheckout("cs_test_abc", rt());
    expect(r).toEqual({ status: "rejected", reason: "payment_method_not_allowed", paidReview: true });
    expect(state.reviews).toEqual([
      {
        kind: "paid_payment_method_not_allowed",
        objectType: "charge",
        objectId: "ch_test_1",
        chargeId: "ch_test_1",
        paymentIntentId: "pi_test_1",
        checkoutId: CO,
        sessionId: "cs_test_abc",
        storeId: "store-1",
        paymentMethodType: "link",
        mismatches: ["payment_method"],
        amount: 100,
        livemode: false,
      },
    ]);
    expect(state.alerts).toEqual([
      {
        input: { kind: "paid_payment_method_not_allowed", objectType: "checkout", objectId: CO, checkoutId: CO, paymentIntentId: "pi_test_1", storeId: "store-1", mode: "test", errorName: "payment_method_not_allowed" },
        opts: { once: true },
      },
    ]);
    const json = JSON.stringify([state.reviews, state.alerts]);
    for (const s of [...PII, "whsec_unit"]) expect(json).not.toContain(s);
  });

  it("ほかの拒否（金額の不一致など）・正常な決済では、この記録をしない", async () => {
    const { confirmStripeCheckout } = await import("@/lib/payments/stripe-confirm");
    state.session = session({ amount: 1000 });
    expect(await confirmStripeCheckout("cs_test_abc", rt())).toEqual({ status: "rejected", reason: "charge_mismatch" });
    state.session = session({ payment_method_details: { type: "link", link: {} } }, { payment_status: "unpaid" });
    expect((await confirmStripeCheckout("cs_test_abc", rt())).status).toBe("not_paid");
    expect(state.reviews).toEqual([]);
    expect(state.alerts).toEqual([]);
  });

  it("決済要確認の記録に失敗：例外（決済監視には書かない・確定もしない）", async () => {
    state.session = session({ payment_method_details: { type: "link", link: {} } });
    state.reviewFails = true;
    const { confirmStripeCheckout } = await import("@/lib/payments/stripe-confirm");
    await expect(confirmStripeCheckout("cs_test_abc", rt())).rejects.toMatchObject({ name: "PaymentReviewRecordError" });
    expect(state.alerts).toEqual([]);
  });

  it("状態の確認：記録できたら stripe_paid_review（「請求は発生していません」の表示にしない）。記録に失敗したら processing（確認しています）", async () => {
    state.session = session({ payment_method_details: { type: "link", link: {} } });
    const { stripeCheckoutStatus } = await import("@/lib/payments/stripe-confirm");
    expect(await stripeCheckoutStatus(processing, rt())).toEqual({ status: "failed", failureCode: "stripe_paid_review" });
    state.reviewFails = true;
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(await stripeCheckoutStatus(processing, rt())).toEqual({ status: "processing" });
    vi.restoreAllMocks();
  });

  it("ほかの拒否の状態の確認は今までどおり stripe_rejected", async () => {
    state.session = session({ amount: 1000 });
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { stripeCheckoutStatus } = await import("@/lib/payments/stripe-confirm");
    expect(await stripeCheckoutStatus(processing, rt())).toEqual({ status: "failed", failureCode: "stripe_rejected" });
    vi.restoreAllMocks();
  });
});

describe("Webhook：必須の記録に失敗したら 500 で、処理済みにしない", () => {
  it("checkout.session.completed で記録に失敗 → 500・処理済みの記録をしない・失敗の状態を記録（Stripe が再送）", async () => {
    state.session = session({ payment_method_details: { type: "link", link: {} } });
    state.reviewFails = true;
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { processStripeEvent } = await import("@/lib/payments/stripe-webhook");
    const rt = { mode: "test", client: {} as Stripe, webhookSecret: "whsec_unit", allowHttpOrigin: false, envTag: "fp_0000000000000000" } as unknown as import("@/lib/payments/stripe-checkout").StripeRuntime;
    const event = { id: "evt_test_paid_rejected", object: "event", type: "checkout.session.completed", livemode: false, data: { object: { id: "cs_test_abc" } } } as unknown as Stripe.Event;
    const r = await processStripeEvent(event, rt);
    expect(r.status).toBe(500);
    expect(state.webhook.finished).toBe(0);
    expect(state.webhook.failures).toBe(1);
    // 記録できたときは今までどおり処理済み（200・outcome rejected）
    state.reviewFails = false;
    const ok = await processStripeEvent({ ...event, id: "evt_test_paid_rejected_2" } as Stripe.Event, rt);
    expect(ok).toMatchObject({ status: 200, body: { received: true, outcome: "rejected" } });
    expect(state.webhook.finished).toBe(1);
    vi.restoreAllMocks();
  });
});

describe("重複のまとめ方（1つの決済につき1件・確認済みに戻さない）", () => {
  const ref = { path: "paymentAlerts/x" } as unknown as DocumentReference;
  const snap = (data: Record<string, unknown> | null) => ({ exists: data !== null, ref: { path: ref.path }, get: (k: string) => (data ?? {})[k] }) as unknown as DocumentSnapshot;
  const fakeTx = () => {
    const calls: { op: string; data: Record<string, unknown> }[] = [];
    const tx = { create: (_r: unknown, data: Record<string, unknown>) => calls.push({ op: "create", data }), update: (_r: unknown, data: Record<string, unknown>) => calls.push({ op: "update", data }) } as unknown as Transaction;
    return { tx, calls };
  };
  const ONCE = { causeKey: "paid_payment_method_not_allowed", reopen: "on_change" as const, countRepeat: false };

  it("ID は種類と対象で決まる固定の値（別のサーバーでも同じ文書）", async () => {
    const { paymentAlertId } = await import("@/lib/firestore/payment-alerts");
    const { paymentReviewId } = await import("@/lib/firestore/payment-reviews");
    expect(paymentAlertId("paid_payment_method_not_allowed", CO)).toBe(paymentAlertId("paid_payment_method_not_allowed", CO));
    expect(paymentReviewId("paid_payment_method_not_allowed", "ch_test_1")).toBe(paymentReviewId("paid_payment_method_not_allowed", "ch_test_1"));
    expect(paymentReviewId("paid_payment_method_not_allowed", "ch_test_1")).not.toBe(paymentReviewId("paid_payment_method_not_allowed", "ch_test_2"));
  });

  it("once：くり返しでは回数を増やさず、確認済みのまま（未確認に戻さない）", async () => {
    const { upsertDedupedRecordInTx } = await import("@/lib/firestore/deduped-record");
    const a = fakeTx();
    upsertDedupedRecordInTx(a.tx, ref, snap({ status: "OPEN", causeKey: ONCE.causeKey, occurrences: 1 }), { kind: "k" }, ONCE);
    expect(a.calls[0].data).not.toHaveProperty("occurrences");
    expect(a.calls[0].data).not.toHaveProperty("status");
    const b = fakeTx();
    upsertDedupedRecordInTx(b.tx, ref, snap({ status: "RESOLVED", causeKey: ONCE.causeKey, occurrences: 1, resolvedBy: "op" }), { kind: "k" }, ONCE);
    expect(b.calls[0].data).not.toHaveProperty("status");
    expect(b.calls[0].data).not.toHaveProperty("resolvedAt");
    expect(b.calls[0].data.occurrences).toBeUndefined();
    // 通常の決済監視（reopen: always）は今までどおり未確認に戻る
    const c = fakeTx();
    upsertDedupedRecordInTx(c.tx, ref, snap({ status: "RESOLVED", causeKey: "k" }), { kind: "k" }, { causeKey: "k", reopen: "always" });
    expect(c.calls[0].data).toMatchObject({ status: "OPEN", occurrences: FieldValue.increment(1) });
  });
});
