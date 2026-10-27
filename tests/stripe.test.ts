import Stripe from "stripe";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stripeTestConfig } from "@/lib/payments/stripe-guard";
import { isSalesPayment, isSettlementPayment, paymentKind } from "@/lib/payments/kind";
import { productionConfigIssues } from "@/lib/env";

// Stripe API・Firestore には接続しない（すべて模擬）
const SECRET = "unit-test-session-secret-Qx7v2Lr9Tm4Kp8Zw";
const LOCAL = { STRIPE_TEST_CHECKOUT: "on", STRIPE_SECRET_KEY: "sk_test_unit", STRIPE_WEBHOOK_SECRET: "whsec_unit_secret", FIRESTORE_EMULATOR_HOST: "127.0.0.1:8080", FIREBASE_PROJECT_ID: "demo-stripe-unit", SESSION_SECRET: SECRET };
const PREVIEW = { STRIPE_TEST_CHECKOUT: "on", STRIPE_SECRET_KEY: "sk_test_unit", STRIPE_WEBHOOK_SECRET: "whsec_unit_secret", VERCEL_ENV: "preview", FIREBASE_PROJECT_ID: "uranai-preview", STRIPE_TEST_FIREBASE_PROJECT_ID: "uranai-preview", PRODUCTION_FIREBASE_PROJECT_ID: "uranai-b6edf" };

describe("Stripe のテスト決済を使える設定（欠けていたら使わない）", () => {
  it("Preview とローカルの Emulator（demo-）だけ。必要な設定がそろっているとき", () => {
    expect(stripeTestConfig(PREVIEW)).toMatchObject({ ok: true, mode: "preview", apiBase: null });
    expect(stripeTestConfig(LOCAL)).toMatchObject({ ok: true, mode: "local" });
  });

  it("本番・本番の Firebase・設定の不足・本番用キー・疑似決済の併用では使わない", () => {
    const cases: [Record<string, string | undefined>, string][] = [
      [{ ...PREVIEW, STRIPE_TEST_CHECKOUT: undefined }, "not_enabled"],
      [{ ...PREVIEW, STRIPE_TEST_CHECKOUT: "true" }, "not_enabled"],
      [{ ...PREVIEW, VERCEL_ENV: "production" }, "production"],
      [{ ...PREVIEW, FIREBASE_PROJECT_ID: "uranai-b6edf", STRIPE_TEST_FIREBASE_PROJECT_ID: "uranai-b6edf" }, "production_project"],
      [{ ...PREVIEW, FIREBASE_PROJECT_ID: "other", STRIPE_TEST_FIREBASE_PROJECT_ID: "other", PRODUCTION_FIREBASE_PROJECT_ID: "other" }, "production_project"],
      [{ ...PREVIEW, STRIPE_TEST_FIREBASE_PROJECT_ID: undefined }, "test_project_not_set"],
      [{ ...PREVIEW, STRIPE_TEST_FIREBASE_PROJECT_ID: "uranai-other" }, "test_project_mismatch"],
      [{ ...PREVIEW, PRODUCTION_FIREBASE_PROJECT_ID: undefined }, "firestore_target_blocked"],
      [{ ...PREVIEW, STRIPE_SECRET_KEY: undefined }, "secret_key_missing"],
      [{ ...PREVIEW, STRIPE_SECRET_KEY: "sk_live_x" }, "secret_key_not_test"],
      [{ ...PREVIEW, STRIPE_SECRET_KEY: "rk_test_x" }, "secret_key_not_test"],
      [{ ...PREVIEW, STRIPE_WEBHOOK_SECRET: undefined }, "webhook_secret_missing"],
      [{ ...PREVIEW, STRIPE_RESTRICTED_KEY: "rk_live_x" }, "live_key_present"],
      [{ ...PREVIEW, STRIPE_PUBLISHABLE_KEY: "pk_live_x" }, "live_key_present"],
      [{ ...PREVIEW, PAYMENT_PROVIDER: "mock" }, "dangerous_config"],
      [{ ...PREVIEW, STRIPE_API_BASE: "http://127.0.0.1:12111" }, "api_base_not_allowed"], // Preview では接続先を差し替えない
      [{ ...LOCAL, STRIPE_API_BASE: "http://evil.example:80" }, "api_base_not_allowed"],
      [{ ...LOCAL, FIREBASE_PROJECT_ID: "uranai-preview" }, "unsupported_environment"], // ローカルは demo- だけ
      [{ ...LOCAL, FIRESTORE_EMULATOR_HOST: "firestore.googleapis.com" }, "unsupported_environment"],
      [{ ...LOCAL, FIRESTORE_EMULATOR_HOST: undefined }, "unsupported_environment"],
      [{ ...LOCAL, VERCEL_ENV: "development" }, "unsupported_environment"],
    ];
    for (const [env, reason] of cases) expect(stripeTestConfig(env), JSON.stringify(env)).toEqual({ ok: false, reason });
    expect(stripeTestConfig({ ...LOCAL, STRIPE_API_BASE: "http://127.0.0.1:12111" })).toMatchObject({ ok: true, apiBase: { host: "127.0.0.1", port: 12111, protocol: "http" } });
    // PAY.JP は廃止：PAYJP_* が残っていても読まない（Stripe のテスト決済の判定に影響しない）
    expect(stripeTestConfig({ ...PREVIEW, PAYJP_SECRET_KEY: "sk_live_payjp", PAYJP_PUBLIC_KEY: "pk_live_payjp" })).toMatchObject({ ok: true, mode: "preview" });
  });

  it("本番の環境変数に Stripe のテスト設定があれば警告する（値は出さない）", () => {
    const base = { VERCEL_ENV: "production", CRON_SECRET: "x".repeat(32) };
    const issues = productionConfigIssues({ ...base, STRIPE_TEST_CHECKOUT: "on", STRIPE_SECRET_KEY: "sk_test_SECRETVALUE" });
    expect(issues.map((i) => [i.level, i.key])).toEqual([["error", "STRIPE_TEST_CHECKOUT"], ["warning", "STRIPE_KEYS"]]);
    expect(JSON.stringify(issues)).not.toContain("SECRETVALUE");
  });
});

describe("テスト決済は売上・精算に含めない", () => {
  it("Stripe のテスト決済（livemode=false）は売上・月次精算の対象外", () => {
    expect(paymentKind("stripe", false)).toBe("test");
    expect(isSalesPayment("stripe", false, { VERCEL_ENV: "preview" })).toBe(false);
    expect(isSettlementPayment("stripe", false)).toBe(false);
    expect(isSalesPayment("stripe", undefined)).toBe(false);
  });
});

// ---- Session の検証（Stripe API から取り直した値の照合） ----
const CO = "0f5c2f6e-1c1a-4c79-9a59-0f2f3c3b1a10";
function session(over: Record<string, unknown> = {}, pi: Record<string, unknown> = {}, charge: Record<string, unknown> = {}, bt: Record<string, unknown> | null | string = {}): Stripe.Checkout.Session {
  const md = { checkoutId: CO, storeId: "store-1", fortuneType: "ZODIAC" };
  const balance = bt === null || typeof bt === "string" ? bt : { id: "txn_test_1", object: "balance_transaction", currency: "jpy", fee: 4, ...bt };
  const ch = { id: "ch_test_1", object: "charge", livemode: false, status: "succeeded", paid: true, captured: true, refunded: false, amount_refunded: 0, currency: "jpy", amount: 100, payment_intent: "pi_test_1", created: 1_790_000_000, payment_method_details: { type: "card", card: { wallet: null } }, balance_transaction: balance, ...charge };
  const p = { id: "pi_test_1", object: "payment_intent", livemode: false, status: "succeeded", currency: "jpy", amount: 100, amount_received: 100, metadata: md, latest_charge: ch, ...pi };
  return { id: "cs_test_abc", object: "checkout.session", livemode: false, mode: "payment", status: "complete", payment_status: "paid", currency: "jpy", amount_total: 100, client_reference_id: CO, metadata: md, payment_intent: p, ...over } as unknown as Stripe.Checkout.Session;
}

describe("Stripe の決済の照合（金額・通貨・注文・店舗・状態）", () => {
  let validateStripeSession: typeof import("@/lib/payments/stripe-checkout").validateStripeSession;
  beforeEach(async () => {
    ({ validateStripeSession } = await import("@/lib/payments/stripe-checkout"));
  });

  it("正しいテスト決済は通る。手数料は Stripe の確定値", () => {
    const v = validateStripeSession(session());
    expect(v).toMatchObject({ ok: true, facts: { checkoutId: CO, storeId: "store-1", fortuneType: "ZODIAC", amount: 100, paymentIntentId: "pi_test_1", chargeId: "ch_test_1", fee: 4, balanceTransactionId: "txn_test_1", refunded: false } });
  });

  it("手数料が未確定（明細が無い・展開されていない）なら null（推定値で記録し、後で確定値に直す）", () => {
    expect(validateStripeSession(session({}, {}, {}, null))).toMatchObject({ ok: true, facts: { fee: null, balanceTransactionId: null } });
    expect(validateStripeSession(session({}, {}, {}, "txn_test_x"))).toMatchObject({ ok: true, facts: { fee: null, balanceTransactionId: "txn_test_x" } });
    expect(validateStripeSession(session({}, {}, {}, { fee: 500 }))).toMatchObject({ ok: true, facts: { fee: null } }); // 金額より大きい手数料は信用しない
  });

  it("未払い・処理中は not_paid、それ以外の食い違いは rejected", () => {
    const cases: [Stripe.Checkout.Session, string, string][] = [
      [session({ status: "open", payment_status: "unpaid" }), "not_paid", "session_open_unpaid"],
      [session({ status: "expired", payment_status: "unpaid" }), "not_paid", "session_expired_unpaid"],
      [session({}, { status: "processing" }), "not_paid", "payment_intent_processing"],
      [session({}, {}, { captured: false }), "not_paid", "charge_not_captured"],
      [session({ livemode: true }), "rejected", "livemode"],
      [session({ id: "cs_live_abc" }), "rejected", "not_test_session"],
      [session({ currency: "usd" }), "rejected", "currency_mismatch"],
      [session({ amount_total: 200 }), "rejected", "amount_mismatch"],
      [session({}, { amount_received: 50 }), "rejected", "amount_mismatch"],
      [session({ client_reference_id: "0f5c2f6e-1c1a-4c79-9a59-000000000000" }), "rejected", "checkout_id_mismatch"],
      [session({ metadata: { checkoutId: "not-a-uuid", storeId: "store-1", fortuneType: "ZODIAC" }, client_reference_id: "not-a-uuid" }), "rejected", "checkout_id_mismatch"],
      [session({ metadata: { checkoutId: CO, storeId: "", fortuneType: "ZODIAC" } }), "rejected", "metadata_invalid"],
      [session({}, { metadata: { checkoutId: CO, storeId: "store-2", fortuneType: "ZODIAC" } }), "rejected", "payment_intent_metadata_mismatch"],
      [session({ payment_intent: "pi_test_1" }), "rejected", "payment_intent_not_expanded"],
      [session({}, { latest_charge: "ch_test_1" }), "rejected", "charge_not_expanded"],
      [session({}, {}, { amount: 1000 }), "rejected", "charge_mismatch"],
      [session({}, {}, { payment_intent: "pi_other" }), "rejected", "charge_mismatch"],
      [session({}, {}, { payment_method_details: { type: "konbini" } }), "rejected", "payment_method_not_allowed"],
      [session({}, {}, { payment_method_details: { type: "link" } }), "rejected", "payment_method_not_allowed"],
      [session({}, {}, { payment_method_details: { type: "card", card: { wallet: { type: "samsung_pay" } } } }), "rejected", "payment_method_not_allowed"],
      [session({}, {}, { payment_method_details: { type: "card", card: { wallet: { type: "link" } } } }), "rejected", "payment_method_not_allowed"],
      [session({}, {}, { payment_method_details: { type: "card" } }), "rejected", "payment_method_not_allowed"], // カードの明細が無い
      // PayPay の確定待ち（手続き済み・未払い）は権利を付与しない
      [session({ payment_status: "unpaid" }, { status: "processing" }), "not_paid", "session_complete_unpaid"],
      [session({}, { status: "requires_payment_method" }), "not_paid", "payment_intent_requires_payment_method"],
    ];
    for (const [s, status, reason] of cases) expect(validateStripeSession(s), reason).toEqual({ ok: false, status, reason });
    expect(validateStripeSession(session({}, {}, { amount_refunded: 100, refunded: true }))).toMatchObject({ ok: true, facts: { refunded: true } });
  });

  it("カード・Apple Pay・Google Pay・PayPay は通り、支払い方法を記録する", () => {
    const pm = (d: Record<string, unknown>) => validateStripeSession(session({}, {}, { payment_method_details: d }));
    expect(pm({ type: "card", card: { wallet: null } })).toMatchObject({ ok: true, facts: { paymentMethod: "card" } });
    expect(pm({ type: "card", card: { wallet: { type: "apple_pay" } } })).toMatchObject({ ok: true, facts: { paymentMethod: "apple_pay" } });
    expect(pm({ type: "card", card: { wallet: { type: "google_pay" } } })).toMatchObject({ ok: true, facts: { paymentMethod: "google_pay" } });
    expect(pm({ type: "paypay", paypay: {} })).toMatchObject({ ok: true, facts: { paymentMethod: "paypay" } });
  });
});

describe("支払いが確定していない Session の扱い（注文を閉じてよいか）", () => {
  let stripeSessionState: typeof import("@/lib/payments/stripe-checkout").stripeSessionState;
  beforeEach(async () => {
    ({ stripeSessionState } = await import("@/lib/payments/stripe-checkout"));
  });
  it("requires_payment_method だけでは失敗にしない。確定待ちは閉じない。期限切れ・取り消しだけ最終", () => {
    const st = (over: Record<string, unknown>, pi: Record<string, unknown> | null = {}) =>
      stripeSessionState(pi === null ? session({ payment_intent: null, ...over }) : session(over, pi));
    expect(st({})).toBe("paid");
    expect(st({ status: "open", payment_status: "unpaid" }, { status: "requires_payment_method" })).toBe("retryable"); // カードの拒否など。支払い直せる
    expect(st({ status: "open", payment_status: "unpaid" }, null)).toBe("retryable");
    expect(st({ payment_status: "unpaid" }, { status: "processing" })).toBe("awaiting"); // PayPay の確定待ち
    expect(st({ payment_status: "unpaid" }, { status: "requires_action" })).toBe("awaiting");
    expect(st({ payment_status: "unpaid" }, { status: "requires_payment_method" })).toBe("failed_candidate"); // 失敗の通知があったときだけ失敗
    expect(st({ status: "expired", payment_status: "unpaid" }, { status: "processing" })).toBe("awaiting"); // 期限後でも確定待ちなら閉じない
    expect(st({ status: "expired", payment_status: "unpaid" }, { status: "requires_payment_method" })).toBe("expired");
    expect(st({ status: "expired", payment_status: "unpaid" }, { status: "canceled" })).toBe("canceled");
  });
});

describe("返金の状態（処理中・成功・一部・失敗）", () => {
  let summarizeRefunds: typeof import("@/lib/payments/stripe-checkout").summarizeRefunds;
  beforeEach(async () => {
    ({ summarizeRefunds } = await import("@/lib/payments/stripe-checkout"));
  });
  const rf = (id: string, status: string, amount = 100, over: Record<string, unknown> = {}) => ({ id, object: "refund", charge: "ch_test_1", currency: "jpy", amount, status, ...over }) as unknown as Stripe.Refund;
  it("返金の一覧から状態を求める", () => {
    const s = (...r: Stripe.Refund[]) => summarizeRefunds("ch_test_1", 100, r).state;
    expect(s()).toBe("none");
    expect(s(rf("re_1", "pending"))).toBe("pending");
    expect(s(rf("re_1", "requires_action"))).toBe("pending");
    expect(s(rf("re_1", "succeeded"))).toBe("succeeded");
    expect(s(rf("re_1", "succeeded", 30))).toBe("partial");
    expect(s(rf("re_1", "failed"))).toBe("failed");
    expect(s(rf("re_1", "canceled"))).toBe("failed");
    expect(s(rf("re_1", "failed"), rf("re_2", "succeeded"))).toBe("succeeded"); // 失敗の後に返金し直して成功
    expect(s(rf("re_1", "failed"), rf("re_2", "pending"))).toBe("pending");
    expect(s(rf("re_1", "weird_new_status"))).toBe("pending"); // 不明な状態は処理中とみなす（権利を止める）
    expect(s(rf("re_1", "succeeded", 100, { charge: "ch_other" }))).toBe("none"); // 別の Charge の返金は数えない
    expect(s(rf("re_1", "succeeded", 100, { currency: "usd" }))).toBe("none");
  });
  it("同じ返金は ID 順にまとめる（通知の順番が入れ替わっても同じ結果）", () => {
    const a = summarizeRefunds("ch_test_1", 100, [rf("re_b", "failed"), rf("re_a", "succeeded")]);
    const b = summarizeRefunds("ch_test_1", 100, [rf("re_a", "succeeded"), rf("re_b", "failed")]);
    expect(a).toEqual(b);
    expect(a).toEqual({ state: "succeeded", succeededAmount: 100, pendingAmount: 0, failedAmount: 100, refundIds: ["re_a", "re_b"] });
  });
});

// ---- Webhook（署名・重複・振り分け）。Firestore と確定処理は模擬 ----
const hooks = vi.hoisted(() => ({ begin: true, calls: [] as string[], fail: false }));
vi.mock("@/lib/firestore/payments", () => ({
  beginWebhookEvent: async (_p: string, id: string) => {
    hooks.calls.push(`begin:${id}`);
    return hooks.begin;
  },
  finishWebhookEvent: async (_p: string, id: string) => void hooks.calls.push(`finish:${id}`),
}));
vi.mock("@/lib/payments/stripe-confirm", () => ({
  confirmStripeCheckout: async (id: string) => {
    hooks.calls.push(`confirm:${id}`);
    if (hooks.fail) throw new Error("boom");
    return { status: "confirmed", transactionId: "stripe_pi" };
  },
  closeStripeCheckout: async (id: string, opts?: { asyncFailed?: boolean }) => (hooks.calls.push(`close:${id}${opts?.asyncFailed ? ":async_failed" : ""}`), "expired"),
  syncStripeRefunds: async (id: string) => (hooks.calls.push(`refund:${id}`), "refunded"),
  refreshStripeFee: async (id: string) => (hooks.calls.push(`fee:${id}`), true),
}));

describe("Stripe の Webhook", () => {
  const signer = new Stripe("sk_test_unit");
  const post = async (event: Record<string, unknown>, opts: { secret?: string; tamper?: boolean } = {}) => {
    const payload = JSON.stringify(event);
    const header = signer.webhooks.generateTestHeaderString({ payload, secret: opts.secret ?? "whsec_unit_secret" });
    const { POST } = await import("@/app/api/webhooks/stripe/route");
    return POST(new Request("http://localhost/api/webhooks/stripe", { method: "POST", headers: { "stripe-signature": header }, body: opts.tamper ? payload.replace("cs_test", "cs_tEst") : payload }));
  };
  const ev = (type: string, object: Record<string, unknown>, over: Record<string, unknown> = {}) => ({ id: `evt_test_${type}`, object: "event", type, livemode: false, data: { object }, ...over });

  beforeEach(() => {
    for (const [k, v] of Object.entries(LOCAL)) vi.stubEnv(k, v);
    hooks.begin = true;
    hooks.calls = [];
    hooks.fail = false;
    vi.resetModules();
  });
  afterEach(() => vi.unstubAllEnvs());

  it("署名が正しい通知だけ受け付け、Stripe API で確定する（通知の中身は使わない）", async () => {
    const r = await post(ev("checkout.session.completed", { id: "cs_test_abc", object: "checkout.session" }));
    expect(r.status).toBe(200);
    expect(hooks.calls).toEqual(["begin:evt_test_checkout.session.completed", "confirm:cs_test_abc", "finish:evt_test_checkout.session.completed"]);
  });

  it("署名の不一致・改ざん・別の秘密の値は 400。本番の通知も 400。何も処理しない", async () => {
    expect((await post(ev("checkout.session.completed", { id: "cs_test_abc" }), { tamper: true })).status).toBe(400);
    expect((await post(ev("checkout.session.completed", { id: "cs_test_abc" }), { secret: "whsec_other" })).status).toBe(400);
    expect((await post(ev("checkout.session.completed", { id: "cs_test_abc" }, { livemode: true }))).status).toBe(400);
    const { POST } = await import("@/app/api/webhooks/stripe/route");
    expect((await POST(new Request("http://localhost/x", { method: "POST", body: "{}" }))).status).toBe(400); // 署名なし
    expect(hooks.calls).toEqual([]);
  });

  it("重複・再送は処理済みなら何もしない", async () => {
    hooks.begin = false;
    const r = await post(ev("checkout.session.completed", { id: "cs_test_abc" }));
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ duplicate: true });
    expect(hooks.calls).toEqual(["begin:evt_test_checkout.session.completed"]);
  });

  it("処理に失敗したら 500（Stripe が再送する）。処理済みにはしない", async () => {
    hooks.fail = true;
    expect((await post(ev("checkout.session.completed", { id: "cs_test_abc" }))).status).toBe(500);
    expect(hooks.calls).not.toContain("finish:evt_test_checkout.session.completed");
  });

  it("期限切れ・失敗・返金・手数料の確定・関係ない通知の振り分け", async () => {
    await post(ev("checkout.session.expired", { id: "cs_test_exp" }));
    await post(ev("checkout.session.async_payment_failed", { id: "cs_test_fail" }, { id: "evt_test_fail" }));
    await post(ev("checkout.session.async_payment_succeeded", { id: "cs_test_paypay" }));
    await post(ev("charge.refunded", { id: "ch_test_1" }));
    await post(ev("refund.updated", { id: "re_1", object: "refund", charge: "ch_test_3" }));
    await post(ev("refund.failed", { id: "re_2", object: "refund", charge: { id: "ch_test_4" } }));
    await post(ev("charge.refund.updated", { id: "re_3", object: "refund", charge: "ch_test_5" }));
    await post(ev("refund.created", { id: "re_4", object: "refund", charge: "ch_test_6" }));
    await post(ev("charge.updated", { id: "ch_test_2" }));
    const r = await post(ev("customer.created", { id: "cus_1" }));
    expect(await r.json()).toMatchObject({ outcome: "ignored" });
    expect(hooks.calls.filter((c) => !c.startsWith("begin") && !c.startsWith("finish"))).toEqual([
      "close:cs_test_exp",
      "close:cs_test_fail:async_failed", // 非同期の支払いの失敗の通知だけが「失敗」の根拠になる
      "confirm:cs_test_paypay",
      "refund:ch_test_1",
      "refund:ch_test_3",
      "refund:ch_test_4",
      "refund:ch_test_5",
      "refund:ch_test_6",
      "fee:ch_test_2",
    ]);
  });

  it("テスト決済の設定が欠けていたら 404（何も処理しない）", async () => {
    vi.stubEnv("STRIPE_TEST_CHECKOUT", "");
    vi.resetModules();
    expect((await post(ev("checkout.session.completed", { id: "cs_test_abc" }))).status).toBe(404);
    vi.stubEnv("STRIPE_TEST_CHECKOUT", "on");
    vi.stubEnv("STRIPE_SECRET_KEY", "sk_live_x");
    vi.resetModules();
    expect((await post(ev("checkout.session.completed", { id: "cs_test_abc" }))).status).toBe(404);
    expect(hooks.calls).toEqual([]);
  });
});

// ---- 利用者（運営アカウントだけ） ----
const auth = vi.hoisted(() => ({ user: null as null | { id: string; role: "OPERATOR" | "STORE" } }));
vi.mock("@/lib/auth/session", () => ({ getSessionUser: async () => auth.user }));

describe("Stripe のテスト決済を使える人", () => {
  afterEach(() => vi.unstubAllEnvs());
  const load = async (env: Record<string, string>) => {
    for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
    vi.resetModules();
    return (await import("@/lib/payments/stripe-access")).stripeTestAccess();
  };
  it("運営アカウントでログイン中だけ。ログインなし・店舗アカウント・設定の不足・弱い SESSION_SECRET は不可", async () => {
    auth.user = { id: "op", role: "OPERATOR" };
    expect(await load(LOCAL)).toMatchObject({ ok: true });
    auth.user = { id: "st", role: "STORE" };
    expect(await load(LOCAL)).toEqual({ ok: false, reason: "not_operator" });
    auth.user = null;
    expect(await load(LOCAL)).toEqual({ ok: false, reason: "not_logged_in" });
    auth.user = { id: "op", role: "OPERATOR" };
    expect(await load({ ...LOCAL, SESSION_SECRET: "s".repeat(40) })).toEqual({ ok: false, reason: "weak_secret" });
    expect(await load({ ...LOCAL, STRIPE_WEBHOOK_SECRET: "" })).toEqual({ ok: false, reason: "webhook_secret_missing" });
  });
});

// ---- 占いの選択画面の Stripe テスト決済の入口（/fortune?pay=stripe-test） ----
describe("Stripe テスト決済の専用の入口", () => {
  it("pay=stripe-test・テスト決済を使える人（運営）・止めていない・実店舗のときだけ開く", async () => {
    const { stripeTestEntry } = await import("@/lib/payments/stripe-test-entry");
    const base = { pay: "stripe-test", stripeOk: true, halted: false, realStoreCode: true };
    expect(stripeTestEntry(base)).toBe("stripe-test");
    expect(stripeTestEntry({ ...base, realStoreCode: false })).toBe("real_store_required"); // テスト店舗・QR なし
    // パラメーターが違う・無い、運営以外（テスト決済を使えない）、危険な設定で停止中は今までどおり
    for (const pay of [undefined, "", "stripe", "STRIPE-TEST", ["stripe-test"], "stripe-test "]) expect(stripeTestEntry({ ...base, pay }), String(pay)).toBe("off");
    expect(stripeTestEntry({ ...base, stripeOk: false })).toBe("off");
    expect(stripeTestEntry({ ...base, stripeOk: false, realStoreCode: false })).toBe("off"); // 運営以外には案内も出さない
    expect(stripeTestEntry({ ...base, halted: true })).toBe("off");
  });
});

describe("Managed Payments は使わない・Session の期限・エラーのログ", () => {
  it("確定時に取り直した Session が Managed Payments なら記録しない", async () => {
    const { validateStripeSession } = await import("@/lib/payments/stripe-checkout");
    expect(validateStripeSession(session({ managed_payments: { enabled: true } }))).toEqual({ ok: false, status: "rejected", reason: "managed_payments_not_allowed" });
    expect(validateStripeSession(session({ managed_payments: { enabled: false } }))).toMatchObject({ ok: true });
    expect(validateStripeSession(session({ managed_payments: null }))).toMatchObject({ ok: true });
  });

  it("Session の期限は作る時刻から31分以上・分単位（同じ分の連打は同じ値）", async () => {
    const { stripeSessionExpiry } = await import("@/lib/payments/stripe-checkout");
    const now = Date.UTC(2026, 9, 26, 3, 15, 20);
    const e = stripeSessionExpiry(now).getTime();
    expect(e - now).toBeGreaterThanOrEqual(31 * 60_000);
    expect(e - now).toBeLessThan(32 * 60_000);
    expect(e % 60_000).toBe(0);
    expect(stripeSessionExpiry(now + 30_000).getTime()).toBe(e);
  });

  it("Stripe のエラーのログは種類・コード・項目名・リクエストID だけ（エラー文やキーを含めない）", async () => {
    const { stripeErrorSummary } = await import("@/lib/payments/stripe-checkout");
    const err = Object.assign(new Error("Invalid API Key provided: sk_test_****abcd"), { name: "StripeInvalidRequestError", type: "invalid_request_error", code: "parameter_unknown", param: "allowed_payment_method_types", statusCode: 400, requestId: "req_test_123" });
    const s = stripeErrorSummary(err);
    expect(s).toEqual({ name: "StripeInvalidRequestError", type: "invalid_request_error", code: "parameter_unknown", param: "allowed_payment_method_types", statusCode: 400, requestId: "req_test_123" });
    expect(JSON.stringify(s)).not.toContain("sk_test");
    expect(stripeErrorSummary(Object.assign(new Error("x"), { param: "a b sk_test_123 <script>" })).param).toBeNull();
    expect(stripeErrorSummary(null)).toMatchObject({ name: null, statusCode: null });
  });
});
