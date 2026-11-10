/** 購入ボタンの文言（購入画面と特定商取引法に基づく表記で共通。クライアントからも参照する） */
export const PAY_BUTTON_LABEL = "同意して決済画面へ進む（100円）";
/** テスト用の決済（PAYMENT_PROVIDER=mock）のボタンの文言 */
export const TEST_PAY_BUTTON_LABEL = "テスト決済で進む（無料）";
/** 購入ボタンのすぐ下に表示する説明（ボタンは決済画面へ進む操作で、支払いの確定は次の Stripe の決済画面で行う） */
export const PAY_BUTTON_NEXT_STEP_NOTE = "次の画面で支払いを確定します";
/** Stripe のテスト決済（Sandbox。実際の請求なし）のボタンの文言 */
export const STRIPE_TEST_PAY_BUTTON_LABEL = `${PAY_BUTTON_LABEL}（テスト）`;
