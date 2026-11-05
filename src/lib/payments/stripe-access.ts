import "server-only";
import { cache } from "react";
import { isFirestore } from "@/lib/data-provider";
import { isSessionSecretStrong, isTestPaymentConfigured, serviceStopReason } from "@/lib/env";
import type { SessionUser } from "@/lib/auth/session";
import { stripeConfig, stripeLiveConfig, stripeTestConfig, type StripeLiveDenyReason, type StripeNewCheckoutDenyReason, type StripeTestDenyReason } from "./stripe-guard";
import { acceptsNewCheckout, stripeRuntime, type StripeMode } from "./stripe-checkout";
import { stripePublicDecision, type StripePublicDecision } from "./stripe-public";

/**
 * Stripe のテスト決済を使ってよい利用者か（毎回サーバー側で確認する）。
 *  - テスト決済の設定がそろっている（stripe-guard.ts。欠けていたら使えない）
 *  - 新規の決済を受け付けている（STRIPE_NEW_CHECKOUT=on。止めていれば新しい決済は作らない）
 *  - Firestore を使っている（決済記録の作成は Firestore 版だけ）・安全な SESSION_SECRET がある
 *  - 運営アカウント（OPERATOR）でログイン中（一般の方・店舗アカウントは使えない）
 */
export type StripeTestAccess = { ok: true; user: SessionUser } | { ok: false; reason: StripeTestDenyReason | StripeNewCheckoutDenyReason | "not_firestore" | "weak_secret" | "not_logged_in" | "not_operator" | "unavailable" };

export const stripeTestAccess = cache(async (): Promise<StripeTestAccess> => {
  const cfg = stripeTestConfig();
  if (!cfg.ok) return { ok: false, reason: cfg.reason };
  if (!cfg.newCheckout.ok) return { ok: false, reason: cfg.newCheckout.reason };
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
 * 運営アカウントだけの本番決済テスト（Production・開発モード・STRIPE_LIVE_OPERATOR_TEST=on・本番の条件がすべてそろっている）を使ってよい利用者か。
 * 実際に請求される本番の決済（livemode=true）なので、売上・精算に数える。確認が終わったら返金する（返金した決済は売上・精算から外れる）。
 *  - 本番の条件（stripe-guard.ts の stripeLiveConfig）で、受け付ける相手が operator（運営だけ）
 *  - Firestore・安全な SESSION_SECRET・運営アカウント（OPERATOR）でログイン中（一般の方・店舗アカウントは使えない）
 */
export type StripeLiveOperatorAccess =
  | { ok: true; user: SessionUser }
  | { ok: false; reason: StripeLiveDenyReason | StripeNewCheckoutDenyReason | "not_operator_audience" | "not_firestore" | "weak_secret" | "not_logged_in" | "not_operator" | "unavailable" };

export const stripeLiveOperatorAccess = cache(async (): Promise<StripeLiveOperatorAccess> => {
  const cfg = stripeLiveConfig();
  if (!cfg.ok) return { ok: false, reason: cfg.reason };
  // 新規の決済の受付を止めている（STRIPE_NEW_CHECKOUT・公開状態）：運営の本番決済テストも新しくは作らない
  if (!cfg.newCheckout.ok) return { ok: false, reason: cfg.newCheckout.reason };
  if (cfg.audience !== "operator") return { ok: false, reason: "not_operator_audience" };
  if (!isFirestore()) return { ok: false, reason: "not_firestore" };
  if (!isSessionSecretStrong()) return { ok: false, reason: "weak_secret" };
  try {
    const { getSessionUser } = await import("@/lib/auth/session");
    const user = await getSessionUser();
    if (!user) return { ok: false, reason: "not_logged_in" };
    if (user.role !== "OPERATOR") return { ok: false, reason: "not_operator" };
    return { ok: true, user };
  } catch (e) {
    console.error("[stripe] live operator access check failed", (e as Error).name);
    return { ok: false, reason: "unavailable" };
  }
});

/**
 * 運営アカウントだけの Stripe の決済（/fortune?pay=stripe-test の入口）を使ってよいか。
 *  - Preview・ローカル … Sandbox のテスト決済（stripeTestAccess）
 *  - Production         … 運営だけの本番決済テスト（stripeLiveOperatorAccess）。実際に請求される
 */
export type StripeOperatorAccess = { ok: true; user: SessionUser; mode: StripeMode } | { ok: false };

export const stripeOperatorAccess = cache(async (): Promise<StripeOperatorAccess> => {
  const t = await stripeTestAccess();
  if (t.ok) return { ok: true, user: t.user, mode: "test" };
  const l = await stripeLiveOperatorAccess();
  if (l.ok) return { ok: true, user: l.user, mode: "live" };
  return { ok: false };
});

/**
 * 一般のお客さん（ログイン不要）の Stripe Checkout の決済を受け付けるか（判定は stripe-public.ts）。
 * Stripe との接続は stripeRuntime()（Preview はテスト、Production は本番）。本番の接続は、受け付ける相手が一般（public。公開中）のときだけ使う
 * （運営だけの本番決済テストの設定では、一般の方の決済を受け付けない）。
 */
export const stripePublicCheckoutAccess = cache((): StripePublicDecision => {
  let runtimeMode: StripeMode | null = null;
  let newCheckoutStopped = false;
  try {
    const rt = stripeRuntime();
    if (!acceptsNewCheckout(rt)) newCheckoutStopped = true;
    // 本番の接続は、一般のお客さんを受け付ける設定（公開中）のときだけ。運営だけの本番決済テストでは使わない
    else runtimeMode = rt.mode === "live" && rt.liveAudience !== "public" ? null : rt.mode;
  } catch {
    runtimeMode = null;
  }
  return stripePublicDecision({
    paymentProvider: process.env.PAYMENT_PROVIDER,
    stop: serviceStopReason(),
    freeTestEnabled: isTestPaymentConfigured(),
    runtimeMode,
    newCheckoutStopped,
    firestore: isFirestore(),
    strongSecret: isSessionSecretStrong(),
  });
});

/**
 * この利用者の注文を Stripe Checkout で受け付けるか（運営アカウントのテスト決済、または一般のお客さんの決済）。
 *  - operator_test … 運営アカウントだけの決済（stripeOperatorAccess。Preview は Sandbox のテスト決済で開発モード・準備中でも使える。
 *                    Production は開発モードの本番決済テスト（実際に請求される。mode=live））
 *  - public        … 一般のお客さん（stripePublicCheckoutAccess。公開中で PAYMENT_PROVIDER=stripe のときだけ）
 * どちらも使えなければ ok: false（ほかの決済へ自動で切り替えない）。
 */
export type StripeCheckoutAccess = { ok: true; audience: "operator_test" | "public"; mode: StripeMode } | { ok: false };

export const stripeCheckoutAccess = cache(async (): Promise<StripeCheckoutAccess> => {
  const op = await stripeOperatorAccess();
  if (op.ok) return { ok: true, audience: "operator_test", mode: op.mode };
  const pub = stripePublicCheckoutAccess();
  if (pub.ok) return { ok: true, audience: "public", mode: pub.mode };
  return { ok: false };
});

/**
 * 新規の決済の受付の状態（画面・API の案内と /api/health 用。値は返さない）。
 *  connection … Stripe との接続（Webhook・定期処理・運営の操作に使う）があるか
 *  accepting  … 新規の決済（Checkout Session の作成）を受け付ける設定か（誰に受け付けるかは別に判定する）
 *  reason     … 受け付けない理由（接続があって受け付けないときだけ）
 */
export type StripeNewCheckoutState = { connection: false } | { connection: true; mode: StripeMode; accepting: true } | { connection: true; mode: StripeMode; accepting: false; reason: StripeNewCheckoutDenyReason };

export function stripeNewCheckoutState(): StripeNewCheckoutState {
  const cfg = stripeConfig();
  if (!cfg.ok) return { connection: false };
  return cfg.newCheckout.ok ? { connection: true, mode: cfg.mode, accepting: true } : { connection: true, mode: cfg.mode, accepting: false, reason: cfg.newCheckout.reason };
}

/** 運営が新規の決済の受付を止めている（STRIPE_NEW_CHECKOUT=off・未設定・不正な値）。接続はあり、既存の決済の処理は続いている */
export function isStripeNewCheckoutPaused(): boolean {
  const st = stripeNewCheckoutState();
  return st.connection && !st.accepting && (st.reason === "new_checkout_off" || st.reason === "new_checkout_not_set" || st.reason === "new_checkout_invalid");
}

/** PAYMENT_PROVIDER=stripe を選んでいるか（疑似決済などへは切り替えない） */
export function isStripeProviderSelected(): boolean {
  return (process.env.PAYMENT_PROVIDER ?? "").trim() === "stripe";
}
