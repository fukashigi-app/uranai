/**
 * Stripe の決済を使ってよい環境か（環境変数だけで判定する。値は返さない・表示しない）。
 *
 * 実行環境でモードが決まり、設定からは選べない：
 *  - Vercel の Preview・ローカルの自動テスト … テスト（Sandbox）だけ。stripeTestConfig
 *  - Vercel の Production                     … 本番（Live）だけ。stripeLiveConfig
 *  - それ以外（Vercel の Development など）    … どちらも使えない
 * stripeConfig はこの振り分けをまとめたもの。キー・スイッチ・Firebase の接続先が環境と合わなければ、決済を受け付けない。
 *
 * 本番（Live）の判定は用意しただけで、まだどこからも使っていない（本番決済は未実装・無効）。
 * 決済の処理（stripe-checkout.ts・Webhook など）は stripeTestConfig だけを見るので、本番では今までどおり使えない。
 *
 * ---- テスト（Sandbox）----
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
import { isDevModeLiveKeyConflict, livePaymentKeyNames, siteStatus } from "@/lib/env-rules";

type Env = Record<string, string | undefined>;

/** 本番の Firebase プロジェクト（テスト決済では絶対に使わない。本番決済ではこれだけを使う） */
export const PRODUCTION_FIREBASE_PROJECT_IDS = ["uranai-b6edf"] as const;
export const PRODUCTION_FIREBASE_PROJECT_ID = PRODUCTION_FIREBASE_PROJECT_IDS[0];
/** Preview のテスト決済で使ってよい Firebase プロジェクト（これ以外は拒否） */
export const PREVIEW_FIREBASE_PROJECT_ID = "uranai-preview";

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
  | "api_base_not_allowed"
  | "preview_project_mismatch"
  | "live_flag_in_test";

/** 本番（Live）の判定で拒否する理由（テストの理由と同じものは共有する） */
export type StripeLiveDenyReason =
  | "not_production"
  | "not_enabled"
  | "test_flag_in_production"
  | "api_base_not_allowed"
  | "unsupported_environment"
  | "production_project_mismatch"
  | "secret_key_missing"
  | "secret_key_not_live"
  | "webhook_secret_missing"
  | "test_key_present"
  | "dangerous_config"
  | "live_not_open";

/**
 * 本番決済を誰に出すか（将来の段階的な公開のため。今はどこからも使っていない）。
 *  operator … 開発モード（SITE_STATUS=development）のまま、運営アカウントだけが本番決済を試す（STRIPE_LIVE_OPERATOR_TEST=on が必要）
 *  public   … 公開中（SITE_STATUS=open）。一般のお客さん
 */
export type StripeLiveAudience = "operator" | "public";

export type StripeLiveConfig =
  | { ok: true; mode: "live"; audience: StripeLiveAudience; secretKey: string; webhookSecret: string }
  | { ok: false; reason: StripeLiveDenyReason };

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
    // Preview のテスト決済は uranai-preview だけ（テスト用の値の登録ミスで、別のプロジェクトに書き込まないように）
    if (target !== PREVIEW_FIREBASE_PROJECT_ID) return { ok: false, reason: "preview_project_mismatch" };
    if (e.FIRESTORE_EMULATOR_HOST) return { ok: false, reason: "unsupported_environment" };
  } else if (!e.VERCEL_ENV && isLocalEmulator(e) && target.startsWith("demo-")) {
    mode = "local";
  } else {
    return { ok: false, reason: "unsupported_environment" };
  }
  if (!checkFirestoreTarget(e).ok) return { ok: false, reason: "firestore_target_blocked" };
  // 本番決済のスイッチがテストの環境にある（登録先の取り違え）
  if (norm(e.STRIPE_LIVE_CHECKOUT) || norm(e.STRIPE_LIVE_OPERATOR_TEST)) return { ok: false, reason: "live_flag_in_test" };

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

const TEST_KEY_RE = /^(sk|pk|rk)_test_/;

/**
 * ---- 本番（Live）----（判定だけ。まだどこからも使っていない）
 * 次のすべてを満たすときだけ有効。1つでも欠けたら決済を受け付けない（安全側）。
 *  - Vercel の Production（VERCEL_ENV=production）
 *  - STRIPE_LIVE_CHECKOUT=on を明示している。テストのスイッチ（STRIPE_TEST_CHECKOUT）・接続先の差し替え（STRIPE_API_BASE）・Emulator が無い
 *  - Firebase の接続先が本番（FIREBASE_PROJECT_ID と PRODUCTION_FIREBASE_PROJECT_ID がどちらも uranai-b6edf）
 *  - STRIPE_SECRET_KEY が sk_live_、STRIPE_WEBHOOK_SECRET が whsec_ で始まる。テスト用のキー（sk_/pk_/rk_test_）が1つも無い
 *  - 疑似決済・無料テストの設定が無い
 *  - 公開中（SITE_STATUS=open → 一般のお客さん）、または開発モードで STRIPE_LIVE_OPERATOR_TEST=on（運営だけ）
 *    ※ 開発モードで本番用キーを登録すると、今は env-rules.ts の isDevModeLiveKeyConflict で受付全体を止める。
 *      運営だけの本番決済テストを実装するときに、STRIPE_LIVE_OPERATOR_TEST=on の場合の扱いをそこで合わせる
 */
export function stripeLiveConfig(e: Env = process.env): StripeLiveConfig {
  if (e.VERCEL_ENV !== "production") return { ok: false, reason: "not_production" };
  if (norm(e.STRIPE_LIVE_CHECKOUT) !== "on") return { ok: false, reason: "not_enabled" };
  if (norm(e.STRIPE_TEST_CHECKOUT)) return { ok: false, reason: "test_flag_in_production" };
  if ((e.STRIPE_API_BASE ?? "").trim()) return { ok: false, reason: "api_base_not_allowed" };
  if (e.FIRESTORE_EMULATOR_HOST) return { ok: false, reason: "unsupported_environment" };
  if (norm(e.FIREBASE_PROJECT_ID) !== PRODUCTION_FIREBASE_PROJECT_ID || norm(e.PRODUCTION_FIREBASE_PROJECT_ID) !== PRODUCTION_FIREBASE_PROJECT_ID) {
    return { ok: false, reason: "production_project_mismatch" };
  }
  const secretKey = (e.STRIPE_SECRET_KEY ?? "").trim();
  if (!secretKey) return { ok: false, reason: "secret_key_missing" };
  if (!secretKey.startsWith("sk_live_")) return { ok: false, reason: "secret_key_not_live" };
  const webhookSecret = (e.STRIPE_WEBHOOK_SECRET ?? "").trim();
  if (!webhookSecret.startsWith("whsec_")) return { ok: false, reason: "webhook_secret_missing" };
  if (["STRIPE_PUBLISHABLE_KEY", "NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY", "STRIPE_RESTRICTED_KEY"].some((k) => TEST_KEY_RE.test((e[k] ?? "").trim()))) {
    return { ok: false, reason: "test_key_present" };
  }
  if (e.PAYMENT_PROVIDER === "mock" || e.ALLOW_MOCK_PAYMENTS_IN_PRODUCTION === "true" || norm(e.ENABLE_TEST_PAYMENT) === "true") return { ok: false, reason: "dangerous_config" };
  const site = siteStatus(e);
  const audience: StripeLiveAudience | null =
    site.status === "open" && !site.unknown ? "public" : site.status === "development" && norm(e.STRIPE_LIVE_OPERATOR_TEST) === "on" ? "operator" : null;
  if (!audience) return { ok: false, reason: "live_not_open" };
  return { ok: true, mode: "live", audience, secretKey, webhookSecret };
}

export type StripeConfig =
  | { ok: true; mode: "test"; runtime: "preview" | "local"; secretKey: string; webhookSecret: string; apiBase: { host: string; port: number; protocol: "http" | "https" } | null }
  | Extract<StripeLiveConfig, { ok: true }>
  | { ok: false; mode: "test" | "live" | "none"; reason: StripeTestDenyReason | StripeLiveDenyReason };

/**
 * 実行環境に合ったモードの判定（Production → 本番だけ、Preview・ローカル → テストだけ、それ以外 → 使えない）。
 * 本番決済を実装するときは、決済の処理をこの関数に切り替える（今は stripeTestConfig だけを使っている）。
 */
export function stripeConfig(e: Env = process.env): StripeConfig {
  if (e.VERCEL_ENV === "production") {
    const live = stripeLiveConfig(e);
    return live.ok ? live : { ok: false, mode: "live", reason: live.reason };
  }
  if (e.VERCEL_ENV && e.VERCEL_ENV !== "preview") return { ok: false, mode: "none", reason: "unsupported_environment" };
  const test = stripeTestConfig(e);
  return test.ok
    ? { ok: true, mode: "test", runtime: test.mode, secretKey: test.secretKey, webhookSecret: test.webhookSecret, apiBase: test.apiBase }
    : { ok: false, mode: "test", reason: test.reason };
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
  preview_project_mismatch: "Preview のテスト決済は Firebase の uranai-preview だけで使えます",
  live_flag_in_test: "本番決済のスイッチ（STRIPE_LIVE_CHECKOUT・STRIPE_LIVE_OPERATOR_TEST）がテストの環境にあります",
};

/** 本番（Live）の判定の表示・ログ用（値は含めない） */
export const STRIPE_LIVE_DENY_MESSAGE: Record<StripeLiveDenyReason, string> = {
  not_production: "本番決済は Vercel の Production でだけ使えます",
  not_enabled: "STRIPE_LIVE_CHECKOUT=on が設定されていません",
  test_flag_in_production: "テスト決済のスイッチ（STRIPE_TEST_CHECKOUT）が本番にあります",
  api_base_not_allowed: "STRIPE_API_BASE（ローカルの自動テスト用）が本番にあります",
  unsupported_environment: "本番で Firestore Emulator の設定があります",
  production_project_mismatch: "Firebase の接続先が本番のプロジェクト（uranai-b6edf）ではありません",
  secret_key_missing: "STRIPE_SECRET_KEY が設定されていません",
  secret_key_not_live: "STRIPE_SECRET_KEY が本番用キー（sk_live_）ではありません",
  webhook_secret_missing: "STRIPE_WEBHOOK_SECRET（whsec_）が設定されていません",
  test_key_present: "本番にテスト用の Stripe のキーがあります",
  dangerous_config: "疑似決済・無料テストの設定が残っています",
  live_not_open: "公開中（SITE_STATUS=open）ではなく、運営だけの本番決済テスト（STRIPE_LIVE_OPERATOR_TEST=on）も有効ではありません",
};
