import "server-only";
import { FieldValue, type DocumentData, type DocumentReference, type Transaction } from "firebase-admin/firestore";
import { C, fsdb, toDate } from "./admin";
import {
  adjustmentDelta,
  adjustmentReasonFor,
  entitledStoreShare,
  type AdjustmentReason,
  type AdjustmentStatus,
  type DisputeState,
  type SettlementTxFacts,
} from "@/lib/payments/settlement-rules";
import { STORE_SHARE_BPS } from "@/config/pricing";
import { isSettlementPayment } from "@/lib/payments/kind";
import type { PaymentReviewInput } from "./payment-reviews";

/**
 * 精算の調整（Firestore 版）。
 *  settlementAdjustments/{取引ID_連番}       … 確定済みの精算に含めた取引の取り分が、後で変わったときの差額
 *  settlementAdjustments/carry_{精算ID}      … 調整が振込額を超えたときの、次回への繰越
 * 過去の取引（金額・取り分）と支払済みの精算は書き換えない。調整は、次に確定する未払いの精算で差し引き・加算する。
 *
 * 取引の記録には、精算を確定した時点の値を残す：
 *  settlementId … 含めた精算、settledShare … そのとき支払った取り分、adjustmentTotal・adjustmentCount … これまでの調整
 * 取り分が変わる処理（返金・異議申し立て）は、取引の更新と同じトランザクションの中で調整を作る。
 * そのため、通知の再送・重複・同時実行でも、差額（今の取り分 − 支払った額 − これまでの調整）は1回だけ記録される。
 *
 * 取引の月の精算の状態ごとの扱い：
 *  - 未払い・精算なし …………………… 調整しない（未払いの精算を集計し直すと反映される）
 *  - 新しい仕組みで確定（lockedAt あり）… 取引に支払った額の記録があれば差額を調整。記録が無い取引は、確定の後に確定した決済
 *                                         （支払っていない）なので、支払った額 0 として取り込み、差額を調整する
 *  - 以前の仕組みで確定（lockedAt なし）… 取引ごとに支払った額が分からないため、推測で差し引かない。
 *                                         取り分が変わったら「決済要確認」に記録し、運営が確認する（調整は作らない）
 */

export type Adjustment = {
  id: string;
  storeId: string;
  transactionId: string | null;
  paymentProvider: string | null;
  providerPaymentId: string | null;
  stripeChargeId: string | null;
  /** 対象月（元の取引の月。繰越は元の精算の月） */
  yearMonth: string;
  /** 調整額（円。マイナスは次回の精算から差し引く） */
  amount: number;
  reason: AdjustmentReason;
  status: AdjustmentStatus;
  sourceSettlementId: string | null;
  appliedSettlementId: string | null;
  appliedAt: Date | null;
  detail: string;
  createdAt: Date;
};

const adjCol = () => fsdb().collection(C.settlementAdjustments);

export function toAdjustment(id: string, d: DocumentData): Adjustment {
  return {
    id,
    storeId: String(d.storeId),
    transactionId: typeof d.transactionId === "string" ? d.transactionId : null,
    paymentProvider: typeof d.paymentProvider === "string" ? d.paymentProvider : null,
    providerPaymentId: typeof d.providerPaymentId === "string" ? d.providerPaymentId : null,
    stripeChargeId: typeof d.stripeChargeId === "string" ? d.stripeChargeId : null,
    yearMonth: String(d.yearMonth),
    amount: Number(d.amount ?? 0),
    reason: d.reason as AdjustmentReason,
    status: d.status === "APPLIED" ? "APPLIED" : "OPEN",
    sourceSettlementId: typeof d.sourceSettlementId === "string" ? d.sourceSettlementId : null,
    appliedSettlementId: typeof d.appliedSettlementId === "string" ? d.appliedSettlementId : null,
    appliedAt: toDate(d.appliedAt),
    detail: String(d.detail ?? ""),
    createdAt: toDate(d.createdAt) ?? new Date(0),
  };
}

/** 取引の記録 → 取り分の判定に使う値 */
export function txFacts(d: DocumentData): SettlementTxFacts {
  return {
    paymentProvider: String(d.paymentProvider),
    livemode: d.livemode,
    paymentStatus: String(d.paymentStatus),
    amount: Number(d.amount),
    storeShare: Number(d.storeShare),
    storeShareBps: Number.isInteger(Number(d.storeShareBps)) ? Number(d.storeShareBps) : STORE_SHARE_BPS,
    amountRefunded: Number(d.amountRefunded ?? 0),
    disputeStatus: (d.disputeStatus ?? null) as DisputeState | null,
    disputeAmount: typeof d.disputeAmount === "number" ? d.disputeAmount : null,
  };
}

/** 取引の月の精算（店舗ID_年月）。返金・異議申し立ての処理で、取引と同じトランザクションの中で読む */
export const settlementRefForTx = (d: DocumentData) => fsdb().collection(C.settlements).doc(`${d.storeId}_${d.yearMonth}`);

export type SettlementSnap = { id: string; data: DocumentData | undefined } | null;
export type ReconcileResult = { fields: Record<string, unknown>; review?: PaymentReviewInput };

/**
 * 取引の更新（patch）と同じトランザクションで、確定済みの精算との差額を調整として記録する。
 * 呼び出し側は、取引とその月の精算（settlement。settlementRefForTx）の読み取りを済ませてから呼ぶ（ここでは書き込みだけ）。
 * fields は取引の更新に合わせて書き込む項目（調整の合計・件数、取り込みの記録）。
 * review は「決済要確認」に記録する内容（以前の仕組みで確定した月の取引が変わったとき）。トランザクションの後で記録する。
 */
export function reconcileTransactionInTx(
  tx: Transaction,
  txRef: DocumentReference,
  before: DocumentData,
  patch: Record<string, unknown>,
  kind: "refund" | "dispute" | "late",
  detail = "",
  settlement: SettlementSnap = null,
): ReconcileResult {
  const merged = { ...before, ...patch };
  let settlementId = merged.settlementId;
  let stamp: Record<string, unknown> = {};
  let effectiveKind = kind;
  if (typeof settlementId !== "string" || !settlementId) {
    const st = settlement?.data;
    if (!st || st.status === "UNPAID" || !isSettlementPayment(String(merged.paymentProvider), merged.livemode)) return { fields: {} }; // 未払い：再集計で反映
    if (!st.lockedAt) {
      // 以前の仕組みで確定した月：支払った額が分からないので、推測で差し引かずに要確認にする
      const change = entitledStoreShare(txFacts(merged)) - entitledStoreShare(txFacts(before));
      if (change === 0) return { fields: {} };
      return {
        fields: { legacySettlementReview: true },
        review: {
          kind: "legacy_settlement_change",
          objectType: "transaction",
          objectId: txRef.id,
          transactionId: txRef.id,
          storeId: String(merged.storeId),
          settlementId: settlement!.id,
          yearMonth: String(merged.yearMonth),
          chargeId: typeof merged.stripeChargeId === "string" ? merged.stripeChargeId : null,
          paymentIntentId: typeof merged.providerPaymentId === "string" ? merged.providerPaymentId : null,
          amount: change,
          livemode: merged.livemode === true,
        },
      };
    }
    // 新しい仕組みで確定した月で、支払った額の記録が無い：確定の後に確定した決済（支払っていない）として取り込む
    settlementId = settlement!.id;
    stamp = { settlementId, settledShare: 0, settledAt: new Date() };
    merged.settlementId = settlementId;
    merged.settledShare = 0;
    effectiveKind = "late";
  }
  const entitled = entitledStoreShare(txFacts(merged));
  const prevTotal = Number(before.adjustmentTotal ?? 0);
  const delta = adjustmentDelta(entitled, Number(merged.settledShare ?? 0), prevTotal);
  if (delta === 0) return { fields: stamp };
  const n = Number(before.adjustmentCount ?? 0) + 1;
  const reason = adjustmentReasonFor(effectiveKind, delta, {
    refundedPartially: Number(merged.amountRefunded ?? 0) > 0 && Number(merged.amountRefunded ?? 0) < Number(merged.amount) && merged.paymentStatus === "SUCCEEDED",
    disputeStatus: (merged.disputeStatus ?? null) as DisputeState | null,
  });
  tx.create(adjCol().doc(`${txRef.id}_${n}`), {
    storeId: String(merged.storeId),
    transactionId: txRef.id,
    paymentProvider: String(merged.paymentProvider),
    providerPaymentId: String(merged.providerPaymentId ?? ""),
    stripeChargeId: typeof merged.stripeChargeId === "string" ? merged.stripeChargeId : null,
    yearMonth: String(merged.yearMonth),
    amount: delta,
    reason,
    status: "OPEN",
    sourceSettlementId: String(settlementId),
    appliedSettlementId: null,
    appliedAt: null,
    livemode: merged.livemode === true,
    detail: detail.slice(0, 300),
    createdAt: FieldValue.serverTimestamp(),
  });
  return { fields: { ...stamp, adjustmentTotal: prevTotal + delta, adjustmentCount: n } };
}

/**
 * 取引を確定済みの精算に含める（精算の確定時・締め後に確定した決済の取り込み）。1件ずつトランザクションで行う。
 *  lock … 精算の確定時：今の取り分を支払う額として記録する
 *  late … 確定済みの精算の後に確定した決済：支払った額は 0 とし、差額（今の取り分）を調整として記録する
 * 既に別の精算に含めた取引は変えない。
 */
export async function stampTransaction(txId: string, settlementId: string, mode: "lock" | "late"): Promise<"stamped" | "late" | "skipped"> {
  const ref = fsdb().collection(C.transactions).doc(txId);
  return fsdb().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const d = snap.data();
    if (!d || d.settlementId) return "skipped" as const;
    const settledShare = mode === "lock" ? entitledStoreShare(txFacts(d)) : 0;
    const stamp = { settlementId, settledShare, settledAt: new Date() };
    const extra = mode === "late" ? reconcileTransactionInTx(tx, ref, { ...d, ...stamp }, {}, "late", "精算の確定後に確定した決済").fields : {};
    tx.update(ref, { ...stamp, ...extra, updatedAt: FieldValue.serverTimestamp() });
    return mode === "late" ? ("late" as const) : ("stamped" as const);
  });
}

export async function listAdjustments(opts: { storeId?: string; status?: AdjustmentStatus; limit?: number } = {}): Promise<Adjustment[]> {
  const q = opts.storeId ? adjCol().where("storeId", "==", opts.storeId) : opts.status ? adjCol().where("status", "==", opts.status) : adjCol();
  const snap = await q.get();
  return snap.docs
    .map((d) => toAdjustment(d.id, d.data()))
    .filter((a) => !opts.status || a.status === opts.status)
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
    .slice(0, opts.limit ?? Number.MAX_SAFE_INTEGER);
}

/** 未反映の調整がある店舗ID */
export async function storesWithOpenAdjustments(): Promise<string[]> {
  const snap = await adjCol().where("status", "==", "OPEN").get();
  return [...new Set(snap.docs.map((d) => String(d.get("storeId"))))];
}

