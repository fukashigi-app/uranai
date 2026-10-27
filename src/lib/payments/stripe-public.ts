/**
 * 一般のお客さん（ログイン不要）に Stripe Checkout の決済を受け付けてよいか（純粋な判定。単体テスト用に分けている）。
 *
 * 次のすべてを満たすときだけ受け付ける。1つでも欠けたら受け付けない（安全側）。
 *  - PAYMENT_PROVIDER=stripe を明示している（疑似決済とは併用しない）
 *  - 公開中（SITE_STATUS=open）で、危険な設定が無い（開発モード・準備中では一般の方の決済を受け付けない）
 *  - 無料テスト（ENABLE_TEST_PAYMENT=true）が有効ではない（無料か有料か曖昧にしない）
 *  - Stripe との接続が使える。今はテスト（Sandbox）だけ（stripeRuntime）。本番決済は未実装のため、本番では常に受け付けない
 *  - Firestore を使っている・安全な SESSION_SECRET がある
 * 運営アカウントだけの Stripe のテスト決済（/fortune?pay=stripe-test）は別の判定（stripeTestAccess）で、これとは独立している。
 */
import type { ServiceStopReason } from "@/lib/env";
import type { StripeMode } from "./stripe-checkout";

export type StripePublicDenyReason = "provider_not_stripe" | "service_stopped" | "free_test_enabled" | "stripe_unavailable" | "not_firestore" | "weak_secret";

export type StripePublicDecision = { ok: true; mode: StripeMode } | { ok: false; reason: StripePublicDenyReason };

export function stripePublicDecision(input: {
  paymentProvider: string | undefined;
  stop: ServiceStopReason | null;
  freeTestEnabled: boolean;
  /** 使える Stripe との接続のモード。使えなければ null */
  runtimeMode: StripeMode | null;
  firestore: boolean;
  strongSecret: boolean;
}): StripePublicDecision {
  if ((input.paymentProvider ?? "").trim() !== "stripe") return { ok: false, reason: "provider_not_stripe" };
  if (input.stop) return { ok: false, reason: "service_stopped" };
  if (input.freeTestEnabled) return { ok: false, reason: "free_test_enabled" };
  if (!input.runtimeMode) return { ok: false, reason: "stripe_unavailable" };
  if (!input.firestore) return { ok: false, reason: "not_firestore" };
  if (!input.strongSecret) return { ok: false, reason: "weak_secret" };
  return { ok: true, mode: input.runtimeMode };
}
