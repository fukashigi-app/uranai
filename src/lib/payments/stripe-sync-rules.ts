/**
 * Stripe の返金・異議申し立てを決済記録に反映するときの判定（純粋な関数。Firestore・Stripe には触れない。単体テスト用に分けている）。
 * stripe-confirm.ts の syncStripeRefunds・syncStripeDispute が、Stripe API から取り直した値と決済記録の値を渡して使う。
 *
 * ここで決めるのは「何を書き込むか」だけ。書き込み・売上集計のキー（salesKeys）・精算の調整（reconcileTransactionInTx）・
 * 占い権利を止めるかどうかの最終判断（権利の記録があり PAID のときだけ）は、呼び出し側のトランザクションで行う。
 * 日時は呼び出し側から now で渡す（同じ処理の中で同じ値を使う）。
 */
import type Stripe from "stripe";
import { chargebackCoversRemainder, disputeStateOf, type DisputeState } from "./settlement-rules";
import type { StripeRefundState, StripeRefundSummary } from "./stripe-checkout";

const STRIPE_PROVIDER = "stripe";

const idOfRef = (v: unknown): string | null => (typeof v === "string" ? v : v && typeof v === "object" && typeof (v as { id?: unknown }).id === "string" ? (v as { id: string }).id : null);

/** このアプリの注文の決済か（PaymentIntent の metadata に注文ID・店舗IDを入れている） */
export const isOurPayment = (pi: Pick<Stripe.PaymentIntent, "metadata">) =>
  typeof pi.metadata?.checkoutId === "string" && pi.metadata.checkoutId !== "" && typeof pi.metadata?.storeId === "string";

/** 照合に使う決済記録の項目 */
export type RecordedPaymentFacts = {
  paymentProvider?: unknown;
  stripeChargeId?: unknown;
  livemode?: unknown;
  amount?: unknown;
  storeId?: unknown;
};

/**
 * Stripe の Charge が、記録した決済（取引）と一致するか（返金・異議申し立ての反映の前に確かめる）。
 * 決済ID（Charge・PaymentIntent）、モード（livemode）、金額、通貨、店舗（PaymentIntent の metadata）がすべて一致すること。
 * 一致しない項目名を返す（空なら一致）。値そのものは返さない（決済要確認には項目名だけを記録する）。
 */
export function chargeMismatches(
  t: RecordedPaymentFacts,
  charge: Pick<Stripe.Charge, "id" | "livemode" | "payment_intent" | "currency" | "amount">,
  pi: Pick<Stripe.PaymentIntent, "id" | "livemode" | "amount" | "metadata">,
): string[] {
  const out: string[] = [];
  if (t.paymentProvider !== STRIPE_PROVIDER) out.push("provider");
  if (t.stripeChargeId !== charge.id) out.push("charge_id");
  if (t.livemode !== charge.livemode || pi.livemode !== charge.livemode) out.push("livemode");
  if (idOfRef(charge.payment_intent) !== pi.id) out.push("payment_intent");
  if (charge.currency !== "jpy") out.push("currency");
  if (Number(t.amount) !== charge.amount || pi.amount !== charge.amount) out.push("amount");
  if (pi.metadata?.storeId !== String(t.storeId)) out.push("store");
  return out;
}

// ---------- 返金 ----------

/** 返金の状態のキー（同じ値なら反映済み。通知の再送・重複では書き込まない） */
export const refundKeyOf = (s: StripeRefundSummary) => `${s.state}:${s.succeededAmount}:${s.pendingAmount}:${s.failedAmount}:${s.refundIds.join(",")}`;

export type StripeRefundSyncOutcome = "refund_pending" | "refunded" | "partial" | "refund_failed";

/**
 * 返金の状態で、未使用の占い権利を止めるか。
 * 今の規則：処理中・成功で止める。一部の返金・失敗では止めない（管理者が確認する）。
 */
export const refundSuspendsEntitlement = (state: StripeRefundState) => state === "succeeded" || state === "pending";

export type RefundTxFacts = { paymentStatus: unknown; refundKey: unknown };

export type RefundSyncDecision =
  | { kind: "unchanged" }
  | {
      kind: "apply";
      outcome: StripeRefundSyncOutcome;
      /** 返金の項目（決済の状態の変更・売上集計のキー・精算の調整・updatedAt は含まない） */
      fields: Record<string, unknown>;
      /** 決済の状態が変わるとき（呼び出し側で salesKeys を合わせて書き込む）。変わらなければ null */
      statusChange: { paymentStatus: "SUCCEEDED" | "REFUNDED" | "CHARGEBACK"; refundedAt: Date | null } | null;
      suspendEntitlement: boolean;
    };

/**
 * 返金の状態（Stripe API の返金の一覧から求めたもの）を、決済記録にどう反映するか。
 * 状態が "none"（返金が無い）のときは呼び出し側で扱う（反映しない）。
 */
export function decideRefundSync(t: RefundTxFacts, summary: StripeRefundSummary, now: Date): RefundSyncDecision {
  const refundKey = refundKeyOf(summary);
  if (t.refundKey === refundKey) return { kind: "unchanged" }; // 同じ状態はもう反映済み（再送・重複）
  const refunded = summary.state === "succeeded";
  const needsReview = summary.state === "partial" || summary.state === "failed";
  const paymentStatus = refunded ? "REFUNDED" : "SUCCEEDED"; // 成功した返金が後で失敗に変わったら SUCCEEDED に戻す
  // 異議申し立てで敗訴（全額）した決済は CHARGEBACK のまま（返金の状態だけ記録する）
  const nextStatus = t.paymentStatus === "CHARGEBACK" ? "CHARGEBACK" : paymentStatus;
  const fields: Record<string, unknown> = {
    refundStatus: summary.state,
    refundKey,
    amountRefunded: summary.succeededAmount,
    refundPendingAmount: summary.pendingAmount,
    refundFailedAmount: summary.failedAmount,
    stripeRefundIds: summary.refundIds,
    refundNeedsReview: needsReview,
    refundUpdatedAt: now,
  };
  const outcome: StripeRefundSyncOutcome = refunded ? "refunded" : summary.state === "pending" ? "refund_pending" : summary.state === "partial" ? "partial" : "refund_failed";
  return {
    kind: "apply",
    outcome,
    fields,
    statusChange: t.paymentStatus !== nextStatus ? { paymentStatus: nextStatus, refundedAt: refunded ? now : null } : null,
    suspendEntitlement: refundSuspendsEntitlement(summary.state),
  };
}

// ---------- 異議申し立て ----------

export type DisputeFacts = Pick<Stripe.Dispute, "id" | "amount" | "currency" | "status" | "reason">;

/** 異議申し立ての状態のキー（同じ値なら反映済み） */
export const disputeKeyOf = (dp: Pick<DisputeFacts, "id" | "status" | "amount">) => `${dp.id}:${dp.status}:${dp.amount}`;

/**
 * 異議申し立ての金額・通貨が決済と合わないか（合わなければ反映しない）。
 * 問題の項目名（"currency" | "amount"）を返す。問題が無ければ null。
 */
export function disputeAmountProblem(dp: Pick<DisputeFacts, "amount" | "currency">, chargeAmount: number): "currency" | "amount" | null {
  if (dp.currency !== "jpy" || !Number.isSafeInteger(dp.amount) || dp.amount <= 0 || dp.amount > chargeAmount) return dp.currency !== "jpy" ? "currency" : "amount";
  return null;
}

/**
 * 異議申し立ての状態で、未使用の占い権利を止めるか。
 * 今の規則：敗訴だけ止める（対応中・勝訴では止めない）。
 */
export const disputeSuspendsEntitlement = (state: DisputeState) => state === "lost";

export type StripeDisputeSyncOutcome = "dispute_open" | "dispute_won" | "dispute_lost";

export type DisputeTxFacts = {
  disputeId: unknown;
  disputeStatus: unknown;
  disputeKey: unknown;
  paymentStatus: unknown;
  amount: unknown;
  amountRefunded: unknown;
  refundStatus: unknown;
};

export type DisputeSyncDecision =
  /** 同じ決済に別の異議申し立て（通常は起きない）：自動では反映しない */
  | { kind: "multiple_disputes" }
  /** 結果が出た申し立てが対応中に戻った（古い状態の取り直し・順番の入れ替わり）：反映しない */
  | { kind: "regressed" }
  | { kind: "unchanged" }
  | {
      kind: "apply";
      state: DisputeState;
      outcome: StripeDisputeSyncOutcome;
      /** 異議申し立ての項目（決済の状態の変更・売上集計のキー・精算の調整・updatedAt は含まない） */
      fields: Record<string, unknown>;
      /** 決済の状態が変わるとき（呼び出し側で salesKeys を合わせて書き込む）。変わらなければ null */
      statusChange: { paymentStatus: string; chargebackAt: Date | null } | null;
      suspendEntitlement: boolean;
    };

/** 異議申し立ての状態（Stripe API から取り直したもの。金額は disputeAmountProblem で確認済み）を、決済記録にどう反映するか */
export function decideDisputeSync(t: DisputeTxFacts, dp: DisputeFacts, now: Date): DisputeSyncDecision {
  const state = disputeStateOf(String(dp.status));
  const prevId = t.disputeId;
  const prevState = t.disputeStatus;
  if (typeof prevId === "string" && prevId && prevId !== dp.id) return { kind: "multiple_disputes" };
  if ((prevState === "won" || prevState === "lost") && state === "open") return { kind: "regressed" };
  const key = disputeKeyOf(dp);
  if (t.disputeKey === key) return { kind: "unchanged" };
  const cur = String(t.paymentStatus);
  const full = chargebackCoversRemainder({ amount: Number(t.amount), amountRefunded: Number(t.amountRefunded ?? 0), disputeStatus: state, disputeAmount: dp.amount });
  const refundedAll = t.refundStatus === "succeeded";
  const nextStatus = state === "lost" && full ? "CHARGEBACK" : cur === "CHARGEBACK" ? (refundedAll ? "REFUNDED" : "SUCCEEDED") : cur;
  const fields: Record<string, unknown> = {
    disputeId: dp.id,
    disputeStatus: state,
    disputeStripeStatus: String(dp.status),
    disputeAmount: dp.amount,
    disputeReason: String(dp.reason ?? ""),
    disputeKey: key,
    disputeNeedsReview: state !== "won",
    disputeUpdatedAt: now,
  };
  const outcome: StripeDisputeSyncOutcome = state === "lost" ? "dispute_lost" : state === "won" ? "dispute_won" : "dispute_open";
  return {
    kind: "apply",
    state,
    outcome,
    fields,
    statusChange: nextStatus !== cur ? { paymentStatus: nextStatus, chargebackAt: nextStatus === "CHARGEBACK" ? now : null } : null,
    suspendEntitlement: disputeSuspendsEntitlement(state),
  };
}
