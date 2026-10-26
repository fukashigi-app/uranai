import { describe, expect, it } from "vitest";
import {
  chargebackCoversRemainder,
  disputedAmountOf,
  adjustmentDelta,
  adjustmentReasonFor,
  applyAdjustments,
  disputeStateOf,
  entitledStoreShare,
  heldStoreShare,
  netSalesFigures,
  type SettlementTxFacts,
} from "@/lib/payments/settlement-rules";

const LIVE: SettlementTxFacts = { paymentProvider: "stripe", livemode: true, paymentStatus: "SUCCEEDED", amount: 100, storeShare: 30, storeShareBps: 3000 };

describe("今の時点で店舗に支払うべき取り分", () => {
  it("本番の決済は保存した取り分（30円）。決済時に25%で記録された過去の取引は25円のまま", () => {
    expect(entitledStoreShare(LIVE)).toBe(30);
    expect(entitledStoreShare({ ...LIVE, storeShare: 25, storeShareBps: 2500 })).toBe(25);
  });

  it("テスト決済・疑似決済・判定不可は、本番の精算に決して含めない", () => {
    expect(entitledStoreShare({ ...LIVE, livemode: false })).toBe(0);
    expect(entitledStoreShare({ ...LIVE, livemode: undefined })).toBe(0);
    expect(entitledStoreShare({ ...LIVE, paymentProvider: "mock" })).toBe(0);
  });

  it("全額の返金・敗訴は 0、異議申し立ての対応中は 0（保留）、勝訴は元に戻る", () => {
    expect(entitledStoreShare({ ...LIVE, paymentStatus: "REFUNDED", amountRefunded: 100 })).toBe(0);
    expect(entitledStoreShare({ ...LIVE, paymentStatus: "CHARGEBACK", disputeStatus: "lost" })).toBe(0);
    expect(entitledStoreShare({ ...LIVE, disputeStatus: "open" })).toBe(0);
    expect(heldStoreShare({ ...LIVE, disputeStatus: "open" })).toBe(30);
    expect(entitledStoreShare({ ...LIVE, disputeStatus: "won" })).toBe(30);
    expect(heldStoreShare({ ...LIVE, disputeStatus: "won" })).toBe(0);
  });

  it("一部返金（Stripe 側で発生）は返金後の金額の30%（切り捨て）。合計は常に一致", () => {
    expect(entitledStoreShare({ ...LIVE, amountRefunded: 30 })).toBe(21); // 70円 × 30% = 21円
    expect(entitledStoreShare({ ...LIVE, amountRefunded: 1 })).toBe(29); // 99円 × 30% = 29.7 → 29円
    const n = netSalesFigures({ amount: 100, storeShare: 30, operatorShare: 70, storeShareBps: 3000, amountRefunded: 30 });
    expect(n).toEqual({ gross: 70, storeShare: 21, operatorShare: 49 });
    expect(n.storeShare + n.operatorShare).toBe(n.gross);
    // 返金の額が金額を超えたり、おかしな値でも、マイナスにはならない
    expect(entitledStoreShare({ ...LIVE, amountRefunded: 1000 })).toBe(0);
    expect(entitledStoreShare({ ...LIVE, amountRefunded: -5 })).toBe(30);
    expect(entitledStoreShare({ ...LIVE, amountRefunded: Number.NaN })).toBe(30);
  });

  it("返金の処理中・失敗は額に入れない（成功した返金の額だけ。呼び出し側で amountRefunded に成功分だけを入れる）", () => {
    expect(entitledStoreShare({ ...LIVE, amountRefunded: 0 })).toBe(30);
  });
});

describe("異議申し立ての状態", () => {
  it("勝訴・注意の終了・防止は won、敗訴は lost、それ以外（不明な値も）は対応中", () => {
    for (const s of ["won", "warning_closed", "prevented"]) expect(disputeStateOf(s)).toBe("won");
    expect(disputeStateOf("lost")).toBe("lost");
    for (const s of ["needs_response", "under_review", "warning_needs_response", "warning_under_review", "something_new"]) expect(disputeStateOf(s)).toBe("open");
  });
});

describe("振込済みの取引の調整額", () => {
  it("差額 = 今の取り分 − 支払った額 − これまでの調整（再計算しても二重にならない）", () => {
    expect(adjustmentDelta(0, 30, 0)).toBe(-30); // 振込後の全額返金
    expect(adjustmentDelta(0, 30, -30)).toBe(0); // 同じ返金の再送
    expect(adjustmentDelta(30, 30, -30)).toBe(30); // 異議申し立ての勝訴で保留を解除
    expect(adjustmentDelta(21, 30, 0)).toBe(-9); // 一部返金
    expect(adjustmentDelta(30, 0, 0)).toBe(30); // 締め後に確定した決済
  });

  it("理由", () => {
    expect(adjustmentReasonFor("refund", -30, {})).toBe("refund");
    expect(adjustmentReasonFor("refund", -9, { refundedPartially: true })).toBe("partial_refund");
    expect(adjustmentReasonFor("refund", 30, {})).toBe("refund_reversed");
    expect(adjustmentReasonFor("dispute", -30, { disputeStatus: "open" })).toBe("dispute_hold");
    expect(adjustmentReasonFor("dispute", -30, { disputeStatus: "lost" })).toBe("dispute_lost");
    expect(adjustmentReasonFor("dispute", 30, { disputeStatus: "won" })).toBe("dispute_won");
    expect(adjustmentReasonFor("late", 30, {})).toBe("late_transaction");
  });
});

describe("精算の確定時の振込額", () => {
  it("調整が無ければその月の取り分", () => {
    expect(applyAdjustments(300, [])).toEqual({ adjustmentTotal: 0, payable: 300, carryOver: 0 });
  });
  it("マイナスの調整は差し引き、プラスは加算", () => {
    expect(applyAdjustments(300, [-30, -30, 30])).toEqual({ adjustmentTotal: -30, payable: 270, carryOver: 0 });
  });
  it("調整が振込額を超えたら 0 円にして、残りを次回へ繰り越す", () => {
    expect(applyAdjustments(30, [-90])).toEqual({ adjustmentTotal: -90, payable: 0, carryOver: -60 });
    expect(applyAdjustments(0, [-30])).toEqual({ adjustmentTotal: -30, payable: 0, carryOver: -30 });
    expect(applyAdjustments(60, [-60])).toEqual({ adjustmentTotal: -60, payable: 0, carryOver: 0 });
  });
});

describe("一部の額だけの異議申し立て（過剰に差し引かない）", () => {
  it("対応中：申し立ての額の分だけ保留し、残りは支払う（40円の申し立て → 残り60円の30%＝18円を支払い、12円を保留）", () => {
    const t = { ...LIVE, disputeStatus: "open" as const, disputeAmount: 40 };
    expect(entitledStoreShare(t)).toBe(18);
    expect(heldStoreShare(t)).toBe(12);
    expect(entitledStoreShare(t) + heldStoreShare(t)).toBe(30);
  });
  it("敗訴：申し立ての額だけを売上・取り分から除く。残りは売上に残し、CHARGEBACK にはしない", () => {
    const t = { ...LIVE, disputeStatus: "lost" as const, disputeAmount: 40 };
    expect(entitledStoreShare(t)).toBe(18);
    expect(heldStoreShare(t)).toBe(0);
    expect(chargebackCoversRemainder(t)).toBe(false);
    expect(netSalesFigures({ ...t, operatorShare: 70 })).toEqual({ gross: 60, storeShare: 18, operatorShare: 42 });
  });
  it("勝訴：全額を支払う", () => {
    expect(entitledStoreShare({ ...LIVE, disputeStatus: "won", disputeAmount: 40 })).toBe(30);
  });
  it("全額の申し立て（または返金の後の残りすべて）の敗訴だけ CHARGEBACK", () => {
    expect(chargebackCoversRemainder({ amount: 100, disputeStatus: "lost", disputeAmount: 100 })).toBe(true);
    expect(chargebackCoversRemainder({ amount: 100, amountRefunded: 30, disputeStatus: "lost", disputeAmount: 70 })).toBe(true);
    expect(chargebackCoversRemainder({ amount: 100, disputeStatus: "open", disputeAmount: 100 })).toBe(false);
  });
  it("返金と重なっても、差し引く額は返金の後の残りを超えない（二重に差し引かない）", () => {
    const t = { ...LIVE, amountRefunded: 30, disputeStatus: "lost" as const, disputeAmount: 100 };
    expect(disputedAmountOf(t)).toBe(70);
    expect(entitledStoreShare(t)).toBe(0);
  });
  it("申し立ての額の記録が無い古いデータは全額とみなす（安全側）", () => {
    expect(entitledStoreShare({ ...LIVE, disputeStatus: "open" })).toBe(0);
    expect(heldStoreShare({ ...LIVE, disputeStatus: "open" })).toBe(30);
  });
});
