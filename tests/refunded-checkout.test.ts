import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { isCheckoutRefundReason, refundedNotice } from "@/lib/payments/refunded-notice";
import { stripeCheckoutStatus } from "@/lib/payments/stripe-confirm";
import type { StripeRuntime } from "@/lib/payments/stripe-checkout";

// 返金済み・チャージバックの注文（REFUNDED）。Firestore・Stripe には接続しない
const NOT_CHARGED = "請求は発生していません";

describe("返金済みの注文の案内", () => {
  it("理由は refund・chargeback だけ", () => {
    expect(isCheckoutRefundReason("refund")).toBe(true);
    expect(isCheckoutRefundReason("chargeback")).toBe(true);
    for (const v of [undefined, null, "", "REFUND", "dispute", 1]) expect(isCheckoutRefundReason(v)).toBe(false);
  });

  it("返金・チャージバック・理由なしで、占いを開始できないことを案内する。「請求は発生していません」とは言わない", () => {
    const refund = refundedNotice("refund");
    const chargeback = refundedNotice("chargeback");
    expect(refund.title).toMatch(/返金済み/);
    expect(refund.body).toMatch(/占いを開始できません/);
    expect(chargeback.body).toMatch(/チャージバック/);
    expect(chargeback.body).toMatch(/占いを開始できません/);
    expect(refundedNotice(null)).toEqual(refund); // 理由の記録が無いときは返金として案内する
    expect(refundedNotice(undefined)).toEqual(refund);
    for (const n of [refund, chargeback]) expect(n.title + n.body).not.toContain(NOT_CHARGED);
  });
});

describe("注文の状態の確認（/api/checkout/status）", () => {
  // Stripe との接続は使わない（使われたら失敗させる）
  const rt = new Proxy({}, { get: () => { throw new Error("Stripe must not be called"); } }) as StripeRuntime;
  const base = { id: "co_1", provider: "stripe", providerPaymentId: "cs_test_1", expiresAt: new Date(0), storeId: "st_1", fortuneType: "ZODIAC" };

  it("REFUNDED は refunded と理由を返す（期限が過ぎていても、Stripe に問い合わせない）", async () => {
    expect(await stripeCheckoutStatus({ ...base, status: "REFUNDED", refundReason: "refund" }, rt)).toEqual({ status: "refunded", refundReason: "refund" });
    expect(await stripeCheckoutStatus({ ...base, status: "REFUNDED", refundReason: "chargeback" }, rt)).toEqual({ status: "refunded", refundReason: "chargeback" });
    expect(await stripeCheckoutStatus({ ...base, status: "REFUNDED", refundReason: "something_else" }, rt)).toEqual({ status: "refunded", refundReason: null });
    expect(await stripeCheckoutStatus({ ...base, status: "REFUNDED" }, rt)).toEqual({ status: "refunded", refundReason: null });
  });

  it("ほかの状態は今までどおり", async () => {
    expect(await stripeCheckoutStatus({ ...base, status: "SUCCEEDED" }, rt)).toEqual({ status: "succeeded" });
    expect(await stripeCheckoutStatus({ ...base, status: "FAILED" }, rt)).toEqual({ status: "failed", failureCode: "stripe_failed" });
    expect(await stripeCheckoutStatus({ ...base, status: "EXPIRED" }, rt)).toEqual({ status: "expired" });
    expect(await stripeCheckoutStatus({ ...base, status: "CREATED", expiresAt: new Date(Date.now() + 60_000) }, rt)).toEqual({ status: "created" });
  });
});

describe("REFUNDED を上書き・削除しない（期限切れの処理）", () => {
  it("毎日のメンテナンスが期限切れにするのは CREATED・FAILED だけ。削除は Session の ID が無い注文だけ", () => {
    const src = readFileSync(path.join(process.cwd(), "src/lib/firestore/misc.ts"), "utf8");
    expect(src).toMatch(/\["CREATED", "FAILED"\]\.includes\(d\.get\("status"\)\)\)/);
    expect(src).toMatch(/\["EXPIRED", "FAILED", "CREATED"\]\.includes\(d\.get\("status"\)\) && !d\.get\("providerPaymentId"\)/);
    expect(src).not.toMatch(/"REFUNDED"/);
  });

  it("確認中の画面（クライアント）は refunded を返金の案内にする（「請求は発生していません」を出さない）", () => {
    const src = readFileSync(path.join(process.cwd(), "src/components/public/stripe-return-status.tsx"), "utf8");
    expect(src).toMatch(/json\?\.status === "refunded"/);
    expect(src).toMatch(/refundedNotice\(refundReason\)/);
  });
});
