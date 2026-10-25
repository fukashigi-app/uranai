/**
 * 占いの選択画面（/fortune）で、Stripe のテスト決済の専用の入口を開くか（純粋な判定。単体テスト用に分けている）。
 *
 *  - /fortune?pay=stripe-test のときだけ。パラメーターが無ければ今までどおり（開発モードの運営は無料の占い）
 *  - Stripe のテスト決済を使える人（stripeTestAccess が OK＝Preview・設定がそろっている・運営アカウント）だけ。
 *    それ以外の人には、パラメーターを付けても何も変わらない（入口があることも見せない）
 *  - 危険な設定で止めているとき（halted）は開かない
 *  - 有料の注文は実店舗だけ（テスト店舗 /s/test では作れない）。実店舗の QR が無ければ、その案内を出す
 */
export const STRIPE_TEST_PAY_PARAM = "stripe-test";

export type StripeTestEntry = "off" | "stripe-test" | "real_store_required";

export function stripeTestEntry(input: { pay: unknown; stripeOk: boolean; halted: boolean; realStoreCode: boolean }): StripeTestEntry {
  if (input.pay !== STRIPE_TEST_PAY_PARAM || !input.stripeOk || input.halted) return "off";
  return input.realStoreCode ? "stripe-test" : "real_store_required";
}
