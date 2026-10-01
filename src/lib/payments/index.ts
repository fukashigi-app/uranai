import "server-only";
import { env } from "@/lib/env";
import { MockProvider } from "./mock";
import { PayjpProvider } from "./payjp";
import type { PaymentProvider, ProviderId } from "./types";

const instances = new Map<ProviderId, PaymentProvider>();

/** 指定IDのプロバイダ（Webhook受信時など） */
export function getProvider(id: ProviderId): PaymentProvider {
  const existing = instances.get(id);
  if (existing) return existing;
  const e = env();
  let p: PaymentProvider;
  if (id === "payjp") {
    if (!e.PAYJP_SECRET_KEY || !e.PAYJP_PUBLIC_KEY || !e.PAYJP_WEBHOOK_TOKEN) throw new Error("PAY.JP is not configured");
    p = new PayjpProvider(e.PAYJP_SECRET_KEY, e.PAYJP_PUBLIC_KEY, e.PAYJP_WEBHOOK_TOKEN);
  } else {
    if (e.PAYMENT_PROVIDER !== "mock") throw new Error("mock provider is disabled");
    p = new MockProvider(e.MOCK_WEBHOOK_SECRET!, e.APP_URL);
  }
  instances.set(id, p);
  return p;
}

/** 現在の新規決済に使うプロバイダ */
export function activeProvider(): PaymentProvider {
  return getProvider(env().PAYMENT_PROVIDER);
}

export function isProviderId(v: string): v is ProviderId {
  return v === "payjp" || v === "mock";
}
