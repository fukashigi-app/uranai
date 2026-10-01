import "server-only";
import { percentStringToBps } from "@/lib/money";
import { safeEqual } from "@/lib/security/crypto";
import {
  WebhookVerificationError,
  type CreateChargeInput,
  type CreateChargeResult,
  type PaymentProvider,
  type ProviderCharge,
  type WebhookEvent,
} from "./types";

const API_BASE = "https://api.pay.jp/v1";

type PayjpCharge = {
  id: string;
  object: "charge";
  amount: number;
  currency: string;
  paid: boolean;
  captured: boolean;
  refunded: boolean;
  amount_refunded: number;
  fee_rate?: string | null;
  metadata?: Record<string, string> | null;
  livemode: boolean;
  created: number;
};

type PayjpError = { error?: { code?: string; message?: string; type?: string; status?: number } };

/** PAY.JP のエラーコード → 利用者向け日本語メッセージ */
const ERROR_MESSAGES: Record<string, string> = {
  card_declined: "カードが利用できませんでした。別のカードをお試しください。",
  expired_card: "カードの有効期限が切れています。別のカードをお試しください。",
  incorrect_card_data: "カード情報に誤りがあります。入力内容をご確認ください。",
  invalid_cvc: "セキュリティコードが正しくありません。",
  invalid_expiry_month: "有効期限（月）が正しくありません。",
  invalid_expiry_year: "有効期限（年）が正しくありません。",
  processing_error: "決済処理中にエラーが発生しました。時間をおいて再度お試しください。",
  unverified_token: "3Dセキュア認証が完了していません。もう一度お試しください。",
  three_d_secure_incompleted: "3Dセキュア認証が完了していません。もう一度お試しください。",
  three_d_secure_failed: "3Dセキュア認証に失敗しました。別のカードをお試しください。",
  already_used_token: "このカード情報は使用済みです。もう一度カード情報を入力してください。",
  invalid_id: "カード情報の有効期限が切れました。もう一度入力してください。",
};

function toCharge(c: PayjpCharge): ProviderCharge {
  const md = c.metadata ?? {};
  return {
    id: c.id,
    amount: c.amount,
    currency: c.currency,
    paid: c.paid,
    captured: c.captured,
    refunded: c.refunded,
    amountRefunded: c.amount_refunded ?? 0,
    feeRateBps: percentStringToBps(c.fee_rate ?? null),
    metadata: { checkoutId: md.checkoutId, storeId: md.storeId, fortuneType: md.fortuneType },
    livemode: c.livemode,
    createdAt: new Date(c.created * 1000),
  };
}

export class PayjpProvider implements PaymentProvider {
  readonly id = "payjp" as const;

  constructor(
    private readonly secretKey: string,
    private readonly publicKey: string,
    private readonly webhookToken: string,
  ) {}

  publicConfig() {
    return { provider: this.id, publicKey: this.publicKey };
  }

  private authHeader() {
    return `Basic ${Buffer.from(`${this.secretKey}:`).toString("base64")}`;
  }

  async createCharge(input: CreateChargeInput): Promise<CreateChargeResult> {
    const body = new URLSearchParams({
      amount: String(input.amount),
      currency: input.currency,
      card: input.cardToken,
      capture: "true",
      description: input.description,
      "metadata[checkoutId]": input.metadata.checkoutId,
      "metadata[storeId]": input.metadata.storeId,
      "metadata[fortuneType]": input.metadata.fortuneType,
    });
    let res: Response;
    try {
      res = await fetch(`${API_BASE}/charges`, {
        method: "POST",
        headers: {
          Authorization: this.authHeader(),
          "Content-Type": "application/x-www-form-urlencoded",
          // 同一キーの再送は同じ結果を返す（ネットワーク再試行での二重課金防止）
          "Idempotency-Key": input.idempotencyKey,
        },
        body,
        signal: AbortSignal.timeout(25_000),
        cache: "no-store",
      });
    } catch {
      return {
        ok: false,
        code: "network_error",
        userMessage: "通信エラーが発生しました。お支払い状況を確認しています。",
        retryable: false,
        ambiguous: true,
      };
    }
    const json = (await res.json().catch(() => ({}))) as PayjpCharge & PayjpError;
    if (!res.ok || json.error) {
      const code = json.error?.code ?? `http_${res.status}`;
      return {
        ok: false,
        code,
        userMessage: ERROR_MESSAGES[code] ?? "お支払いを完了できませんでした。別のカードをお試しいただくか、時間をおいて再度お試しください。",
        retryable: res.status < 500,
        ambiguous: res.status >= 500,
      };
    }
    return { ok: true, charge: toCharge(json) };
  }

  async retrieveCharge(chargeId: string): Promise<ProviderCharge | null> {
    if (!/^ch_[A-Za-z0-9]+$/.test(chargeId)) return null;
    const res = await fetch(`${API_BASE}/charges/${encodeURIComponent(chargeId)}`, {
      headers: { Authorization: this.authHeader() },
      signal: AbortSignal.timeout(15_000),
      cache: "no-store",
    });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`payjp retrieve failed: ${res.status}`);
    return toCharge((await res.json()) as PayjpCharge);
  }

  async parseWebhook(headers: Headers, rawBody: string): Promise<WebhookEvent> {
    // PAY.JP は管理画面で発行される Webhook トークンを X-Payjp-Webhook-Token ヘッダで送る
    const token = headers.get("x-payjp-webhook-token");
    if (!token || !safeEqual(token, this.webhookToken)) {
      throw new WebhookVerificationError("invalid webhook token");
    }
    let event: { id?: string; type?: string; data?: { id?: string; object?: string } };
    try {
      event = JSON.parse(rawBody);
    } catch {
      throw new WebhookVerificationError("invalid json");
    }
    const eventId = String(event.id ?? "");
    const type = String(event.type ?? "");
    const chargeId = event.data?.object === "charge" ? String(event.data.id ?? "") : "";
    if (!eventId) throw new WebhookVerificationError("missing event id");
    // 本文の内容は信用せず、chargeId だけを使って API から取り直す（confirm 側で実施）
    if (chargeId && type === "charge.succeeded") return { kind: "charge.succeeded", eventId, chargeId };
    if (chargeId && type === "charge.refunded") return { kind: "charge.refunded", eventId, chargeId };
    if (chargeId && type === "charge.failed") return { kind: "charge.failed", eventId, chargeId };
    return { kind: "ignored", eventId, type };
  }
}
