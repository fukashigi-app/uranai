import "server-only";
import { CHECKOUT_TTL_MS, FORTUNE_SESSION_TTL_MS, PRICE_JPY, RESULT_VIEWABLE_MS } from "@/config/pricing";
import { readOperatorInfo, type OperatorInfo } from "@/config/operator";

/**
 * 特定商取引法に基づく表記・利用規約・プライバシーポリシー・購入画面で共通に使う運営方針。
 * 期限・価格はサーバーの実装値（config/pricing.ts）から作り、文書と実際の動作がずれないようにする。
 */

/**
 * 文書ごとの最終更新日。その文書の表示内容を変えたときだけ、その文書の日付を更新する
 * （ほかの文書の修正に合わせて一律に変えない）。
 */
export const LEGAL_UPDATED = {
  /** 特定商取引法に基づく表記（2026年11月7日：氏名・住所・電話番号の請求時開示の説明を統一） */
  commercialTransaction: "2026年11月7日",
  /** 利用規約（2026年10月27日：第4条の決済代行・支払い方法・支払い時期の文言を Stripe に合わせて変更） */
  terms: "2026年10月27日",
  /** プライバシーポリシー（2026年11月7日：事業者の情報の開示の案内を特定商取引法に基づく表記へ集約） */
  privacy: "2026年11月7日",
} as const;

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

/**
 * 販売事業者の氏名・住所・電話番号の請求時開示（特定商取引法第11条ただし書き）の説明。
 * 個人事業主のため、これらの値は画面・コードに埋め込まない（環境変数に設定されていても公開ページには表示しない。publicOperatorInfo）。
 * omitted … 表示を省略している項目（「氏名」「住所」「電話番号」の順）。説明は特定商取引法に基づく表記の1か所だけに出す
 * （この方式が法令上の条件を満たすかは、運営者が外部で確認する）。
 */
export function disclosureStatement(omitted: readonly string[]): string {
  const items = omitted.length <= 1 ? omitted.join("") : `${omitted.slice(0, -1).join("、")}および${omitted[omitted.length - 1]}`;
  const these = omitted.length <= 1 ? "この情報" : "これらの情報";
  return (
    `特定商取引法第11条ただし書きに基づき、販売事業者の${items}の表示を省略しております。` +
    `${these}について開示をご希望の場合は、本ページ記載のお問い合わせ先メールアドレスまでご連絡ください。` +
    "商品の購入前でもご請求いただけます。ご請求があった場合、遅滞なく電子メール等により情報を提供いたします。"
  );
}

/** 開示の請求のメールの件名の目安（請求の受付を見落とさないため） */
export const DISCLOSURE_REQUEST_SUBJECT = "特定商取引法に基づく表記の開示請求";

/** 表示を省略している販売事業者の情報（氏名・住所・電話番号の順。すべて表示していれば空） */
export function omittedOperatorItems(op: { ownerName: string | null; address: string | null; phone: string | null }): string[] {
  return [op.ownerName ? null : "氏名", op.address ? null : "住所", op.phone ? null : "電話番号"].filter((v): v is string => v !== null);
}

/**
 * 一般公開ページ（特定商取引法に基づく表記・利用規約・プライバシーポリシー）に表示する運営者情報。
 * 事業者の氏名・住所・電話番号は、環境変数（OPERATOR_OWNER_NAME・OPERATOR_ADDRESS・OPERATOR_PHONE）が設定されていても
 * 常に表示しない（特定商取引法第11条ただし書きに基づく請求時開示。値は開示の請求に応じるために環境変数に保持するだけで、
 * ページ・HTML には含めない）。屋号・問い合わせ先は今までどおり表示する。
 * 環境変数の形式の確認（運営画面・/api/health の通知）は readOperatorInfo のまま。
 */
export function publicOperatorInfo(): OperatorInfo {
  const { info } = readOperatorInfo();
  return { ...info, ownerName: null, address: null, phone: null };
}
