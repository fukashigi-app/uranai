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
 * 現在の決済代行サービス（実装: src/lib/payments/payjp.ts）。
 * Stripe へ移行するときは、ここと各文書の決済代行に関する記載を見直すこと。
 */
export const PAYMENT_PROCESSOR = "PAY.JP";

/** 返金の申し出の目安（決済日から） */
export const REFUND_REQUEST_DAYS = 30;
/** 問い合わせ・開示請求への回答の目安 */
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

export function operatorInfo() {
  return readOperatorInfo().info;
}
