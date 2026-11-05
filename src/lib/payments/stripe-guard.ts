/**
 * Stripe の決済を使ってよい環境か（環境変数だけで判定する。値は返さない・表示しない）。
 *
 * 実行環境でモードが決まり、設定からは選べない：
 *  - Vercel の Preview・ローカルの自動テスト … テスト（Sandbox）だけ。stripeTestConfig
 *  - Vercel の Production                     … 本番（Live）だけ。stripeLiveConfig
 *  - それ以外（Vercel の Development など）    … どちらも使えない
 * stripeConfig はこの振り分けをまとめたもの。キー・スイッチ・Firebase の接続先が環境と合わなければ、決済を受け付けない。
 *
 * 決済の処理（stripe-checkout.ts の stripeRuntime・Webhook・定期処理・運営画面）は stripeConfig で接続を決める
 * （Production では本番の条件がすべてそろったときだけ本番の接続。そろわなければ決済を受け付けない）。
 *
 * ---- テスト（Sandbox）----
 *
 * 次のすべてを満たすときだけ有効。1つでも欠けたら決済を受け付けない（安全側）。
 *  - STRIPE_TEST_CHECKOUT=on を明示している
 *  - Vercel の本番（VERCEL_ENV=production）ではない
 *  - 実行場所が次のどちらか
 *      preview … Vercel の Preview。FIREBASE_PROJECT_ID が STRIPE_TEST_FIREBASE_PROJECT_ID（テスト用プロジェクト）と一致し、
 *                Preview 用のプロジェクト（uranai-preview）であり、PRODUCTION_FIREBASE_PROJECT_ID・本番のプロジェクトID とは異なる。
 *                Firestore Emulator・STRIPE_API_BASE は使えない
 *      local   … ローカルの自動テスト。Firestore Emulator（localhost）の demo- プロジェクトだけ
 *  - STRIPE_SECRET_KEY が sk_test_、STRIPE_WEBHOOK_SECRET が whsec_ で始まる（本番用キー sk_live_ / rk_live_ は不可）
 *  - 危険な設定（本番の ENABLE_TEST_PAYMENT・mock、開発モードでの本番用決済キー）・本番決済のスイッチ（STRIPE_LIVE_*）が無い
 * これは「Stripe との接続（Sandbox）を使ってよい環境か」の判定だけ。誰が決済できるかは stripe-access.ts で毎回確認する：
 *  - 運営アカウントのテスト決済（/fortune?pay=stripe-test）… 運営アカウントでログイン中なら、開発モード・準備中でも使える
 *  - 一般のお客さん（ログイン不要）… 公開中（SITE_STATUS=open）・PAYMENT_PROVIDER=stripe・無料テストが無効のときだけ（stripe-public.ts）
 * どちらも Sandbox の決済（livemode=false）なので、売上・店舗の取り分・月次精算には含めない（payments/kind.ts）。
 * next.config やスクリプト・テストからも読み込めるよう、server-only に依存しない。
 */
import {
  checkFirestoreTarget,
  PREVIEW_FIREBASE_PROJECT_ID as PREVIEW_PROJECT,
  PREVIEW_FIREBASE_TARGETS,
  previewFirebaseTargetOf,
  PRODUCTION_FIREBASE_PROJECT_ID as PRODUCTION_PROJECT,
  type PreviewFirebaseTarget,
} from "@/lib/firestore/target-guard";
import { isDevModeLiveKeyConflict, livePaymentKeyNames, siteStatus } from "@/lib/env-rules";

type Env = Record<string, string | undefined>;

/** 本番の Firebase プロジェクト（テスト決済では絶対に使わない。本番決済ではこれだけを使う） */
export const PRODUCTION_FIREBASE_PROJECT_IDS = [PRODUCTION_PROJECT] as const;
export const PRODUCTION_FIREBASE_PROJECT_ID = PRODUCTION_FIREBASE_PROJECT_IDS[0];
/** Preview のテスト決済で使ってよい Firebase プロジェクト（これ以外は拒否。データベースの接続の判定と同じ値） */
export const PREVIEW_FIREBASE_PROJECT_ID = PREVIEW_PROJECT;

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
  | "live_flag_in_test"
  | "test_account_id_missing";

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
  | "account_id_missing";

/**
 * ---- 新規の決済（Checkout Session の作成）の受付 ----
 * Stripe との接続（鍵・Webhook の署名の秘密・アカウント・実行環境・Firebase の接続先）とは別に判定する。
 * 受付を止めても接続は残るので、すでに受けた決済の Webhook（決済確定・返金・異議申し立て）・定期処理・決済監視・再確認・運営の操作は続く。
 * 受付を止めるために鍵や Webhook の署名の秘密を消す必要はない（消すと接続ごと止まり、通知を取りこぼす）。
 *
 * スイッチは STRIPE_NEW_CHECKOUT。on のときだけ受け付ける（未設定・off・それ以外の値は受け付けない＝安全側）。
 */
export type StripeNewCheckoutDenyReason =
  /** STRIPE_NEW_CHECKOUT が未設定 */
  | "new_checkout_not_set"
  /** STRIPE_NEW_CHECKOUT=off（運営が受付を止めている） */
  | "new_checkout_off"
  /** STRIPE_NEW_CHECKOUT が on・off 以外の値（設定の誤り。安全のため止める） */
  | "new_checkout_invalid"
  /** 本番：公開中（SITE_STATUS=open）でも、運営だけの本番決済テスト（開発モード＋STRIPE_LIVE_OPERATOR_TEST=on）でもない */
  | "live_not_open"
  /** 本番：公開中なのに、運営だけの本番決済テストのスイッチ（STRIPE_LIVE_OPERATOR_TEST）が残っている（設定の誤り） */
  | "operator_test_while_open";

export type StripeNewCheckoutDecision = { ok: true } | { ok: false; reason: StripeNewCheckoutDenyReason };

/** STRIPE_NEW_CHECKOUT の値の判定（on のときだけ受け付ける） */
export function newCheckoutSwitch(e: Env = process.env): StripeNewCheckoutDecision {
  const v = norm(e.STRIPE_NEW_CHECKOUT);
  if (v === "on") return { ok: true };
  if (!v) return { ok: false, reason: "new_checkout_not_set" };
  if (v === "off") return { ok: false, reason: "new_checkout_off" };
  return { ok: false, reason: "new_checkout_invalid" };
}

/** 受付を止めている理由のうち、設定の誤り（運営の意図した停止ではない）か */
export function isNewCheckoutMisconfigured(reason: StripeNewCheckoutDenyReason): boolean {
  return reason === "new_checkout_invalid" || reason === "operator_test_while_open";
}

/**
 * 本番決済を誰に出すか（段階的な公開。stripe-access.ts で利用者を確かめる）。
 *  operator … 開発モード（SITE_STATUS=development）のまま、運営アカウントだけが本番決済を試す（STRIPE_LIVE_OPERATOR_TEST=on が必要）
 *  public   … 公開中（SITE_STATUS=open）。一般のお客さん
 */
export type StripeLiveAudience = "operator" | "public";

/**
 * 本番（Live）の Stripe との接続の判定。ok は「接続を作ってよい」（Webhook・定期処理・決済監視・再確認・運営の操作に使う）。
 * 新規の決済を受け付けるかは newCheckout（ok でも受け付けないことがある）。audience は受け付ける相手（受け付けないときは null）。
 */
export type StripeLiveConfig =
  | { ok: true; mode: "live"; audience: StripeLiveAudience | null; newCheckout: StripeNewCheckoutDecision; secretKey: string; webhookSecret: string; accountId: string }
  | { ok: false; reason: StripeLiveDenyReason };

export type StripeTestConfig =
  | {
      ok: true;
      mode: "preview" | "local";
      secretKey: string;
      webhookSecret: string;
      apiBase: { host: string; port: number; protocol: "http" | "https" } | null;
      /** キーの持ち主であるべき Stripe のアカウント（acct_）。設定されていれば Stripe API で確かめる（新しい検証環境では必須） */
      accountId?: string;
      /** 新規の決済（Checkout Session の作成）を受け付けるか（STRIPE_NEW_CHECKOUT）。接続の可否とは別 */
      newCheckout: StripeNewCheckoutDecision;
    }
  | { ok: false; reason: StripeTestDenyReason };

const norm = (v: string | undefined) => (v ?? "").trim().toLowerCase();
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

/** Firestore Emulator（localhost）に接続する設定か（ローカルの自動テストの判定に使う） */
export function isLocalEmulatorTarget(e: Env = process.env): boolean {
  return isLocalEmulator(e);
}

function isLocalEmulator(e: Env): boolean {
  const host = (e.FIRESTORE_EMULATOR_HOST ?? "").trim();
  if (!host) return false;
  try {
    return LOCAL_HOSTS.has(new URL(`http://${host}`).hostname);
  } catch {
    return false;
  }
}

export function stripeTestConfig(e: Env = process.env, targets: readonly PreviewFirebaseTarget[] = PREVIEW_FIREBASE_TARGETS): StripeTestConfig {
  if (norm(e.STRIPE_TEST_CHECKOUT) !== "on") return { ok: false, reason: "not_enabled" };
  if (e.VERCEL_ENV === "production") return { ok: false, reason: "production" };

  const target = norm(e.FIREBASE_PROJECT_ID);
  if ((PRODUCTION_FIREBASE_PROJECT_IDS as readonly string[]).includes(target) || (norm(e.PRODUCTION_FIREBASE_PROJECT_ID) && target === norm(e.PRODUCTION_FIREBASE_PROJECT_ID))) {
    return { ok: false, reason: "production_project" };
  }

  let mode: "preview" | "local";
  let previewTarget: PreviewFirebaseTarget | null = null;
  if (e.VERCEL_ENV === "preview") {
    mode = "preview";
    const testProject = norm(e.STRIPE_TEST_FIREBASE_PROJECT_ID);
    if (!testProject) return { ok: false, reason: "test_project_not_set" };
    if (!target || target !== testProject) return { ok: false, reason: "test_project_mismatch" };
    // Preview のテスト決済は、コードに固定した Preview 用のプロジェクトだけ（テスト用の値の登録ミスで、別のプロジェクトに書き込まないように）
    previewTarget = previewFirebaseTargetOf(e.FIREBASE_PROJECT_ID, targets);
    if (!previewTarget) return { ok: false, reason: "preview_project_mismatch" };
    if (e.FIRESTORE_EMULATOR_HOST) return { ok: false, reason: "unsupported_environment" };
  } else if (!e.VERCEL_ENV && isLocalEmulator(e) && target.startsWith("demo-")) {
    mode = "local";
  } else {
    return { ok: false, reason: "unsupported_environment" };
  }
  if (!checkFirestoreTarget(e, targets).ok) return { ok: false, reason: "firestore_target_blocked" };
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
  // キーの持ち主の Stripe のアカウント：新しい検証環境（requireStripeAccountId）では必須。それ以外でも、設定されていれば形を確かめて使う
  const accountRaw = (e.STRIPE_ACCOUNT_ID ?? "").trim();
  if (accountRaw && !STRIPE_ACCOUNT_ID_RE.test(accountRaw)) return { ok: false, reason: "test_account_id_missing" };
  if (previewTarget?.requireStripeAccountId && !accountRaw) return { ok: false, reason: "test_account_id_missing" };
  return { ok: true, mode, secretKey, webhookSecret, apiBase, ...(accountRaw ? { accountId: accountRaw } : {}), newCheckout: newCheckoutSwitch(e) };
}

const TEST_KEY_RE = /^(sk|pk|rk)_test_/;
/** Stripe のアカウントの ID（acct_ と英数字） */
export const STRIPE_ACCOUNT_ID_RE = /^acct_[A-Za-z0-9]{6,64}$/;

/**
 * ---- 本番（Live）----
 * 【接続】次のすべてを満たすときだけ、本番の Stripe との接続を作る。1つでも欠けたら接続を作らない（決済も Webhook も受け付けない。安全側）。
 *  - Vercel の Production（VERCEL_ENV=production）
 *  - STRIPE_LIVE_CHECKOUT=on を明示している。テストのスイッチ（STRIPE_TEST_CHECKOUT）・接続先の差し替え（STRIPE_API_BASE）・Emulator が無い
 *  - Firebase の接続先が本番（FIREBASE_PROJECT_ID と PRODUCTION_FIREBASE_PROJECT_ID がどちらも uranai-b6edf）
 *  - STRIPE_SECRET_KEY が sk_live_、STRIPE_WEBHOOK_SECRET が whsec_ で始まる。テスト用のキー（sk_/pk_/rk_test_）が1つも無い
 *  - STRIPE_ACCOUNT_ID（acct_。本番に使う Stripe のアカウント）が設定されている。キーがこのアカウントのものかは、
 *    決済画面の作成・Webhook の処理の前に Stripe API で確かめる（stripe-checkout.ts の ensureStripeAccount。別のアカウントのキーなら受け付けない）
 *  - 疑似決済・無料テストの設定が無い
 * 【新規の決済の受付】接続に加えて、次のすべてを満たすときだけ（newCheckout。満たさなくても接続は残り、既存の決済の処理は続く）
 *  - STRIPE_NEW_CHECKOUT=on
 *  - 公開中（SITE_STATUS=open → 一般のお客さん）、または開発モードで STRIPE_LIVE_OPERATOR_TEST=on（運営アカウントだけ。一般の方は開発モードなので決済できない）
 *    公開中に STRIPE_LIVE_OPERATOR_TEST が残っていたら、設定の誤りとして新規の決済を受け付けない（公開の前に削除する）
 *    開発モードで本番用キーがあるときは、STRIPE_LIVE_OPERATOR_TEST=on のときだけ受付を止めない（env-rules.ts の isDevModeLiveKeyConflict）。
 *    そのときに本番の条件がそろっていなければ、受付全体を止める（env.ts の isPaidFlowBlocked）
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
  const accountId = (e.STRIPE_ACCOUNT_ID ?? "").trim();
  if (!STRIPE_ACCOUNT_ID_RE.test(accountId)) return { ok: false, reason: "account_id_missing" };
  if (["STRIPE_PUBLISHABLE_KEY", "NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY", "STRIPE_RESTRICTED_KEY"].some((k) => TEST_KEY_RE.test((e[k] ?? "").trim()))) {
    return { ok: false, reason: "test_key_present" };
  }
  if (e.PAYMENT_PROVIDER === "mock" || e.ALLOW_MOCK_PAYMENTS_IN_PRODUCTION === "true" || norm(e.ENABLE_TEST_PAYMENT) === "true") return { ok: false, reason: "dangerous_config" };
  // ここまでで接続は作れる。以下は新規の決済の受付だけの判定（接続の可否には影響しない）
  const site = siteStatus(e);
  const operatorTestWhileOpen = site.status === "open" && !site.unknown && Boolean(norm(e.STRIPE_LIVE_OPERATOR_TEST));
  const audience: StripeLiveAudience | null = operatorTestWhileOpen
    ? null
    : site.status === "open" && !site.unknown
      ? "public"
      : site.status === "development" && norm(e.STRIPE_LIVE_OPERATOR_TEST) === "on"
        ? "operator"
        : null;
  const sw = newCheckoutSwitch(e);
  const newCheckout: StripeNewCheckoutDecision = operatorTestWhileOpen
    ? { ok: false, reason: "operator_test_while_open" }
    : !audience
      ? { ok: false, reason: "live_not_open" }
      : sw;
  return { ok: true, mode: "live", audience: newCheckout.ok ? audience : null, newCheckout, secretKey, webhookSecret, accountId };
}

export type StripeConfig =
  | {
      ok: true;
      mode: "test";
      runtime: "preview" | "local";
      secretKey: string;
      webhookSecret: string;
      apiBase: { host: string; port: number; protocol: "http" | "https" } | null;
      accountId?: string;
      newCheckout: StripeNewCheckoutDecision;
    }
  | Extract<StripeLiveConfig, { ok: true }>
  | { ok: false; mode: "test" | "live" | "none"; reason: StripeTestDenyReason | StripeLiveDenyReason };

/**
 * 実行環境に合ったモードの判定（Production → 本番だけ、Preview・ローカル → テストだけ、それ以外 → 使えない）。
 * 決済の処理が使う接続（stripe-checkout.ts の stripeRuntime）は、この関数で決める。
 * ok は接続の可否だけ。新規の決済を受け付けるかは newCheckout（受付を止めても、Webhook・定期処理・運営の操作は続く）。
 */
export function stripeConfig(e: Env = process.env): StripeConfig {
  if (e.VERCEL_ENV === "production") {
    const live = stripeLiveConfig(e);
    return live.ok ? live : { ok: false, mode: "live", reason: live.reason };
  }
  if (e.VERCEL_ENV && e.VERCEL_ENV !== "preview") return { ok: false, mode: "none", reason: "unsupported_environment" };
  const test = stripeTestConfig(e);
  return test.ok
    ? { ok: true, mode: "test", runtime: test.mode, secretKey: test.secretKey, webhookSecret: test.webhookSecret, apiBase: test.apiBase, ...(test.accountId ? { accountId: test.accountId } : {}), newCheckout: test.newCheckout }
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
  preview_project_mismatch: "Preview のテスト決済は、コードで許可した Preview 用の Firebase プロジェクトだけで使えます",
  test_account_id_missing: "この検証環境では STRIPE_ACCOUNT_ID（テストに使う Stripe のアカウントの acct_）が必要です。未設定か、形が正しくありません",
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
  account_id_missing: "STRIPE_ACCOUNT_ID（本番に使う Stripe のアカウントの acct_）が設定されていないか、形が正しくありません",
};

/** 新規の決済を受け付けない理由の表示・ログ用（値は含めない） */
export const STRIPE_NEW_CHECKOUT_DENY_MESSAGE: Record<StripeNewCheckoutDenyReason, string> = {
  new_checkout_not_set: "新規の決済の受付のスイッチ（STRIPE_NEW_CHECKOUT=on）が設定されていません",
  new_checkout_off: "新規の決済の受付を停止しています（STRIPE_NEW_CHECKOUT=off）",
  new_checkout_invalid: "STRIPE_NEW_CHECKOUT が on・off 以外の値です。安全のため新規の決済の受付を停止しています",
  live_not_open: "公開中（SITE_STATUS=open）ではなく、運営だけの本番決済テスト（STRIPE_LIVE_OPERATOR_TEST=on）も有効ではありません",
  operator_test_while_open: "公開中（SITE_STATUS=open）なのに、運営だけの本番決済テストのスイッチ（STRIPE_LIVE_OPERATOR_TEST）が残っています。削除してください",
};
