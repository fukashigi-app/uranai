import "server-only";
import { cache } from "react";
import { isFirestore } from "@/lib/data-provider";
import { isSessionSecretStrong } from "@/lib/env";
import type { SessionUser } from "@/lib/auth/session";
import { stripeTestConfig, type StripeTestDenyReason } from "./stripe-guard";

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
