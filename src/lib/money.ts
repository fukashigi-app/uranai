/** 日本円は整数で扱う。率は basis points（1% = 100）。 */

export function splitRevenue(amount: number, storeShareBps: number) {
  assertYen(amount);
  if (!Number.isInteger(storeShareBps) || storeShareBps < 0 || storeShareBps > 10000) {
    throw new Error("invalid storeShareBps");
  }
  // 店舗報酬は切り捨て（端数は運営側）。100円×30% = 30円
  const storeShare = Math.floor((amount * storeShareBps) / 10000);
  return { storeShare, operatorShare: amount - storeShare };
}

/** 手数料（円）。fee_rate(%) の小数文字列 → bps → 四捨五入 */
export function calcFee(amount: number, feeRateBps: number): number {
  assertYen(amount);
  return Math.round((amount * feeRateBps) / 10000);
}

export function percentStringToBps(rate: string | number | null | undefined): number | null {
  if (rate === null || rate === undefined || rate === "") return null;
  const n = Number(rate);
  if (!Number.isFinite(n) || n < 0 || n >= 100) return null;
  return Math.round(n * 100);
}

export function assertYen(v: number) {
  if (!Number.isSafeInteger(v) || v < 0) throw new Error("amount must be non-negative integer yen");
}

export function formatYen(v: number): string {
  return `${v.toLocaleString("ja-JP")}円`;
}
