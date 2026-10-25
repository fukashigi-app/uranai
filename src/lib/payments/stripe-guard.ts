/**
 * Stripe Checkout のテスト決済を使ってよい環境か（環境変数だけで判定する。値は返さない・表示しない）。
 *
 * 次のすべてを満たすときだけ有効。1つでも欠けたら決済を受け付けない（安全側）。
 *  - STRIPE_TEST_CHECKOUT=on を明示している
 *  - Vercel の本番（VERCEL_ENV=production）ではない
 *  - 実行場所が次のどちらか
 *      preview … Vercel の Preview。FIREBASE_PROJECT_ID が STRIPE_TEST_FIREBASE_PROJECT_ID（テスト用プロジェクト）と一致し、
 *                PRODUCTION_FIREBASE_PROJECT_ID・本番のプロジェクトID とは異なる
 *      local   … ローカルの自動テスト。Firestore Emulator（localhost）の demo- プロジェクトだけ
 *  - STRIPE_SECRET_KEY が sk_test_、STRIPE_WEBHOOK_SECRET が whsec_ で始まる（本番用キー sk_live_ / rk_live_ は不可）
 *  - 危険な設定（本番の ENABLE_TEST_PAYMENT・mock、開発モードでの本番用決済キー）が無い
 * 利用できるのは運営アカウントだけ（stripe-access.ts で毎回確認する）。
 * next.config やスクリプト・テストからも読み込めるよう、server-only に依存しない。
 */
import { checkFirestoreTarget } from "@/lib/firestore/target-guard";
import { isDevModeLiveKeyConflict, livePaymentKeyNames } from "@/lib/env-rules";

type Env = Record<string, string | undefined>;

/** 本番の Firebase プロジェクト（テスト決済では絶対に使わない） */
export const PRODUCTION_FIREBASE_PROJECT_IDS = ["uranai-b6edf"] as const;

export type StripeTestDenyReason =
  | "not_enabled"
  | "production"
  | "unsupported_environment"
  | "secret_key_missing"
  | "secret_key_not_test"
  | "webhook_secret_missing"
  | "live_key_present"
  | "dangerous_config"
  | "firestore_target_blocked"
  | "test_project_not_set"
  | "test_project_mismatch"
  | "production_project"
  | "api_base_not_allowed";

export type StripeTestConfig =
  | { ok: true; mode: "preview" | "local"; secretKey: string; webhookSecret: string; apiBase: { host: string; port: number; protocol: "http" | "https" } | null }
  | { ok: false; reason: StripeTestDenyReason };

const norm = (v: string | undefined) => (v ?? "").trim().toLowerCase();
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

function isLocalEmulator(e: Env): boolean {
  const host = (e.FIRESTORE_EMULATOR_HOST ?? "").trim();
  if (!host) return false;
  try {
    return LOCAL_HOSTS.has(new URL(`http://${host}`).hostname);
  } catch {
    return false;
  }
}

export function stripeTestConfig(e: Env = process.env): StripeTestConfig {
  if (norm(e.STRIPE_TEST_CHECKOUT) !== "on") return { ok: false, reason: "not_enabled" };
  if (e.VERCEL_ENV === "production") return { ok: false, reason: "production" };

  const target = norm(e.FIREBASE_PROJECT_ID);
  if ((PRODUCTION_FIREBASE_PROJECT_IDS as readonly string[]).includes(target) || (norm(e.PRODUCTION_FIREBASE_PROJECT_ID) && target === norm(e.PRODUCTION_FIREBASE_PROJECT_ID))) {
    return { ok: false, reason: "production_project" };
  }

  let mode: "preview" | "local";
  if (e.VERCEL_ENV === "preview") {
    mode = "preview";
    const testProject = norm(e.STRIPE_TEST_FIREBASE_PROJECT_ID);
    if (!testProject) return { ok: false, reason: "test_project_not_set" };
    if (!target || target !== testProject) return { ok: false, reason: "test_project_mismatch" };
    if (e.FIRESTORE_EMULATOR_HOST) return { ok: false, reason: "unsupported_environment" };
  } else if (!e.VERCEL_ENV && isLocalEmulator(e) && target.startsWith("demo-")) {
    mode = "local";
  } else {
    return { ok: false, reason: "unsupported_environment" };
  }
  if (!checkFirestoreTarget(e).ok) return { ok: false, reason: "firestore_target_blocked" };

  const secretKey = (e.STRIPE_SECRET_KEY ?? "").trim();
  if (!secretKey) return { ok: false, reason: "secret_key_missing" };
  if (!secretKey.startsWith("sk_test_")) return { ok: false, reason: "secret_key_not_test" };
  const webhookSecret = (e.STRIPE_WEBHOOK_SECRET ?? "").trim();
  if (!webhookSecret.startsWith("whsec_")) return { ok: false, reason: "webhook_secret_missing" };
  // 本番用の決済キーが1つでもあれば使わない（STRIPE_SECRET_KEY 以外の変数も含む）
  if (livePaymentKeyNames(e).length > 0) return { ok: false, reason: "live_key_present" };
  if (isDevModeLiveKeyConflict(e)) return { ok: false, reason: "live_key_present" };
  // 疑似決済の設定とは併用しない（どちらの決済か曖昧にしない）
  if (e.PAYMENT_PROVIDER === "mock" || e.ALLOW_MOCK_PAYMENTS_IN_PRODUCTION === "true") return { ok: false, reason: "dangerous_config" };

  // Stripe API の接続先の差し替えは、ローカルの自動テスト（localhost の模擬サーバー）でだけ許可する
  let apiBase: { host: string; port: number; protocol: "http" | "https" } | null = null;
  const base = (e.STRIPE_API_BASE ?? "").trim();
  if (base) {
    if (mode !== "local") return { ok: false, reason: "api_base_not_allowed" };
    let u: URL;
    try {
      u = new URL(base);
    } catch {
      return { ok: false, reason: "api_base_not_allowed" };
    }
    if (!LOCAL_HOSTS.has(u.hostname) || !["http:", "https:"].includes(u.protocol)) return { ok: false, reason: "api_base_not_allowed" };
    apiBase = { host: u.hostname, port: Number(u.port || (u.protocol === "https:" ? 443 : 80)), protocol: u.protocol === "https:" ? "https" : "http" };
  }
  return { ok: true, mode, secretKey, webhookSecret, apiBase };
}

/** 表示・ログ用（値は含めない） */
export const STRIPE_TEST_DENY_MESSAGE: Record<StripeTestDenyReason, string> = {
  not_enabled: "STRIPE_TEST_CHECKOUT=on が設定されていません",
  production: "本番環境ではテスト決済を使えません",
  unsupported_environment: "Preview またはローカルの Emulator（demo- プロジェクト）以外では使えません",
  secret_key_missing: "STRIPE_SECRET_KEY が設定されていません",
  secret_key_not_test: "STRIPE_SECRET_KEY がテスト用キー（sk_test_）ではありません",
  webhook_secret_missing: "STRIPE_WEBHOOK_SECRET（whsec_）が設定されていません",
  live_key_present: "本番用の決済キーが設定されています",
  dangerous_config: "危険な設定が残っています",
  firestore_target_blocked: "Firestore の接続先の安全確認に失敗しました",
  test_project_not_set: "STRIPE_TEST_FIREBASE_PROJECT_ID が設定されていません",
  test_project_mismatch: "Firebase の接続先がテスト用プロジェクトと一致しません",
  production_project: "本番の Firebase プロジェクトに接続する設定です",
  api_base_not_allowed: "STRIPE_API_BASE はローカルの自動テストでだけ使えます",
};
