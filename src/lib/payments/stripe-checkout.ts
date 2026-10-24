import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Stripe Checkout (hosted) のサーバー専用 API 基盤。
 * この段階では決済を有効化しない。呼び出し元の API / Webhook と
 * Firestore の冪等な確定処理が揃うまで公開しない。
 */
const STRIPE_API = "https://api.stripe.com/v1";

export type StripeCheckoutSession = {
  id: string;
  url: string | null;
  status: "open" | "complete" | "expired";
  payment_status: "paid" | "unpaid" | "no_payment_required";
  payment_intent: string | null;
  amount_total: number | null;
  currency: string | null;
  livemode: boolean;
  metadata: Record<string, string> | null;
};

export type StripeEvent = {
  id: string;
  type: string;
  livemode: boolean;
  data: { object: { id?: string; object?: string; payment_intent?: string | null } };
};

function testSecret(): string {
  const key = process.env.STRIPE_SECRET_KEY ?? "";
  // 本番用キーでは絶対に動かさない（Preview 専用のテスト実装）。
  if (process.env.VERCEL_ENV !== "preview" || !key.startsWith("sk_test_")) {
    throw new Error("Stripe sandbox is available only on Preview with sk_test_");
  }
  return key;
}

async function stripeRequest(path: string, init?: { method?: "GET" | "POST"; body?: URLSearchParams; idempotencyKey?: string }) {
  const headers: Record<string, string> = { Authorization: `Bearer ${testSecret()}` };
  if (init?.body) headers["Content-Type"] = "application/x-www-form-urlencoded";
  if (init?.idempotencyKey) headers["Idempotency-Key"] = init.idempotencyKey;
  const response = await fetch(`${STRIPE_API}${path}`, {
    method: init?.method ?? "GET",
    headers,
    body: init?.body?.toString(),
    cache: "no-store",
    signal: AbortSignal.timeout(20_000),
  });
  const json = await response.json();
  if (!response.ok) throw new Error(`Stripe request failed: HTTP ${response.status}`);
  return json;
}

export async function createStripeCheckoutSession(input: {
  checkoutId: string;
  storeId: string;
  fortuneType: string;
  amountJpy: number;
  successUrl: string;
  cancelUrl: string;
}): Promise<StripeCheckoutSession> {
  if (!Number.isSafeInteger(input.amountJpy) || input.amountJpy <= 0) throw new Error("Invalid amount");
  for (const url of [input.successUrl, input.cancelUrl]) {
    if (!url.startsWith("https://")) throw new Error("Checkout redirect must use HTTPS");
  }
  const body = new URLSearchParams({
    mode: "payment",
    success_url: input.successUrl,
    cancel_url: input.cancelUrl,
    "line_items[0][price_data][currency]": "jpy",
    "line_items[0][price_data][unit_amount]": String(input.amountJpy),
    "line_items[0][price_data][product_data][name]": "占い",
    "line_items[0][quantity]": "1",
    "metadata[checkoutId]": input.checkoutId,
    "metadata[storeId]": input.storeId,
    "metadata[fortuneType]": input.fortuneType,
    "payment_intent_data[metadata][checkoutId]": input.checkoutId,
    "payment_intent_data[metadata][storeId]": input.storeId,
    "payment_intent_data[metadata][fortuneType]": input.fortuneType,
  });
  return stripeRequest("/checkout/sessions", {
    method: "POST",
    body,
    idempotencyKey: `checkout-session-${input.checkoutId}`,
  }) as Promise<StripeCheckoutSession>;
}

export async function retrieveStripeCheckoutSession(id: string): Promise<StripeCheckoutSession> {
  if (!/^cs_test_[A-Za-z0-9_]+$/.test(id)) throw new Error("Invalid sandbox session ID");
  return stripeRequest(`/checkout/sessions/${encodeURIComponent(id)}`) as Promise<StripeCheckoutSession>;
}

/** Stripe-Signature の v1 HMAC を生の本文で検証。リプレイを5分以内に制限。 */
export function verifyStripeWebhook(rawBody: string, signature: string | null): StripeEvent {
  const secret = process.env.STRIPE_WEBHOOK_SECRET ?? "";
  if (process.env.VERCEL_ENV !== "preview" || !secret.startsWith("whsec_")) throw new Error("Stripe webhook not configured for Preview");
  if (!signature) throw new Error("Missing Stripe signature");
  const parts = signature.split(",").map((s) => s.trim().split("="));
  const timestamp = parts.find(([k]) => k === "t")?.[1];
  const signatures = parts.filter(([k]) => k === "v1").map(([, v]) => v);
  const t = Number(timestamp);
  if (!timestamp || !Number.isSafeInteger(t) || Math.abs(Math.floor(Date.now() / 1000) - t) > 300) {
    throw new Error("Invalid Stripe signature timestamp");
  }
  const expected = createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest();
  const valid = signatures.some((hex) => {
    if (!/^[0-9a-f]{64}$/i.test(hex)) return false;
    return timingSafeEqual(expected, Buffer.from(hex, "hex"));
  });
  if (!valid) throw new Error("Invalid Stripe signature");
  const event = JSON.parse(rawBody) as StripeEvent;
  if (!event.id || !event.type || event.livemode) throw new Error("Invalid sandbox event");
  return event;
}
