import "server-only";
import { env } from "@/lib/env";
import { MockProvider } from "./mock";
import { PayjpProvider } from "./payjp";
import type { PaymentProvider, ProviderId } from "./types";

const instances = new Map<ProviderId, PaymentProvider>();

/** 決済を受け付けられない（本番決済が未設定で、テスト決済も無効） */
export class PaymentUnavailableError extends Error {
  constructor() {
    super("payment provider is not configured");
  }
}

/** 指定IDのプロバイダ（Webhook受信時など） */
export function getProvider(id: ProviderId): PaymentProvider {
  const existing = instances.get(id);
  if (existing) return existing;
  const e = env();
  let p: PaymentProvider;
  if (id === "payjp") {
    if (!e.PAYJP_SECRET_KEY || !e.PAYJP_PUBLIC_KEY || !e.PAYJP_WEBHOOK_TOKEN) throw new PaymentUnavailableError();
    p = new PayjpProvider(e.PAYJP_SECRET_KEY, e.PAYJP_PUBLIC_KEY, e.PAYJP_WEBHOOK_TOKEN);
  } else {
    // 自動テスト用の疑似決済（PAYMENT_PROVIDER=mock）。本番では明示許可が無い限り使えない
    if (e.PAYMENT_PROVIDER !== "mock") throw new PaymentUnavailableError();
    p = new MockProvider(e.MOCK_WEBHOOK_SECRET, e.APP_URL);
  }
  instances.set(id, p);
  return p;
}

/** 有料フローの新規決済に使うプロバイダ */
export function activeProvider(): PaymentProvider {
  const id = env().PAYMENT_PROVIDER;
  if (!id) throw new PaymentUnavailableError();
  return getProvider(id);
}

export function isProviderId(v: string): v is ProviderId {
  return v === "payjp" || v === "mock";
}
