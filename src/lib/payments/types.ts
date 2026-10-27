/**
 * 疑似決済（自動テスト専用）の抽象。実際の決済は Stripe Checkout だけ（lib/payments/stripe-*.ts。この抽象は使わない）。
 * PAY.JP は廃止した（決済・Webhook・カード入力フォームとも削除）。
 */

/** 新しい決済に使えるプロバイダ（疑似決済だけ） */
export type ProviderId = "mock";

/**
 * 過去の記録に残っている可能性がある決済方法の値（読み取りだけ。新しい決済には使わない）。
 * "payjp" の記録は削除・変更せず、集計・精算・管理画面では paymentProvider と livemode から判定する（lib/payments/kind.ts）。
 */
export type RecordedProviderId = ProviderId | "payjp" | "stripe";

export type ChargeMetadata = {
  checkoutId: string;
  storeId: string;
  fortuneType: string;
};

export type ProviderCharge = {
  id: string;
  amount: number;
  currency: string;
  /** 与信+売上確定まで完了しているか */
  paid: boolean;
  captured: boolean;
  refunded: boolean;
  amountRefunded: number;
  /** 手数料率(bps)。取得できなければ null */
  feeRateBps: number | null;
  metadata: Partial<ChargeMetadata>;
  livemode: boolean;
  createdAt: Date;
};

export type CreateChargeInput = {
  amount: number;
  currency: "jpy";
  cardToken: string;
  description: string;
  metadata: ChargeMetadata;
  idempotencyKey: string;
};

export type CreateChargeResult =
  | { ok: true; charge: ProviderCharge }
  | {
      ok: false;
      code: string;
      userMessage: string;
      retryable: boolean;
      /** 通信断・5xx など、決済代行側で課金されたか分からない失敗。再課金させてはならない */
      ambiguous?: boolean;
    };

export type WebhookEvent =
  | { kind: "charge.succeeded"; eventId: string; chargeId: string }
  | { kind: "charge.refunded"; eventId: string; chargeId: string }
  | { kind: "charge.failed"; eventId: string; chargeId: string }
  | { kind: "ignored"; eventId: string; type: string };

export class WebhookVerificationError extends Error {}

export interface PaymentProvider {
  readonly id: ProviderId;
  /** クライアントに渡してよい設定（公開鍵のみ） */
  publicConfig(): { provider: ProviderId; publicKey: string | null };
  createCharge(input: CreateChargeInput): Promise<CreateChargeResult>;
  retrieveCharge(chargeId: string): Promise<ProviderCharge | null>;
  /** 署名/トークンを検証してイベントを返す。検証失敗時は WebhookVerificationError */
  parseWebhook(headers: Headers, rawBody: string): Promise<WebhookEvent>;
}
