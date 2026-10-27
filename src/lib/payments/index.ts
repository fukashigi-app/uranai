import "server-only";
import { env } from "@/lib/env";
import { MockProvider } from "./mock";
import type { PaymentProvider, ProviderId } from "./types";

const instances = new Map<ProviderId, PaymentProvider>();

/** 決済を受け付けられない（疑似決済が無効。実際の決済は Stripe Checkout で、この仕組みは使わない） */
export class PaymentUnavailableError extends Error {
  constructor() {
    super("payment provider is not configured");
  }
}

/** 指定IDのプロバイダ（Webhook受信時など） */
export function getProvider(id: ProviderId): PaymentProvider {
  const e = env();
  // 自動テスト用の疑似決済（PAYMENT_PROVIDER=mock）だけ。Vercel の本番では常に使えない（env.ts）。毎回確かめる
  if (id !== "mock" || e.PAYMENT_PROVIDER !== "mock") throw new PaymentUnavailableError();
  const existing = instances.get(id);
  if (existing) return existing;
  const p: PaymentProvider = new MockProvider(e.MOCK_WEBHOOK_SECRET, e.APP_URL);
  instances.set(id, p);
  return p;
}

/** 疑似決済のプロバイダ（自動テスト専用） */
export function activeProvider(): PaymentProvider {
  const id = env().PAYMENT_PROVIDER;
  if (!id) throw new PaymentUnavailableError();
  return getProvider(id);
}

/** 疑似決済の記録か（過去の "payjp" の記録は false。外部の API に問い合わせない） */
export function isProviderId(v: string): v is ProviderId {
  return v === "mock";
}
