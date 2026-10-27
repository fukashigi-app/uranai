import "server-only";
import { cache } from "react";
import { isFirestore } from "@/lib/data-provider";
import { isSessionSecretStrong, isTestPaymentConfigured, serviceStopReason } from "@/lib/env";
import type { SessionUser } from "@/lib/auth/session";
import { stripeTestConfig, type StripeTestDenyReason } from "./stripe-guard";
import { stripeRuntime, type StripeMode } from "./stripe-checkout";
import { stripePublicDecision, type StripePublicDecision } from "./stripe-public";

/**
 * Stripe のテスト決済を使ってよい利用者か（毎回サーバー側で確認する）。
 *  - テスト決済の設定がそろっている（stripe-guard.ts。欠けていたら使えない）
 *  - Firestore を使っている（決済記録の作成は Firestore 版だけ）・安全な SESSION_SECRET がある
 *  - 運営アカウント（OPERATOR）でログイン中（一般の方・店舗アカウントは使えない）
 */
export type StripeTestAccess = { ok: true; user: SessionUser } | { ok: false; reason: StripeTestDenyReason | "not_firestore" | "weak_secret" | "not_logged_in" | "not_operator" | "unavailable" };

export const stripeTestAccess = cache(async (): Promise<StripeTestAccess> => {
  const cfg = stripeTestConfig();
  if (!cfg.ok) return { ok: false, reason: cfg.reason };
  if (!isFirestore()) return { ok: false, reason: "not_firestore" };
  if (!isSessionSecretStrong()) return { ok: false, reason: "weak_secret" };
  try {
    // auth/session は next/navigation に依存するため、使うときだけ読み込む
    const { getSessionUser } = await import("@/lib/auth/session");
    const user = await getSessionUser();
    if (!user) return { ok: false, reason: "not_logged_in" };
    if (user.role !== "OPERATOR") return { ok: false, reason: "not_operator" };
    return { ok: true, user };
  } catch (e) {
    console.error("[stripe] access check failed", (e as Error).name);
    return { ok: false, reason: "unavailable" };
  }
});

/**
 * 一般のお客さん（ログイン不要）の Stripe Checkout の決済を受け付けるか（判定は stripe-public.ts）。
 * Stripe との接続は stripeRuntime()（今はテスト＝Sandbox だけ）。本番では使えないため受け付けない。
 */
export const stripePublicCheckoutAccess = cache((): StripePublicDecision => {
  let runtimeMode: StripeMode | null = null;
  try {
    runtimeMode = stripeRuntime().mode;
  } catch {
    runtimeMode = null;
  }
  return stripePublicDecision({
    paymentProvider: process.env.PAYMENT_PROVIDER,
    stop: serviceStopReason(),
    freeTestEnabled: isTestPaymentConfigured(),
    runtimeMode,
    firestore: isFirestore(),
    strongSecret: isSessionSecretStrong(),
  });
});

/**
 * この利用者の注文を Stripe Checkout で受け付けるか（運営アカウントのテスト決済、または一般のお客さんの決済）。
 *  - operator_test … 運営アカウントだけのテスト決済（stripeTestAccess。開発モード・準備中でも使える）
 *  - public        … 一般のお客さん（stripePublicCheckoutAccess。公開中で PAYMENT_PROVIDER=stripe のときだけ）
 * どちらも使えなければ ok: false（ほかの決済へ自動で切り替えない）。
 */
export type StripeCheckoutAccess = { ok: true; audience: "operator_test" | "public"; mode: StripeMode } | { ok: false };

export const stripeCheckoutAccess = cache(async (): Promise<StripeCheckoutAccess> => {
  if ((await stripeTestAccess()).ok) return { ok: true, audience: "operator_test", mode: "test" };
  const pub = stripePublicCheckoutAccess();
  if (pub.ok) return { ok: true, audience: "public", mode: pub.mode };
  return { ok: false };
});

/** PAYMENT_PROVIDER=stripe を選んでいるか（疑似決済などへは切り替えない） */
export function isStripeProviderSelected(): boolean {
  return (process.env.PAYMENT_PROVIDER ?? "").trim() === "stripe";
}
