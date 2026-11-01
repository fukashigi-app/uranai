import type Stripe from "stripe";
import { describe, expect, it } from "vitest";
import { readStripeChargeAdjustments, summarizeRefunds, StripeAdjustmentsUnverifiedError, type StripeRuntime } from "@/lib/payments/stripe-checkout";
import { decideConfirmState, decideDisputeSync, decideRefundSync, type DisputeFacts } from "@/lib/payments/stripe-sync-rules";

// 決済確定の時点の返金・異議申し立て（Stripe・Firestore には接続しない。Stripe との接続は形だけの偽物）
const NOW = new Date("2026-10-28T03:00:00Z");
const CH = "ch_test_adj";
const refund = (id: string, status: string, amount = 100, over: Record<string, unknown> = {}) => ({ id, object: "refund", charge: CH, currency: "jpy", amount, status, ...over }) as unknown as Stripe.Refund;
const dispute = (status: string, over: Record<string, unknown> = {}) => ({ id: "dp_test_adj", object: "dispute", livemode: false, charge: CH, currency: "jpy", amount: 100, status, reason: "fraudulent", ...over }) as unknown as Stripe.Dispute;

function rt(refunds: Stripe.Refund[], disputes: Stripe.Dispute[], opts: { refundsHasMore?: boolean; disputesHasMore?: boolean; fail?: "refunds" | "disputes" } = {}) {
  const calls: string[] = [];
  const client = {
    refunds: {
      list: async (p: { charge: string }) => {
        calls.push(`refunds:${p.charge}`);
        if (opts.fail === "refunds") throw Object.assign(new Error("api"), { type: "StripeAPIError" });
        return { data: refunds, has_more: opts.refundsHasMore ?? false };
      },
    },
    disputes: {
      list: async (p: { charge: string }) => {
        calls.push(`disputes:${p.charge}`);
        if (opts.fail === "disputes") throw Object.assign(new Error("api"), { type: "StripeAPIError" });
        return { data: disputes, has_more: opts.disputesHasMore ?? false };
      },
    },
  };
  return { rt: { mode: "test", client, webhookSecret: "whsec_x", allowHttpOrigin: false } as unknown as StripeRuntime, calls };
}
const charge = { id: CH, amount: 100, livemode: false };

describe("決済確定の前の、返金・異議申し立ての読み取り（readStripeChargeAdjustments）", () => {
  it("返金・異議申し立ての一覧を Charge で絞り込んで読み、まとめる", async () => {
    const r = rt([refund("re_1", "succeeded")], [dispute("needs_response")]);
    const a = await readStripeChargeAdjustments(charge, r.rt);
    expect(r.calls.sort()).toEqual([`disputes:${CH}`, `refunds:${CH}`]);
    expect(a.refunds).toEqual({ state: "succeeded", succeededAmount: 100, pendingAmount: 0, failedAmount: 0, refundIds: ["re_1"] });
    expect(a.dispute?.id).toBe("dp_test_adj");
    expect(await readStripeChargeAdjustments(charge, rt([], []).rt)).toEqual({ refunds: { state: "none", succeededAmount: 0, pendingAmount: 0, failedAmount: 0, refundIds: [] }, dispute: null });
  });

  it("Stripe API の失敗はそのまま例外（決済確定を進めない）", async () => {
    await expect(readStripeChargeAdjustments(charge, rt([], [], { fail: "refunds" }).rt)).rejects.toThrow("api");
    await expect(readStripeChargeAdjustments(charge, rt([], [], { fail: "disputes" }).rt)).rejects.toThrow("api");
  });

  it.each([
    ["返金が多すぎる（一覧の続きがある）", rt([], [], { refundsHasMore: true }), /too many refunds/],
    ["別の Charge の返金", rt([refund("re_1", "succeeded", 100, { charge: "ch_other" })], []), /refund_invalid/],
    ["返金の通貨が違う", rt([refund("re_1", "succeeded", 100, { currency: "usd" })], []), /refund_invalid/],
    ["返金の金額が決済を超える", rt([refund("re_1", "succeeded", 101)], []), /refund_invalid/],
    ["返金の金額が 0", rt([refund("re_1", "succeeded", 0)], []), /refund_invalid/],
    ["異議申し立てが複数", rt([], [dispute("needs_response"), dispute("lost", { id: "dp_test_2" })]), /multiple_disputes/],
    ["異議申し立ての一覧の続きがある", rt([], [dispute("needs_response")], { disputesHasMore: true }), /multiple_disputes/],
    ["異議申し立てのモードが違う", rt([], [dispute("lost", { livemode: true })]), /dispute_livemode/],
    ["異議申し立ての Charge が違う", rt([], [dispute("lost", { charge: "ch_other" })]), /dispute_charge_mismatch/],
    ["異議申し立ての通貨が違う", rt([], [dispute("lost", { currency: "usd" })]), /dispute_amount/],
    ["異議申し立ての金額が決済を超える", rt([], [dispute("lost", { amount: 101 })]), /dispute_amount/],
    ["異議申し立ての ID の形が違う", rt([], [dispute("lost", { id: "xx_1" })]), /dispute_id/],
  ] as const)("%s → 検証できない（例外）", async (_label, r, msg) => {
    await expect(readStripeChargeAdjustments(charge, r.rt)).rejects.toThrow(msg);
  });

  it("検証の失敗は StripeAdjustmentsUnverifiedError（理由のコードだけを持つ）", async () => {
    const e = await readStripeChargeAdjustments(charge, rt([], [dispute("lost", { currency: "usd" })]).rt).catch((x) => x);
    expect(e).toBeInstanceOf(StripeAdjustmentsUnverifiedError);
    expect((e as StripeAdjustmentsUnverifiedError).reason).toBe("dispute_amount");
    expect((e as Error).name).toBe("StripeAdjustmentsUnverifiedError");
  });
});

describe("決済確定の時点の決済記録・注文・占い権利（decideConfirmState）", () => {
  const sum = (...r: Stripe.Refund[]) => summarizeRefunds(CH, 100, r);
  const dp = (status: string, amount = 100): DisputeFacts => ({ id: "dp_test_adj", amount, currency: "jpy", status: status as Stripe.Dispute.Status, reason: "fraudulent" });

  it("返金も異議申し立ても無い：今までどおり（SUCCEEDED・項目なし・権利を付与）", () => {
    expect(decideConfirmState(100, sum(), null, NOW)).toEqual({ paymentStatus: "SUCCEEDED", fields: {}, entitlement: { grant: true, checkoutStatus: "SUCCEEDED", refundReason: null, suspendedByRefund: false, suspendedByDispute: false } });
  });

  it("返金が成功：REFUNDED・返金の項目と返金日時。権利は止めて作り、注文は REFUNDED（refund）", () => {
    const s = decideConfirmState(100, sum(refund("re_1", "succeeded")), null, NOW);
    expect(s.paymentStatus).toBe("REFUNDED");
    expect(s.fields).toMatchObject({ refundStatus: "succeeded", amountRefunded: 100, refundKey: "succeeded:100:0:0:re_1", refundNeedsReview: false, refundedAt: NOW });
    expect(s.entitlement).toEqual({ grant: false, checkoutStatus: "REFUNDED", refundReason: "refund", suspendedByRefund: true, suspendedByDispute: false });
  });

  it("返金の処理中：決済は SUCCEEDED のまま（売上・精算は減らさない）。権利は止める", () => {
    const s = decideConfirmState(100, sum(refund("re_1", "pending")), null, NOW);
    expect(s.paymentStatus).toBe("SUCCEEDED");
    expect(s.fields).toMatchObject({ refundStatus: "pending", refundPendingAmount: 100, amountRefunded: 0 });
    expect(s.fields).not.toHaveProperty("refundedAt");
    expect(s.entitlement).toMatchObject({ grant: false, checkoutStatus: "REFUNDED", refundReason: "refund" });
  });

  it("一部の返金：SUCCEEDED・管理者の確認。権利は止める", () => {
    const s = decideConfirmState(100, sum(refund("re_1", "succeeded", 30)), null, NOW);
    expect(s.paymentStatus).toBe("SUCCEEDED");
    expect(s.fields).toMatchObject({ refundStatus: "partial", amountRefunded: 30, refundNeedsReview: true });
    expect(s.entitlement).toMatchObject({ grant: false, refundReason: "refund" });
  });

  it("返金がすべて失敗：SUCCEEDED・管理者の確認。権利は付与する", () => {
    const s = decideConfirmState(100, sum(refund("re_1", "failed")), null, NOW);
    expect(s.paymentStatus).toBe("SUCCEEDED");
    expect(s.fields).toMatchObject({ refundStatus: "failed", refundNeedsReview: true });
    expect(s.entitlement.grant).toBe(true);
  });

  it("異議申し立ての対応中：権利は付与し、精算の保留に使う項目を記録する", () => {
    const s = decideConfirmState(100, sum(), dp("needs_response"), NOW);
    expect(s.paymentStatus).toBe("SUCCEEDED");
    expect(s.fields).toMatchObject({ disputeId: "dp_test_adj", disputeStatus: "open", disputeAmount: 100, disputeKey: "dp_test_adj:needs_response:100", disputeNeedsReview: true });
    expect(s.entitlement).toMatchObject({ grant: true, checkoutStatus: "SUCCEEDED" });
  });

  it("異議申し立ての敗訴（全額）：CHARGEBACK・チャージバック日時。権利は止め、注文は REFUNDED（chargeback）", () => {
    const s = decideConfirmState(100, sum(), dp("lost"), NOW);
    expect(s.paymentStatus).toBe("CHARGEBACK");
    expect(s.fields).toMatchObject({ disputeStatus: "lost", chargebackAt: NOW });
    expect(s.entitlement).toEqual({ grant: false, checkoutStatus: "REFUNDED", refundReason: "chargeback", suspendedByRefund: false, suspendedByDispute: true });
  });

  it("一部の額の敗訴：SUCCEEDED のまま（残りは売上に残す）。権利は止める（chargeback）", () => {
    const s = decideConfirmState(100, sum(), dp("lost", 40), NOW);
    expect(s.paymentStatus).toBe("SUCCEEDED");
    expect(s.fields).toMatchObject({ disputeStatus: "lost", disputeAmount: 40 });
    expect(s.fields).not.toHaveProperty("chargebackAt");
    expect(s.entitlement).toMatchObject({ grant: false, refundReason: "chargeback" });
  });

  it("確定の後に「返金 → 異議申し立て」の順に通知が届いたときと同じ項目・状態（すべての組み合わせ）", () => {
    const refundCases = [[], [refund("re_1", "succeeded")], [refund("re_1", "pending")], [refund("re_1", "succeeded", 30)], [refund("re_1", "failed")]];
    const disputeCases = [null, dp("needs_response"), dp("under_review"), dp("won"), dp("lost"), dp("lost", 40), dp("warning_closed")];
    for (const rs of refundCases) {
      for (const d of disputeCases) {
        const s = decideConfirmState(100, sum(...rs), d, NOW);
        // 何も反映していない決済記録に、確定の後の反映の処理を順に当てはめる
        let status = "SUCCEEDED";
        const fields: Record<string, unknown> = {};
        const summary = sum(...rs);
        if (summary.state !== "none") {
          const r = decideRefundSync({ paymentStatus: status, refundKey: undefined }, summary, NOW);
          if (r.kind === "apply") {
            Object.assign(fields, r.fields);
            if (r.statusChange) ({ paymentStatus: status } = r.statusChange), (fields.refundedAt = r.statusChange.refundedAt);
          }
        }
        if (d) {
          const x = decideDisputeSync({ disputeId: undefined, disputeStatus: undefined, disputeKey: undefined, paymentStatus: status, amount: 100, amountRefunded: Number(fields.amountRefunded ?? 0), refundStatus: fields.refundStatus ?? null }, d, NOW);
          if (x.kind === "apply") {
            Object.assign(fields, x.fields);
            if (x.statusChange) ({ paymentStatus: status } = x.statusChange), (fields.chargebackAt = x.statusChange.chargebackAt);
          }
        }
        expect({ paymentStatus: s.paymentStatus, fields: s.fields }).toEqual({ paymentStatus: status, fields });
        // 付与しないのは、返金（処理中・成功・一部）か敗訴があるときだけ
        const suspend = ["pending", "succeeded", "partial"].includes(summary.state) || s.fields.disputeStatus === "lost";
        expect(s.entitlement.grant).toBe(!suspend);
      }
    }
  });
});
