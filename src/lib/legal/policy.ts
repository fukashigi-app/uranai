import "server-only";
import { CHECKOUT_TTL_MS, FORTUNE_SESSION_TTL_MS, PRICE_JPY, RESULT_VIEWABLE_MS } from "@/config/pricing";
import { readOperatorInfo } from "@/config/operator";

/**
 * 特定商取引法に基づく表記・利用規約・プライバシーポリシー・購入画面で共通に使う運営方針。
 * 期限・価格はサーバーの実装値（config/pricing.ts）から作り、文書と実際の動作がずれないようにする。
 */

/** 3文書の最終更新日 */
export const LEGAL_UPDATED = "2026年10月16日";

/**
 * 決済代行サービス（実装: src/lib/payments/stripe-*.ts。Stripe Checkout）。PAY.JP は廃止した。
 * 表示はサービス名。契約の相手方（法人名）は運営者が確認して、必要なら各文書に追記する（推測で書かない）。
 */
export const PAYMENT_PROCESSOR = "Stripe";

/**
 * 支払方法の表示。実装では Stripe Checkout にカード・PayPay の表示を許可している（lib/payments/stripe-checkout.ts の
 * allowed_payment_method_types。Apple Pay・Google Pay はカードの一部として表示される場合がある）が、
 * 実際に表示されるかは本番の Stripe アカウントの設定・審査による。運営者が本番で確認するまでは、特定の方法を利用できると断定しない。
 */
export const PAYMENT_METHODS_LABEL = "クレジットカードなど、決済画面に表示されるお支払い方法";

/** 支払時期（Stripe Checkout：購入ボタンで Stripe の決済画面に移動し、決済画面で手続きを完了した時点で決済） */
export const paymentTimingText = (buttonLabel: string) =>
  `お支払い画面の「${buttonLabel}」ボタンを押すと、${PAYMENT_PROCESSOR}の決済画面に移動します。決済画面でお支払いの手続きを完了した時点で決済されます。`;

/** 返金の申し出の目安（決済日から） */
export const REFUND_REQUEST_DAYS = 30;
/** 一般の問い合わせ・個人情報の開示等の請求への回答の目安 */
export const REPLY_BUSINESS_DAYS = 3;

const hours = (ms: number) => Math.round(ms / 3_600_000);
const minutes = (ms: number) => Math.round(ms / 60_000);

export const PRICE_LABEL = `${PRICE_JPY}円（税込）`;
/** 決済後、占いを実行できる期限（時間） */
export const FORTUNE_USE_HOURS = hours(FORTUNE_SESSION_TTL_MS);
/** 占った後、結果を再表示できる期間（時間） */
export const RESULT_VIEW_HOURS = hours(RESULT_VIEWABLE_MS);
/** 支払い画面の有効期限（分） */
export const CHECKOUT_MINUTES = minutes(CHECKOUT_TTL_MS);

/** 返金の対象になる場合 */
export const REFUND_CASES = [
  "同じお申込みについて、重複して決済された場合",
  "お支払い後、当方のシステム障害など当方の事情により、占い結果が提供されなかった場合",
  "当方の不具合により、表示された占い結果に重大な誤りがあった場合",
] as const;

/** 返金の申し出の目安と、法令上の権利を制限しない旨 */
export const REFUND_REQUEST_NOTE = `返金のお申し出は、決済日から${REFUND_REQUEST_DAYS}日以内を目安にご連絡ください。この目安は、法令上お客様に認められる返金・解除などの権利を制限するものではありません。`;

/** 回答の目安と、法令上の対応を優先する旨 */
export const REPLY_NOTE = `原則として${REPLY_BUSINESS_DAYS}営業日以内に返信します。法令により遅滞なく対応すべき場合は、それに従います。`;

/** 氏名・住所・電話番号を表示していない場合の文言（この方式が法令上の条件を満たすかは未確認：公開前に要確認） */
export const DISCLOSE_ON_REQUEST = "ご請求があれば、遅滞なく開示いたします。";

/** 事業者情報（氏名・住所・電話番号）の開示請求への回答の目標（一般の問い合わせより早く対応する） */
export const DISCLOSURE_REPLY_NOTE =
  "原則として受付当日中、遅くとも翌営業日中に、ご請求いただいたメールアドレスへ回答することを目標としています。法令により遅滞なく対応すべき場合は、それに従います。";

/** 事業者情報の開示請求の条件（購入や本人確認を一律の条件にしない） */
export const DISCLOSURE_CONDITIONS =
  "ご購入の前後を問わず、どなたでもご請求いただけます。ご請求にあたって、ご購入や本人確認書類の提出は必要ありません。";

export function operatorInfo() {
  return readOperatorInfo().info;
}
