import "server-only";
import { hmacSha256Hex, randomToken, safeEqual } from "@/lib/security/crypto";
import {
  WebhookVerificationError,
  type CreateChargeInput,
  type CreateChargeResult,
  type PaymentProvider,
  type ProviderCharge,
  type WebhookEvent,
} from "./types";

/**
 * 開発・E2E検証用の決済プロバイダ。実際のお金は動かない。
 * - Charge ID 自体に HMAC 署名付きで内容を埋め込む（ステートレス・改ざん不可）
 * - Webhook は HMAC-SHA256 署名（Stripe と同形式: t=timestamp,v1=signature）
 * 本番環境では env.ts により起動が拒否される。
 */
type MockPayload = { a: number; c: string; s: string; f: string; t: number; n: string };

export const MOCK_TOKENS = {
  success: "mock_tok_success",
  declined: "mock_tok_declined",
  /** 課金されたか不明な通信エラーを再現（課金はされない） */
  networkError: "mock_tok_network",
} as const;

const TOLERANCE_SEC = 300;

export function signMockWebhook(secret: string, body: string, ts = Math.floor(Date.now() / 1000)): string {
  return `t=${ts},v1=${hmacSha256Hex(secret, `${ts}.${body}`)}`;
}

export class MockProvider implements PaymentProvider {
  readonly id = "mock" as const;

  constructor(
    private readonly secret: string,
    private readonly appUrl: string,
  ) {}

  publicConfig() {
    return { provider: this.id, publicKey: null };
  }

  private encodeId(p: MockPayload): string {
    const body = Buffer.from(JSON.stringify(p)).toString("base64url");
    return `mock_ch_${body}.${hmacSha256Hex(this.secret, body).slice(0, 32)}`;
  }

  private decodeId(id: string): MockPayload | null {
    const m = /^mock_ch_([A-Za-z0-9_-]+)\.([0-9a-f]{32})$/.exec(id);
    if (!m) return null;
    if (!safeEqual(hmacSha256Hex(this.secret, m[1]).slice(0, 32), m[2])) return null;
    try {
      return JSON.parse(Buffer.from(m[1], "base64url").toString("utf8")) as MockPayload;
    } catch {
      return null;
    }
  }

  private toCharge(id: string, p: MockPayload): ProviderCharge {
    return {
      id,
      amount: p.a,
      currency: "jpy",
      paid: true,
      captured: true,
      refunded: false,
      amountRefunded: 0,
      feeRateBps: 360,
      metadata: { checkoutId: p.c, storeId: p.s, fortuneType: p.f },
      livemode: false,
      createdAt: new Date(p.t * 1000),
    };
  }

  async createCharge(input: CreateChargeInput): Promise<CreateChargeResult> {
    if (input.cardToken === MOCK_TOKENS.declined) {
      return { ok: false, code: "card_declined", userMessage: "カードが利用できませんでした。別のカードをお試しください。", retryable: true };
    }
    if (input.cardToken === MOCK_TOKENS.networkError) {
      return { ok: false, code: "network_error", userMessage: "通信エラーが発生しました。お支払い状況を確認しています。", retryable: false, ambiguous: true };
    }
    if (input.cardToken !== MOCK_TOKENS.success) {
      return { ok: false, code: "invalid_token", userMessage: "カード情報を確認できませんでした。もう一度入力してください。", retryable: true };
    }
    const payload: MockPayload = {
      a: input.amount,
      c: input.metadata.checkoutId,
      s: input.metadata.storeId,
      f: input.metadata.fortuneType,
      t: Math.floor(Date.now() / 1000),
      n: randomToken(6),
    };
    const id = this.encodeId(payload);
    this.deliverWebhookLater(id);
    return { ok: true, charge: this.toCharge(id, payload) };
  }

  async retrieveCharge(chargeId: string): Promise<ProviderCharge | null> {
    const p = this.decodeId(chargeId);
    return p ? this.toCharge(chargeId, p) : null;
  }

  async parseWebhook(headers: Headers, rawBody: string): Promise<WebhookEvent> {
    const sig = headers.get("x-mock-signature") ?? "";
    const m = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(sig);
    if (!m) throw new WebhookVerificationError("missing signature");
    const ts = Number(m[1]);
    if (Math.abs(Date.now() / 1000 - ts) > TOLERANCE_SEC) throw new WebhookVerificationError("timestamp out of tolerance");
    if (!safeEqual(hmacSha256Hex(this.secret, `${ts}.${rawBody}`), m[2])) {
      throw new WebhookVerificationError("invalid signature");
    }
    const event = JSON.parse(rawBody) as { id: string; type: string; data: { id: string } };
    if (event.type === "charge.succeeded") return { kind: "charge.succeeded", eventId: event.id, chargeId: event.data.id };
    if (event.type === "charge.refunded") return { kind: "charge.refunded", eventId: event.id, chargeId: event.data.id };
    return { kind: "ignored", eventId: event.id, type: event.type };
  }

  /** 実際の決済代行と同様、Webhook を非同期で送る（開発用） */
  private deliverWebhookLater(chargeId: string) {
    if (process.env.MOCK_WEBHOOK_DISABLED === "true") return;
    const body = JSON.stringify({ id: `mock_evt_${randomToken(12)}`, type: "charge.succeeded", data: { id: chargeId, object: "charge" } });
    setTimeout(() => {
      fetch(`${this.appUrl}/api/webhooks/mock`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-mock-signature": signMockWebhook(this.secret, body) },
        body,
      }).catch(() => {
        /* 届かなくても status API の照合で確定する */
      });
    }, 800);
  }
}
