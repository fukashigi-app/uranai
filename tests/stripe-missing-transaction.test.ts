import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { checkoutIdOf, decideAfterConfirmForSync, isOurPayment, planMissingTransaction, sessionPaymentIntentMatches } from "@/lib/payments/stripe-sync-rules";

// 課題2・対策A：決済記録が無いときに届いた返金・異議申し立ての通知の扱い
const isTestSession = (v: unknown) => typeof v === "string" && /^cs_test_[A-Za-z0-9]+$/.test(v);
const stripeCheckout = { exists: true, provider: "stripe", providerPaymentId: "cs_test_abc123" };

describe("checkoutIdOf（metadata の注文ID）", () => {
  it("文書の ID として使える形だけを返す", () => {
    expect(checkoutIdOf({ metadata: { checkoutId: "co_12-AB" } })).toBe("co_12-AB");
    for (const v of ["", "a/b", "../x", "x".repeat(129), "has space"]) expect(checkoutIdOf({ metadata: { checkoutId: v } })).toBeNull();
    expect(checkoutIdOf({ metadata: {} })).toBeNull();
  });
});

describe("planMissingTransaction（正常な先着・本当の異常の区別）", () => {
  const plan = (over: Partial<Parameters<typeof planMissingTransaction>[0]>) =>
    planMissingTransaction({ ourPayment: true, checkoutId: "co_1", checkout: stripeCheckout, isSessionId: isTestSession, ...over });

  it("正常な先着：注文があり、このモードの Session が紐付いていれば、その Session で確定を試みる", () => {
    expect(plan({})).toEqual({ kind: "confirm", sessionId: "cs_test_abc123" });
  });

  it("このアプリの決済ではない：何もしない（今までどおり記録もしない）", () => {
    expect(plan({ ourPayment: false })).toEqual({ kind: "skip" });
    expect(plan({ ourPayment: false, checkoutId: null, checkout: null })).toEqual({ kind: "skip" });
  });

  it("本当の異常：注文IDの形が不正・注文が無い・Stripe の注文ではない・Session が紐付いていない（推測で探さない）", () => {
    expect(plan({ checkoutId: null, checkout: null })).toEqual({ kind: "review", reason: "invalid_checkout_id" });
    expect(plan({ checkout: null })).toEqual({ kind: "review", reason: "checkout_not_found" });
    expect(plan({ checkout: { exists: false } })).toEqual({ kind: "review", reason: "checkout_not_found" });
    expect(plan({ checkout: { ...stripeCheckout, provider: "mock" } })).toEqual({ kind: "review", reason: "checkout_not_stripe" });
    expect(plan({ checkout: { ...stripeCheckout, providerPaymentId: null } })).toEqual({ kind: "review", reason: "session_not_linked" });
    expect(plan({ checkout: { ...stripeCheckout, providerPaymentId: "" } })).toEqual({ kind: "review", reason: "session_not_linked" });
    // 別のモードの Session（テストと本番の取り違え）は確定しない
    expect(plan({ checkout: { ...stripeCheckout, providerPaymentId: "cs_live_abc123" } })).toEqual({ kind: "review", reason: "session_not_linked" });
  });

  it("isOurPayment と組み合わせても、注文IDの無い決済は skip（記録しない）、形の不正な注文IDは review", () => {
    expect(isOurPayment({ metadata: { storeId: "s1" } })).toBe(false);
    const meta = { metadata: { checkoutId: "a/b", storeId: "s1" } };
    expect(planMissingTransaction({ ourPayment: isOurPayment(meta), checkoutId: checkoutIdOf(meta), checkout: null, isSessionId: isTestSession })).toEqual({
      kind: "review",
      reason: "invalid_checkout_id",
    });
  });
});

describe("decideAfterConfirmForSync（確定の結果の扱い）", () => {
  it("確定できた（確定済み・返金済みを含む）なら反映をやり直す", () => {
    for (const s of ["confirmed", "duplicate", "refunded"] as const) expect(decideAfterConfirmForSync(s)).toBe("retry_sync");
  });
  it("支払いの確定待ちは一時的（500 で再送させる。200・ignored で握りつぶさない）", () => {
    expect(decideAfterConfirmForSync("not_paid")).toBe("retryable");
  });
  it("確定の拒否は本当の異常（記録する）", () => {
    expect(decideAfterConfirmForSync("rejected")).toBe("review");
  });
});

describe("sessionPaymentIntentMatches（Session と通知の対象の PaymentIntent の一致）", () => {
  it("期待する値が無い（通常の確定）なら照合しない", () => {
    expect(sessionPaymentIntentMatches("pi_a", undefined)).toBe(true);
    expect(sessionPaymentIntentMatches(null, undefined)).toBe(true);
  });
  it("一致：ID の文字列・展開されたオブジェクトのどちらでも", () => {
    expect(sessionPaymentIntentMatches("pi_a", "pi_a")).toBe(true);
    expect(sessionPaymentIntentMatches({ id: "pi_a", object: "payment_intent" }, "pi_a")).toBe(true);
  });
  it("不一致：別の PaymentIntent・Session に PaymentIntent が無い（未払い）・形が不正は、どれも確定しない", () => {
    expect(sessionPaymentIntentMatches("pi_b", "pi_a")).toBe(false);
    expect(sessionPaymentIntentMatches({ id: "pi_b" }, "pi_a")).toBe(false);
    for (const v of [null, undefined, "", 123, {}, { id: 1 }]) expect(sessionPaymentIntentMatches(v, "pi_a")).toBe(false);
  });
});

describe("stripe-confirm.ts の組み込み（ソースの確認）", () => {
  const src = readFileSync(path.join(__dirname, "../src/lib/payments/stripe-confirm.ts"), "utf8");
  const fnBody = (name: string) => {
    const start = src.indexOf(`export async function ${name}(`);
    expect(start).toBeGreaterThan(-1);
    const next = src.indexOf("\nexport ", start + 10);
    return src.slice(start, next === -1 ? undefined : next);
  };

  for (const name of ["syncStripeRefunds", "syncStripeDispute"]) {
    it(`${name}：確定はトランザクションの後で、やり直しは1回だけ（confirmFirst: false）`, () => {
      const body = fnBody(name);
      const txEnd = body.lastIndexOf("});", body.indexOf("confirmBeforeSync"));
      const txStart = body.indexOf("fsdb().runTransaction(");
      // Stripe API を呼ぶ確定（confirmBeforeSync）は、Firestore のトランザクションの外（終わった後）
      expect(txStart).toBeGreaterThan(-1);
      expect(body.indexOf("confirmBeforeSync")).toBeGreaterThan(txEnd);
      expect(txEnd).toBeGreaterThan(txStart);
      // やり直しは確定を試みない（入れ子・無限の繰り返しにしない）
      expect(body).toMatch(new RegExp(`return ${name}\\([^)]*\\{ confirmFirst: false \\}\\)`));
      // 決済記録が無いときの決済要確認（transaction_not_found）は残す（本当の異常の検出を消さない）
      expect(body).toContain('kind: "transaction_not_found"');
      expect(body).toContain("await recordSyncReview(res.review, r0, eventId);");
    });
  }

  it("先着の通知からの確定は、通知の対象の PaymentIntent を渡す。照合は検証・返金と異議申し立ての読み取り・書き込みより前", () => {
    expect(src).toContain("confirmStripeCheckout(plan.sessionId, r0, { expectedPaymentIntentId: pi.id })");
    const body = fnBody("confirmStripeCheckout");
    const check = body.indexOf("sessionPaymentIntentMatches(session.payment_intent, opts.expectedPaymentIntentId)");
    expect(check).toBeGreaterThan(-1);
    for (const later of ["validateStripeSession(", "readStripeChargeAdjustments(", "fsdb().runTransaction("]) expect(body.indexOf(later)).toBeGreaterThan(check);
    expect(body.slice(check, body.indexOf("validateStripeSession("))).toContain('return { status: "rejected", reason: "payment_intent_mismatch" }');
  });

  it("決済の確定の中の再確認・運営の権利の復旧からは、確定を入れ子にしない", () => {
    expect(src).toContain('syncStripeRefunds(f.chargeId, r0, "confirm_recheck", undefined, { confirmFirst: false })');
    expect(src).toContain('syncStripeDispute(now.dispute.id, r0, "confirm_recheck", undefined, { confirmFirst: false })');
    expect(src).toContain('syncStripeRefunds(charge.id, r0, "entitlement_restore", undefined, { confirmFirst: false })');
    expect(src).toContain('syncStripeDispute(verified.disputeId, r0, "entitlement_restore", undefined, { confirmFirst: false })');
  });
});
