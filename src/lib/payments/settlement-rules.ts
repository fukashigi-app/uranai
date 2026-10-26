/**
 * 返金・異議申し立て（チャージバック）と精算の調整の規則（純粋な関数。単体テスト用に分けている）。
 *
 * 店舗の取り分は決済時に transactions に保存した値（storeShare・storeShareBps）を基準にし、過去の記録は書き換えない。
 * 「今の時点で店舗に支払うべき取り分」（entitledStoreShare）は、決済の状態から毎回求め直す：
 *  - 振込の対象外（テスト決済・疑似決済・判定不可）……… 0（本番の精算には決して混ぜない）
 *  - 全額の返金（REFUNDED）・全額の異議申し立ての敗訴（CHARGEBACK）… 0
 *  - 異議申し立ての対応中（open）…… 申し立てられた額の分だけ保留（全額なら 0。勝訴で元に戻る）
 *  - 異議申し立ての敗訴（lost）……… 申し立てられた額を除いた残りの取り分（一部の額だけの申し立てなら、残りは支払う）
 *  - 一部返金（Stripe 側で発生したとき）……………………… 返金後の金額に、決済時の率を掛けた額（切り捨て）
 *  - それ以外 …………………………………………………………… 保存した取り分のまま
 * 返金の処理中（pending）・失敗（failed）は売上・取り分を減らさない（成功した返金の額だけを使う）。
 */
import { isSettlementPayment } from "./kind";
import { splitRevenue } from "@/lib/money";

export type DisputeState = "open" | "won" | "lost";

export type SettlementTxFacts = {
  paymentProvider: string;
  livemode: unknown;
  paymentStatus: string;
  amount: number;
  storeShare: number;
  storeShareBps: number;
  /** 成功した返金の合計（処理中・失敗は含めない） */
  amountRefunded?: number | null;
  disputeStatus?: DisputeState | null;
  /** 異議申し立ての額（記録が無い古いデータは全額とみなす＝安全側） */
  disputeAmount?: number | null;
};

const refundedOf = (t: SettlementTxFacts) => Math.min(Math.max(0, Math.floor(Number(t.amountRefunded ?? 0)) || 0), t.amount);

/** 返金の後に残っている金額 */
const remainingOf = (t: SettlementTxFacts) => t.amount - refundedOf(t);

/** 異議申し立てで差し引く（または保留する）金額。対応中・敗訴のときだけ。返金の後の残りを超えない */
export function disputedAmountOf(t: Pick<SettlementTxFacts, "amount" | "amountRefunded" | "disputeStatus" | "disputeAmount">): number {
  if (t.disputeStatus !== "open" && t.disputeStatus !== "lost") return 0;
  const remaining = t.amount - refundedOf(t as SettlementTxFacts);
  const raw = Number(t.disputeAmount ?? t.amount);
  const amt = Number.isFinite(raw) ? Math.floor(raw) : t.amount;
  return Math.min(Math.max(0, amt), remaining);
}

/** 金額（円）に対する店舗の取り分。全額のままなら決済時に保存した取り分そのもの */
function shareOf(t: SettlementTxFacts, gross: number): number {
  if (gross >= t.amount) return t.storeShare;
  if (gross <= 0) return 0;
  return splitRevenue(gross, t.storeShareBps).storeShare;
}

/** 今の時点で店舗に支払うべき取り分（円） */
export function entitledStoreShare(t: SettlementTxFacts): number {
  if (!isSettlementPayment(t.paymentProvider, t.livemode)) return 0;
  if (t.paymentStatus !== "SUCCEEDED") return 0;
  return shareOf(t, remainingOf(t) - disputedAmountOf(t));
}

/** 異議申し立ての対応中で、精算を保留している取り分（円）。申し立てられた額の分だけ */
export function heldStoreShare(t: SettlementTxFacts): number {
  if (!isSettlementPayment(t.paymentProvider, t.livemode) || t.paymentStatus !== "SUCCEEDED" || t.disputeStatus !== "open") return 0;
  return shareOf(t, remainingOf(t)) - shareOf(t, remainingOf(t) - disputedAmountOf(t));
}

/** 異議申し立ての敗訴で、返金の後の残りがすべて失われるか（そのときは決済を CHARGEBACK にして売上から除く） */
export function chargebackCoversRemainder(t: Pick<SettlementTxFacts, "amount" | "amountRefunded" | "disputeStatus" | "disputeAmount">): boolean {
  return t.disputeStatus === "lost" && disputedAmountOf(t) >= t.amount - refundedOf(t as SettlementTxFacts);
}

/**
 * 売上の集計に使う金額（一部返金があれば返金後の金額）。全額の返金・敗訴は集計から除かれる（countable=false）ので、ここでは扱わない。
 * 決済時の記録（amount・storeShare・operatorShare）は書き換えず、読み取り時に求める。
 */
export function netSalesFigures(t: Pick<SettlementTxFacts, "amount" | "storeShare" | "storeShareBps" | "amountRefunded" | "disputeStatus" | "disputeAmount"> & { operatorShare: number }) {
  const refunded = Math.min(Math.max(0, Math.floor(Number(t.amountRefunded ?? 0)) || 0), t.amount);
  // 一部の額の異議申し立てで敗訴したときは、その額も売上から除く（対応中は売上に数えたまま）
  const lost = t.disputeStatus === "lost" ? disputedAmountOf(t) : 0;
  if (refunded === 0 && lost === 0) return { gross: t.amount, storeShare: t.storeShare, operatorShare: t.operatorShare };
  const net = Math.max(0, t.amount - refunded - lost);
  const { storeShare, operatorShare } = splitRevenue(net, t.storeShareBps);
  return { gross: net, storeShare, operatorShare };
}

/** Stripe の異議申し立ての状態 → アプリの状態 */
export function disputeStateOf(stripeStatus: string): DisputeState {
  if (stripeStatus === "won" || stripeStatus === "warning_closed" || stripeStatus === "prevented") return "won";
  if (stripeStatus === "lost") return "lost";
  return "open"; // needs_response・under_review・warning_* など、結果が出ていないもの（不明な値も保留＝安全側）
}

export type AdjustmentReason = "refund" | "partial_refund" | "refund_reversed" | "dispute_hold" | "dispute_won" | "dispute_lost" | "late_transaction" | "carryover";

export const ADJUSTMENT_REASON_LABEL: Record<AdjustmentReason, string> = {
  refund: "振込後の返金",
  partial_refund: "振込後の一部返金",
  refund_reversed: "返金の取り消し（失敗）",
  dispute_hold: "異議申し立て（保留）",
  dispute_won: "異議申し立て（勝訴・保留の解除）",
  dispute_lost: "異議申し立て（敗訴）",
  late_transaction: "締め後に確定した決済",
  carryover: "前回からの繰越",
};

export type AdjustmentStatus = "OPEN" | "APPLIED";
export const ADJUSTMENT_STATUS_LABEL: Record<AdjustmentStatus, string> = { OPEN: "次回の精算で反映", APPLIED: "精算に反映済み" };

/**
 * 振込済み（確定済み）の取引の取り分が変わったときの調整額。
 * 確定時に支払った額（settledShare）と、これまでの調整の合計を差し引いた残り（0 なら調整なし）。
 */
export function adjustmentDelta(entitled: number, settledShare: number, adjustedTotal: number): number {
  return entitled - settledShare - adjustedTotal;
}

/** 返金・異議申し立てで取り分が変わったときの調整の理由 */
export function adjustmentReasonFor(kind: "refund" | "dispute" | "late", delta: number, facts: { refundedPartially?: boolean; disputeStatus?: DisputeState | null }): AdjustmentReason {
  if (kind === "late") return "late_transaction";
  if (kind === "refund") return delta > 0 ? "refund_reversed" : facts.refundedPartially ? "partial_refund" : "refund";
  if (delta > 0) return "dispute_won";
  return facts.disputeStatus === "lost" ? "dispute_lost" : "dispute_hold";
}

/**
 * 精算を確定するときの振込額。その月の取り分に、未反映の調整（マイナスは差し引き・プラスは加算）を合わせる。
 * 合計がマイナスになるときは振込額を 0 にし、足りない分を次回へ繰り越す（carryOver はマイナスの額）。
 */
export function applyAdjustments(storeShare: number, adjustments: number[]): { adjustmentTotal: number; payable: number; carryOver: number } {
  const adjustmentTotal = adjustments.reduce((a, b) => a + b, 0);
  const total = storeShare + adjustmentTotal;
  return total >= 0 ? { adjustmentTotal, payable: total, carryOver: 0 } : { adjustmentTotal, payable: 0, carryOver: total };
}
