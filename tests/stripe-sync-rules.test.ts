import { readFileSync } from "node:fs";
import path from "node:path";
import type Stripe from "stripe";
import { describe, expect, it } from "vitest";
import { chargebackCoversRemainder, disputeStateOf } from "@/lib/payments/settlement-rules";
import type { DisputeState } from "@/lib/payments/settlement-rules";
import type { StripeRefundState, StripeRefundSummary } from "@/lib/payments/stripe-checkout";
import {
  chargeMismatches,
  decideDisputeSync,
  decideRefundSync,
  disputeAmountProblem,
  disputeKeyOf,
  disputeSuspendsEntitlement,
  checkoutRefundReasonOf,
  decideCheckoutAfterSync,
  decideEntitlementRestore,
  initialEntitlementOf,
  isOurPayment,
  normalizeRestoreReason,
  RESTORE_REASON_MAX,
  refundKeyOf,
  refundSuspendsEntitlement,
  type DisputeFacts,
  type DisputeTxFacts,
  type RefundTxFacts,
  type RestoreFacts,
} from "@/lib/payments/stripe-sync-rules";

// 返金・異議申し立ての反映の判定（stripe-confirm.ts から切り出した純粋な関数）。Firestore・Stripe には接続しない
const NOW = new Date("2026-10-28T03:00:00Z");

const summary = (state: StripeRefundState, over: Partial<StripeRefundSummary> = {}): StripeRefundSummary => ({
  state,
  succeededAmount: state === "succeeded" ? 100 : state === "partial" ? 30 : 0,
  pendingAmount: state === "pending" ? 100 : 0,
  failedAmount: state === "failed" ? 100 : 0,
  refundIds: state === "none" ? [] : ["re_test_1"],
  ...over,
});
const dispute = (status: string, over: Partial<DisputeFacts> = {}): DisputeFacts => ({ id: "dp_test_1", amount: 100, currency: "jpy", status: status as Stripe.Dispute.Status, reason: "fraudulent", ...over });
const disputeTx = (over: Partial<DisputeTxFacts> = {}): DisputeTxFacts => ({
  disputeId: undefined,
  disputeStatus: undefined,
  disputeKey: undefined,
  paymentStatus: "SUCCEEDED",
  amount: 100,
  amountRefunded: 0,
  refundStatus: null,
  ...over,
});

describe("このアプリの決済か・記録との照合", () => {
  it("PaymentIntent の metadata に注文ID・店舗IDがあるものだけ", () => {
    expect(isOurPayment({ metadata: { checkoutId: "co_1", storeId: "st_1" } })).toBe(true);
    expect(isOurPayment({ metadata: { checkoutId: "", storeId: "st_1" } })).toBe(false);
    expect(isOurPayment({ metadata: { checkoutId: "co_1" } })).toBe(false);
    expect(isOurPayment({ metadata: {} })).toBe(false);
    expect(isOurPayment({} as Pick<Stripe.PaymentIntent, "metadata">)).toBe(false);
  });

  const t = { paymentProvider: "stripe", stripeChargeId: "ch_1", livemode: false, amount: 100, storeId: "st_1" };
  const charge = { id: "ch_1", livemode: false, payment_intent: "pi_1", currency: "jpy", amount: 100 } as Stripe.Charge;
  const pi = { id: "pi_1", livemode: false, amount: 100, metadata: { storeId: "st_1" } } as unknown as Stripe.PaymentIntent;
  it("すべて一致すれば空", () => {
    expect(chargeMismatches(t, charge, pi)).toEqual([]);
    expect(chargeMismatches(t, { ...charge, payment_intent: { id: "pi_1" } } as Stripe.Charge, pi)).toEqual([]); // 展開済みの PaymentIntent
  });
  it.each([
    ["provider", { ...t, paymentProvider: "mock" }, charge, pi],
    ["charge_id", { ...t, stripeChargeId: "ch_other" }, charge, pi],
    ["livemode", { ...t, livemode: true }, charge, pi],
    ["livemode", t, charge, { ...pi, livemode: true }],
    ["payment_intent", t, { ...charge, payment_intent: "pi_other" }, pi],
    ["currency", t, { ...charge, currency: "usd" }, pi],
    ["amount", { ...t, amount: 200 }, charge, pi],
    ["amount", t, charge, { ...pi, amount: 200 }],
    ["store", { ...t, storeId: "st_other" }, charge, pi],
  ] as const)("%s が違えば、その項目名を返す", (name, tt, c, p) => {
    expect(chargeMismatches(tt, c as Stripe.Charge, p as Stripe.PaymentIntent)).toEqual([name]);
  });
});

describe("返金の反映の判定", () => {
  const tx = (over: Partial<RefundTxFacts> = {}): RefundTxFacts => ({ paymentStatus: "SUCCEEDED", refundKey: undefined, ...over });

  it("状態のキーは同じ内容なら同じ値（再送・重複では書き込まない）", () => {
    const s = summary("succeeded");
    expect(refundKeyOf(s)).toBe("succeeded:100:0:0:re_test_1");
    expect(decideRefundSync(tx({ refundKey: refundKeyOf(s) }), s, NOW)).toEqual({ kind: "unchanged" });
  });

  it("成功：REFUNDED にし、未使用の権利を止める", () => {
    const d = decideRefundSync(tx(), summary("succeeded"), NOW);
    expect(d).toEqual({
      kind: "apply",
      outcome: "refunded",
      fields: {
        refundStatus: "succeeded",
        refundKey: "succeeded:100:0:0:re_test_1",
        amountRefunded: 100,
        refundPendingAmount: 0,
        refundFailedAmount: 0,
        stripeRefundIds: ["re_test_1"],
        refundNeedsReview: false,
        refundUpdatedAt: NOW,
      },
      statusChange: { paymentStatus: "REFUNDED", refundedAt: NOW },
      suspendEntitlement: true,
    });
  });

  it("処理中：決済は SUCCEEDED のまま、未使用の権利を止める", () => {
    const d = decideRefundSync(tx(), summary("pending"), NOW);
    expect(d).toMatchObject({ kind: "apply", outcome: "refund_pending", statusChange: null, suspendEntitlement: true, fields: { refundStatus: "pending", refundPendingAmount: 100, refundNeedsReview: false } });
  });

  it("一部の返金：管理者の確認にし、未使用の権利を止める（決済確定の前後で同じ規則）", () => {
    const d = decideRefundSync(tx(), summary("partial"), NOW);
    expect(d).toMatchObject({ kind: "apply", outcome: "partial", statusChange: null, suspendEntitlement: true, fields: { refundStatus: "partial", amountRefunded: 30, refundNeedsReview: true } });
  });

  it("失敗：管理者の確認にする。権利は止めない", () => {
    const d = decideRefundSync(tx(), summary("failed"), NOW);
    expect(d).toMatchObject({ kind: "apply", outcome: "refund_failed", statusChange: null, suspendEntitlement: false, fields: { refundStatus: "failed", refundNeedsReview: true } });
  });

  it("成功した返金が後で失敗に変わったら SUCCEEDED に戻す（返金日時も消す）", () => {
    const d = decideRefundSync(tx({ paymentStatus: "REFUNDED", refundKey: refundKeyOf(summary("succeeded")) }), summary("failed"), NOW);
    expect(d).toMatchObject({ kind: "apply", statusChange: { paymentStatus: "SUCCEEDED", refundedAt: null } });
  });

  it("異議申し立てで敗訴（CHARGEBACK）した決済は、返金の状態だけを記録して CHARGEBACK のまま", () => {
    for (const st of ["succeeded", "pending", "partial", "failed"] as const) {
      expect(decideRefundSync(tx({ paymentStatus: "CHARGEBACK" }), summary(st), NOW)).toMatchObject({ kind: "apply", statusChange: null });
    }
  });

  it("権利を止める返金の状態（処理中・成功・一部。失敗では止めない）", () => {
    expect((["none", "pending", "succeeded", "partial", "failed"] as const).filter(refundSuspendsEntitlement)).toEqual(["pending", "succeeded", "partial"]);
  });
});

describe("異議申し立ての金額・通貨の確認", () => {
  it.each([
    [{ amount: 100, currency: "jpy" }, 100, null],
    [{ amount: 1, currency: "jpy" }, 100, null],
    [{ amount: 100, currency: "usd" }, 100, "currency"],
    [{ amount: 101, currency: "jpy" }, 100, "amount"],
    [{ amount: 0, currency: "jpy" }, 100, "amount"],
    [{ amount: -1, currency: "jpy" }, 100, "amount"],
    [{ amount: 1.5, currency: "jpy" }, 100, "amount"],
    [{ amount: Number.NaN, currency: "jpy" }, 100, "amount"],
    [{ amount: 0, currency: "usd" }, 100, "currency"], // 通貨が違えば通貨を優先して記録する
  ] as const)("%o（決済 %d 円）→ %s", (dp, chargeAmount, expected) => {
    expect(disputeAmountProblem(dp as Pick<DisputeFacts, "amount" | "currency">, chargeAmount)).toBe(expected);
  });
});

describe("異議申し立ての反映の判定", () => {
  it("状態のキーは ID・Stripe の状態・金額", () => {
    expect(disputeKeyOf(dispute("needs_response"))).toBe("dp_test_1:needs_response:100");
    expect(decideDisputeSync(disputeTx({ disputeId: "dp_test_1", disputeStatus: "open", disputeKey: "dp_test_1:needs_response:100" }), dispute("needs_response"), NOW)).toEqual({ kind: "unchanged" });
  });

  it("対応中：記録するが、決済の状態・権利は変えない（精算は申し立ての額の分だけ保留）", () => {
    expect(decideDisputeSync(disputeTx(), dispute("needs_response"), NOW)).toEqual({
      kind: "apply",
      state: "open",
      outcome: "dispute_open",
      fields: {
        disputeId: "dp_test_1",
        disputeStatus: "open",
        disputeStripeStatus: "needs_response",
        disputeAmount: 100,
        disputeReason: "fraudulent",
        disputeKey: "dp_test_1:needs_response:100",
        disputeNeedsReview: true,
        disputeUpdatedAt: NOW,
      },
      statusChange: null,
      suspendEntitlement: false,
    });
  });

  it("全額で敗訴：CHARGEBACK にし、未使用の権利を止める", () => {
    const d = decideDisputeSync(disputeTx({ disputeId: "dp_test_1", disputeStatus: "open" }), dispute("lost"), NOW);
    expect(d).toMatchObject({ kind: "apply", state: "lost", outcome: "dispute_lost", statusChange: { paymentStatus: "CHARGEBACK", chargebackAt: NOW }, suspendEntitlement: true, fields: { disputeNeedsReview: true } });
  });

  it("一部の額だけで敗訴：決済は SUCCEEDED のまま（残りは売上・取り分に残す）。権利は止める", () => {
    const d = decideDisputeSync(disputeTx(), dispute("lost", { amount: 40 }), NOW);
    expect(d).toMatchObject({ kind: "apply", state: "lost", statusChange: null, suspendEntitlement: true, fields: { disputeAmount: 40 } });
  });

  it("勝訴：確認は不要。敗訴（CHARGEBACK）の後の勝訴は SUCCEEDED に戻す（全額の返金済みなら REFUNDED）", () => {
    expect(decideDisputeSync(disputeTx({ disputeId: "dp_test_1", disputeStatus: "open" }), dispute("won"), NOW)).toMatchObject({ kind: "apply", state: "won", outcome: "dispute_won", statusChange: null, suspendEntitlement: false, fields: { disputeNeedsReview: false } });
    expect(decideDisputeSync(disputeTx({ disputeId: "dp_test_1", disputeStatus: "lost", paymentStatus: "CHARGEBACK" }), dispute("won"), NOW)).toMatchObject({ statusChange: { paymentStatus: "SUCCEEDED", chargebackAt: null } });
    expect(decideDisputeSync(disputeTx({ disputeId: "dp_test_1", disputeStatus: "lost", paymentStatus: "CHARGEBACK", refundStatus: "succeeded" }), dispute("won"), NOW)).toMatchObject({ statusChange: { paymentStatus: "REFUNDED", chargebackAt: null } });
  });

  it("Stripe の状態の対応（warning_closed・prevented は勝訴扱い。不明な値は対応中＝保留の安全側）", () => {
    expect(decideDisputeSync(disputeTx(), dispute("warning_closed"), NOW)).toMatchObject({ state: "won" });
    expect(decideDisputeSync(disputeTx(), dispute("prevented"), NOW)).toMatchObject({ state: "won" });
    expect(decideDisputeSync(disputeTx(), dispute("under_review"), NOW)).toMatchObject({ state: "open" });
    expect(decideDisputeSync(disputeTx(), dispute("some_future_status"), NOW)).toMatchObject({ state: "open" });
  });

  it("同じ決済に別の異議申し立て：反映しない", () => {
    expect(decideDisputeSync(disputeTx({ disputeId: "dp_other" }), dispute("needs_response"), NOW)).toEqual({ kind: "multiple_disputes" });
    expect(decideDisputeSync(disputeTx({ disputeId: "" }), dispute("needs_response"), NOW)).toMatchObject({ kind: "apply" }); // 空の ID は記録なし扱い
  });

  it("結果が出た申し立てを対応中に戻さない（勝訴⇔敗訴の変化は反映する）", () => {
    expect(decideDisputeSync(disputeTx({ disputeId: "dp_test_1", disputeStatus: "won" }), dispute("under_review"), NOW)).toEqual({ kind: "regressed" });
    expect(decideDisputeSync(disputeTx({ disputeId: "dp_test_1", disputeStatus: "lost" }), dispute("needs_response"), NOW)).toEqual({ kind: "regressed" });
    expect(decideDisputeSync(disputeTx({ disputeId: "dp_test_1", disputeStatus: "won" }), dispute("lost"), NOW)).toMatchObject({ kind: "apply", state: "lost" });
  });

  it("権利を止める異議申し立ての状態（今の規則：敗訴だけ）", () => {
    expect((["open", "won", "lost"] as const).filter(disputeSuspendsEntitlement)).toEqual(["lost"]);
  });
});

// 切り出す前の stripe-confirm.ts の判定をそのまま写したもの（第1段階で動作が変わっていないことの確認用。日時は NOW に固定）。
// 第2段階で意図して変えたのは「一部の返金で権利を止める」ことだけ（下の比較で、その1点だけを差し替えて確かめる）
function legacyRefund(t: RefundTxFacts, s: StripeRefundSummary) {
  const refundKey = refundKeyOf(s);
  if (t.refundKey === refundKey) return { outcome: "unchanged" };
  const refunded = s.state === "succeeded";
  const needsReview = s.state === "partial" || s.state === "failed";
  const paymentStatus = refunded ? "REFUNDED" : "SUCCEEDED";
  const nextStatus = t.paymentStatus === "CHARGEBACK" ? "CHARGEBACK" : paymentStatus;
  const patch: Record<string, unknown> = {
    refundStatus: s.state,
    refundKey,
    amountRefunded: s.succeededAmount,
    refundPendingAmount: s.pendingAmount,
    refundFailedAmount: s.failedAmount,
    stripeRefundIds: s.refundIds,
    refundNeedsReview: needsReview,
    refundUpdatedAt: NOW,
    ...(t.paymentStatus !== nextStatus ? { paymentStatus: nextStatus, refundedAt: refunded ? NOW : null } : {}),
  };
  const suspend = refunded || s.state === "pending";
  const outcome = refunded ? "refunded" : s.state === "pending" ? "refund_pending" : s.state === "partial" ? "partial" : "refund_failed";
  return { outcome, patch, suspend };
}
function legacyDispute(t: DisputeTxFacts, dp: DisputeFacts) {
  const state = disputeStateOf(String(dp.status));
  const prevId = t.disputeId;
  const prevState = t.disputeStatus;
  if (typeof prevId === "string" && prevId && prevId !== dp.id) return { outcome: "rejected" };
  if ((prevState === "won" || prevState === "lost") && state === "open") return { outcome: "unchanged", regressed: true };
  const key = `${dp.id}:${dp.status}:${dp.amount}`;
  if (t.disputeKey === key) return { outcome: "unchanged" };
  const cur = String(t.paymentStatus);
  const facts = { amount: Number(t.amount), amountRefunded: Number(t.amountRefunded ?? 0), disputeStatus: state, disputeAmount: dp.amount };
  const full = chargebackCoversRemainder(facts);
  const refundedAll = t.refundStatus === "succeeded";
  const nextStatus = state === "lost" && full ? "CHARGEBACK" : cur === "CHARGEBACK" ? (refundedAll ? "REFUNDED" : "SUCCEEDED") : cur;
  const patch: Record<string, unknown> = {
    disputeId: dp.id,
    disputeStatus: state,
    disputeStripeStatus: String(dp.status),
    disputeAmount: dp.amount,
    disputeReason: String(dp.reason ?? ""),
    disputeKey: key,
    disputeNeedsReview: state !== "won",
    disputeUpdatedAt: NOW,
    ...(nextStatus !== cur ? { paymentStatus: nextStatus, chargebackAt: nextStatus === "CHARGEBACK" ? NOW : null } : {}),
  };
  const outcome = state === "lost" ? "dispute_lost" : state === "won" ? "dispute_won" : "dispute_open";
  return { outcome, patch, suspend: state === "lost" };
}

describe("切り出す前の判定と同じ結果（すべての組み合わせ）", () => {
  it("返金", () => {
    let n = 0;
    for (const paymentStatus of ["SUCCEEDED", "REFUNDED", "CHARGEBACK"]) {
      for (const state of ["pending", "succeeded", "partial", "failed"] as const) {
        for (const prev of [undefined, "pending", "succeeded", "partial", "failed"] as const) {
          const s = summary(state);
          const t = { paymentStatus, refundKey: prev ? refundKeyOf(summary(prev)) : undefined };
          const legacy = legacyRefund(t, s);
          const d = decideRefundSync(t, s, NOW);
          if (d.kind === "unchanged") expect(legacy).toEqual({ outcome: "unchanged" });
          else expect({ outcome: d.outcome, patch: { ...d.fields, ...(d.statusChange ?? {}) }, suspend: d.suspendEntitlement }).toEqual({ ...legacy, suspend: legacy.suspend || state === "partial" });
          n++;
        }
      }
    }
    expect(n).toBe(60);
  });

  it("異議申し立て", () => {
    let n = 0;
    const statuses = ["warning_needs_response", "warning_under_review", "warning_closed", "needs_response", "under_review", "won", "lost", "prevented", "unknown_new"];
    for (const paymentStatus of ["SUCCEEDED", "REFUNDED", "CHARGEBACK"]) {
      for (const prevState of [undefined, "open", "won", "lost"]) {
        for (const prevId of [undefined, "", "dp_test_1", "dp_other"]) {
          for (const status of statuses) {
            for (const amount of [100, 40]) {
              for (const [amountRefunded, refundStatus] of [[0, null], [100, "succeeded"], [30, "partial"]] as const) {
                const dp = dispute(status, { amount });
                const t = disputeTx({ paymentStatus, disputeStatus: prevState, disputeId: prevId, amountRefunded, refundStatus, disputeKey: prevId === "dp_test_1" ? disputeKeyOf(dp) : undefined });
                const legacy = legacyDispute(t, dp);
                const d = decideDisputeSync(t, dp, NOW);
                if (d.kind === "multiple_disputes") expect(legacy).toEqual({ outcome: "rejected" });
                else if (d.kind === "regressed") expect(legacy).toEqual({ outcome: "unchanged", regressed: true });
                else if (d.kind === "unchanged") expect(legacy).toEqual({ outcome: "unchanged" });
                else expect({ outcome: d.outcome, patch: { ...d.fields, ...(d.statusChange ?? {}) }, suspend: d.suspendEntitlement }).toEqual(legacy);
                n++;
              }
            }
          }
        }
      }
    }
    expect(n).toBe(3 * 4 * 4 * 9 * 2 * 3);
  });
});

describe("決済確定の時点の占い権利", () => {
  const REFUND: StripeRefundState[] = ["none", "pending", "succeeded", "partial", "failed"];
  const DISPUTE: (DisputeState | null)[] = [null, "open", "won", "lost"];

  it("返金も異議申し立ても無い・返金の失敗・異議申し立ての対応中・勝訴：権利を付与し、注文は SUCCEEDED", () => {
    for (const r of ["none", "failed"] as const) {
      for (const d of [null, "open", "won"] as const) {
        expect(initialEntitlementOf(r, d)).toEqual({ grant: true, checkoutStatus: "SUCCEEDED", refundReason: null, suspendedByRefund: false, suspendedByDispute: false });
      }
    }
  });

  it.each(["pending", "succeeded", "partial"] as const)("返金（%s）：権利を止めて作り、注文は REFUNDED（理由 refund）", (r) => {
    expect(initialEntitlementOf(r, null)).toEqual({ grant: false, checkoutStatus: "REFUNDED", refundReason: "refund", suspendedByRefund: true, suspendedByDispute: false });
    expect(initialEntitlementOf(r, "open")).toMatchObject({ grant: false, refundReason: "refund" });
  });

  it("異議申し立ての敗訴：権利を止めて作り、注文は REFUNDED（理由 chargeback。返金もあるときも chargeback）", () => {
    expect(initialEntitlementOf("none", "lost")).toEqual({ grant: false, checkoutStatus: "REFUNDED", refundReason: "chargeback", suspendedByRefund: false, suspendedByDispute: true });
    expect(initialEntitlementOf("partial", "lost")).toEqual({ grant: false, checkoutStatus: "REFUNDED", refundReason: "chargeback", suspendedByRefund: true, suspendedByDispute: true });
    expect(initialEntitlementOf("failed", "lost")).toMatchObject({ grant: false, refundReason: "chargeback" });
  });

  it("確定の後に届いた場合の規則と同じ（すべての組み合わせで、権利を止めるのは返金か敗訴の規則のどちらかに当たるとき）", () => {
    for (const r of REFUND) {
      for (const d of DISPUTE) {
        const e = initialEntitlementOf(r, d);
        const suspend = refundSuspendsEntitlement(r) || (d !== null && disputeSuspendsEntitlement(d));
        expect(e.grant).toBe(!suspend);
        expect(e.checkoutStatus).toBe(suspend ? "REFUNDED" : "SUCCEEDED");
        expect(e.refundReason === null).toBe(!suspend); // 付与しないときは必ず理由がある
      }
    }
  });
});

describe("止めた占い権利の復旧（運営の操作）", () => {
  const ok = (over: Partial<RestoreFacts> = {}, ent: Partial<RestoreFacts["entitlement"]> = {}): RestoreFacts => ({
    paymentStatus: "SUCCEEDED",
    refundStatus: "failed",
    disputeStatus: null,
    ...over,
    entitlement: { exists: true, status: "EXPIRED", suspendedByRefund: true, suspendedByDispute: undefined, usedAt: null, ...ent },
  });
  const REASON = "返金が失敗したため、お客さまに確認のうえ権利を戻す";

  it("返金がすべて失敗・一部の返金で、返金で止めた未使用の権利なら、理由付きで戻せる", () => {
    expect(decideEntitlementRestore(ok(), REASON)).toEqual({ ok: true, refundState: "failed", reason: REASON });
    expect(decideEntitlementRestore(ok({ refundStatus: "partial" }), REASON)).toEqual({ ok: true, refundState: "partial", reason: REASON });
    expect(decideEntitlementRestore(ok({ disputeStatus: "won" }), REASON)).toMatchObject({ ok: true }); // 勝訴した異議申し立ては妨げない
  });

  it.each([
    ["全額の返金済み（REFUNDED）", ok({ paymentStatus: "REFUNDED", refundStatus: "succeeded" }), "payment_not_succeeded"],
    ["チャージバック（CHARGEBACK）", ok({ paymentStatus: "CHARGEBACK" }), "payment_not_succeeded"],
    ["返金の処理中", ok({ refundStatus: "pending" }), "refund_pending"],
    ["返金が成功（状態の食い違い）", ok({ refundStatus: "succeeded" }), "refund_not_restorable"],
    ["返金が無い", ok({ refundStatus: null }), "refund_not_restorable"],
    ["異議申し立ての対応中", ok({ disputeStatus: "open" }), "dispute_open"],
    ["異議申し立ての敗訴（一部の額。決済は SUCCEEDED のまま）", ok({ disputeStatus: "lost" }), "dispute_lost"],
    ["一部の返金＋異議申し立ての対応中", ok({ refundStatus: "partial", disputeStatus: "open" }), "dispute_open"],
    ["権利の記録が無い", ok({}, { exists: false }), "entitlement_missing"],
    ["権利は使用済み", ok({}, { status: "USED" }), "entitlement_used"],
    ["使用日時がある", ok({}, { usedAt: new Date() }), "entitlement_used"],
    ["権利は有効のまま（すでに戻した）", ok({}, { status: "PAID", suspendedByRefund: false }), "entitlement_not_suspended"],
    ["期限切れで止まった（返金で止めたものではない）", ok({}, { suspendedByRefund: false }), "entitlement_not_suspended"],
    ["異議申し立てで止めた", ok({}, { suspendedByDispute: true }), "entitlement_suspended_by_dispute"],
  ] as const)("%s → 戻さない（%s）", (_label, facts, deny) => {
    expect(decideEntitlementRestore(facts, REASON)).toEqual({ ok: false, deny });
  });

  it("理由の入力は必須・最大文字数まで。制御文字は空白にして前後の空白を除く", () => {
    for (const r of [undefined, null, 1, "", "   ", "\n\t"]) expect(decideEntitlementRestore(ok(), r)).toEqual({ ok: false, deny: "reason_required" });
    expect(decideEntitlementRestore(ok(), "あ".repeat(RESTORE_REASON_MAX))).toMatchObject({ ok: true });
    expect(decideEntitlementRestore(ok(), "あ".repeat(RESTORE_REASON_MAX + 1))).toEqual({ ok: false, deny: "reason_too_long" });
    expect(decideEntitlementRestore(ok(), "😀".repeat(RESTORE_REASON_MAX))).toMatchObject({ ok: true }); // 文字数で数える（サロゲートペアも1文字）
    expect(decideEntitlementRestore(ok(), "  返金失敗\nのため  ")).toEqual({ ok: true, refundState: "failed", reason: "返金失敗 のため" });
    expect(normalizeRestoreReason("a\u0000b\u007fc")).toBe("a b c");
  });

  it("戻せない状態なら、理由が無くても状態の理由を返す（状態の確認が先）", () => {
    expect(decideEntitlementRestore(ok({ refundStatus: "pending" }), "")).toEqual({ ok: false, deny: "refund_pending" });
  });
});

describe("純粋な関数のモジュール", () => {
  it("Firestore・Stripe との接続・サーバー専用のモジュールを読み込まない（型だけ）", () => {
    const src = readFileSync(path.join(process.cwd(), "src/lib/payments/stripe-sync-rules.ts"), "utf8");
    const imports = [...src.matchAll(/^import\s+(type\s+)?[^;]*?from\s+"([^"]+)";/gm)].map((m) => ({ typeOnly: Boolean(m[1]), from: m[2] }));
    expect(src).not.toMatch(/server-only|firebase-admin|@\/lib\/firestore/);
    for (const i of imports) if (!i.typeOnly) expect(i.from).toBe("./settlement-rules");
  });
});

describe("返金・異議申し立ての反映の後の注文の状態", () => {
  const REFUND = [null, "none", "pending", "succeeded", "partial", "failed"] as const;
  const DISPUTE = [null, "open", "won", "lost"] as const;

  it("注文を REFUNDED にする理由：敗訴は chargeback、返金（処理中・成功・一部）は refund、それ以外は null", () => {
    expect(checkoutRefundReasonOf("succeeded", null)).toBe("refund");
    expect(checkoutRefundReasonOf("pending", "open")).toBe("refund");
    expect(checkoutRefundReasonOf("partial", "won")).toBe("refund");
    expect(checkoutRefundReasonOf("failed", "lost")).toBe("chargeback");
    expect(checkoutRefundReasonOf("succeeded", "lost")).toBe("chargeback");
    expect(checkoutRefundReasonOf("failed", null)).toBeNull();
    expect(checkoutRefundReasonOf(null, "open")).toBeNull();
    expect(checkoutRefundReasonOf(undefined, undefined)).toBeNull();
  });

  it("権利を止める規則・決済確定の時点の注文の状態と同じ（すべての組み合わせ）", () => {
    for (const r of REFUND) {
      for (const d of DISPUTE) {
        const reason = checkoutRefundReasonOf(r, d);
        const init = initialEntitlementOf((r ?? "none") as StripeRefundState, d);
        expect(reason).toBe(init.refundReason);
        expect(reason !== null).toBe(!init.grant);
      }
    }
  });

  it("SUCCEEDED の注文は、返金・敗訴で REFUNDED（理由つき）にする", () => {
    expect(decideCheckoutAfterSync({ status: "SUCCEEDED", refundReason: null }, { refundStatus: "pending", disputeStatus: null })).toEqual({ status: "REFUNDED", refundReason: "refund" });
    expect(decideCheckoutAfterSync({ status: "SUCCEEDED", refundReason: null }, { refundStatus: "partial", disputeStatus: null })).toEqual({ status: "REFUNDED", refundReason: "refund" });
    expect(decideCheckoutAfterSync({ status: "SUCCEEDED", refundReason: null }, { refundStatus: "succeeded", disputeStatus: null })).toEqual({ status: "REFUNDED", refundReason: "refund" });
    expect(decideCheckoutAfterSync({ status: "SUCCEEDED", refundReason: null }, { refundStatus: null, disputeStatus: "lost" })).toEqual({ status: "REFUNDED", refundReason: "chargeback" });
  });

  it("REFUNDED の理由は今の状態に合わせる（返金の後の敗訴は chargeback）。同じ理由なら書き込まない", () => {
    expect(decideCheckoutAfterSync({ status: "REFUNDED", refundReason: "refund" }, { refundStatus: "succeeded", disputeStatus: "lost" })).toEqual({ status: "REFUNDED", refundReason: "chargeback" });
    expect(decideCheckoutAfterSync({ status: "REFUNDED", refundReason: "refund" }, { refundStatus: "succeeded", disputeStatus: null })).toBeNull();
    expect(decideCheckoutAfterSync({ status: "REFUNDED", refundReason: "chargeback" }, { refundStatus: null, disputeStatus: "lost" })).toBeNull();
  });

  it("REFUNDED から SUCCEEDED に自動では戻さない（返金の失敗・取り消し・勝訴・古い通知・再送でも）", () => {
    for (const refundStatus of ["failed", "none", null]) {
      for (const disputeStatus of [null, "open", "won"]) {
        for (const refundReason of ["refund", "chargeback", null]) {
          expect(decideCheckoutAfterSync({ status: "REFUNDED", refundReason }, { refundStatus, disputeStatus })).toBeNull();
        }
      }
    }
  });

  it("SUCCEEDED・REFUNDED 以外の注文は変えない。返金が無ければ SUCCEEDED のまま", () => {
    for (const status of ["CREATED", "PROCESSING", "FAILED", "EXPIRED", undefined]) {
      expect(decideCheckoutAfterSync({ status, refundReason: null }, { refundStatus: "succeeded", disputeStatus: "lost" })).toBeNull();
    }
    expect(decideCheckoutAfterSync({ status: "SUCCEEDED", refundReason: null }, { refundStatus: "failed", disputeStatus: "open" })).toBeNull();
    expect(decideCheckoutAfterSync({ status: "SUCCEEDED", refundReason: null }, { refundStatus: null, disputeStatus: "won" })).toBeNull();
  });
});
