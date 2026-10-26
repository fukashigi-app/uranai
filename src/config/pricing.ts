import "server-only";

/**
 * 課金額・売上配分。課金額は必ずここを参照し、クライアントから送られた値は使わない。
 */
export const PRICE_JPY = 100 as const;
export const CURRENCY = "jpy" as const;

/**
 * 店舗の取り分（basis points: 3000 = 30%。100円 → 店舗30円・運営70円）。全店舗一律・固定で、店舗ごとには変更できない。
 * 新規の決済は必ずこの率で配分する（店舗のデータ stores.storeShareBps に古い値が残っていても使わない）。
 * 過去の取引は、決済時点で transactions に保存した取り分のまま（書き換えない）。決済手数料は運営の負担（取り分からは引かない）。
 */
export const STORE_SHARE_BPS = 3000;

/** 決済手数料率の既定値（bps）。PAY.JP は charge.fee_rate を優先して使う */
export function defaultFeeRateBps(): number {
  const v = Number(process.env.PAYMENT_FEE_RATE_BPS ?? "360");
  return Number.isInteger(v) && v >= 0 && v < 10000 ? v : 360;
}

/** 決済後、占いを実行できる期限 */
export const FORTUNE_SESSION_TTL_MS = 24 * 60 * 60 * 1000;
/** 占い実行後、同じ結果を再表示できる期間 */
export const RESULT_VIEWABLE_MS = 24 * 60 * 60 * 1000;
/** 決済画面を開いてから支払いできる期限 */
export const CHECKOUT_TTL_MS = 30 * 60 * 1000;
