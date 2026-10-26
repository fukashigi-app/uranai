import "server-only";
import { z } from "zod";

/**
 * サーバー専用の環境変数。秘密鍵はこのモジュール経由でのみ参照する。
 * "server-only" により、クライアントコンポーネントから import するとビルドが失敗する。
 *
 * 決済モード:
 *  - ENABLE_TEST_PAYMENT=true … テストモード。決済をスキップして無料で占える（売上には一切記録しない）
 *  - それ以外 …………………… 本番決済の成功確認が必須（決済が未設定なら占いは開始できない）
 *  - PAYMENT_PROVIDER=mock …… 自動テスト用の疑似決済（本番環境では ALLOW_MOCK_PAYMENTS_IN_PRODUCTION=true が無い限り無効）
 *  - PAYMENT_PROVIDER=stripe … 一般のお客さんの決済を Stripe Checkout で受け付ける（判定は lib/payments/stripe-access.ts）。
 *                              PAY.JP・疑似決済は使わない（env().PAYMENT_PROVIDER は null のまま）
 */
const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  /** PostgreSQL（Firestore 移行完了まで残す）。Firestore 利用時は不要 */
  DATABASE_URL: z.string().optional(),
  APP_URL: z.string().url().optional(),
  SESSION_SECRET: z.string().min(32, "SESSION_SECRET must be at least 32 chars"),
  DATA_ENCRYPTION_KEY: z.string().optional(),
  ENABLE_TEST_PAYMENT: z.string().optional(),
  PAYMENT_PROVIDER: z.enum(["payjp", "mock", "stripe"]).optional(),
  PAYJP_PUBLIC_KEY: z.string().optional(),
  PAYJP_SECRET_KEY: z.string().optional(),
  PAYJP_WEBHOOK_TOKEN: z.string().optional(),
  MOCK_WEBHOOK_SECRET: z.string().optional(),
  CRON_SECRET: z.string().optional(),
  ALLOW_MOCK_PAYMENTS_IN_PRODUCTION: z.string().optional(),
});

type RawEnv = z.infer<typeof schema>;
export type Env = Omit<RawEnv, "APP_URL" | "PAYMENT_PROVIDER" | "MOCK_WEBHOOK_SECRET"> & {
  APP_URL: string;
  /** 有料フローの新規決済に使うプロバイダ（PAY.JP・疑似決済）。null = これらでは受け付けない（未設定、または PAYMENT_PROVIDER=stripe） */
  PAYMENT_PROVIDER: "payjp" | "mock" | null;
  TEST_PAYMENT_ENABLED: boolean;
  MOCK_WEBHOOK_SECRET: string;
};

let cached: Env | null = null;


export function env(): Env {
  if (cached) return cached;
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    const msg = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`Invalid environment variables: ${msg}`);
  }
  const e = parsed.data;
  const testEnabled = isTestPaymentEnabled();
  // 疑似決済は Vercel の本番では常に無効（ALLOW_MOCK_PAYMENTS_IN_PRODUCTION も無視）。
  // 本番の決済へ自動で切り替えることもしない（provider = null → 「お支払いを受け付けていません」で停止）
  const mockAllowed = !isProductionDeployment() && (e.NODE_ENV !== "production" || e.ALLOW_MOCK_PAYMENTS_IN_PRODUCTION === "true");

  let provider: Env["PAYMENT_PROVIDER"] = null;
  if (e.PAYMENT_PROVIDER === "mock") {
    provider = mockAllowed ? "mock" : null;
  } else if (e.PAYMENT_PROVIDER === "stripe") {
    // Stripe を選んだときは PAY.JP のキーが残っていても PAY.JP では決済しない
    provider = null;
  } else {
    const configured = Boolean(e.PAYJP_PUBLIC_KEY && e.PAYJP_SECRET_KEY && e.PAYJP_WEBHOOK_TOKEN);
    if (configured && e.PAYJP_SECRET_KEY!.startsWith("pk_")) throw new Error("PAYJP_SECRET_KEY looks like a public key");
    provider = configured ? "payjp" : null;
  }

  cached = {
    ...e,
    APP_URL: appUrlFromEnv(process.env),
    PAYMENT_PROVIDER: provider,
    TEST_PAYMENT_ENABLED: testEnabled,
    // 未指定ならセッション秘密鍵から派生（テスト決済の署名用。本番決済には使われない）
    MOCK_WEBHOOK_SECRET: e.MOCK_WEBHOOK_SECRET && e.MOCK_WEBHOOK_SECRET.length >= 16 ? e.MOCK_WEBHOOK_SECRET : `mock:${e.SESSION_SECRET}`,
  };
  return cached;
}

export const isProduction = () => process.env.NODE_ENV === "production";

type RawProcessEnv = Record<string, string | undefined>;

import { isDevModeLiveKeyConflict, livePaymentKeyNames, siteStatus } from "./env-rules";
import { STRIPE_LIVE_DENY_MESSAGE, stripeLiveConfig } from "./payments/stripe-guard";
export { isDevModeLiveKeyConflict, isSessionSecretStrong, livePaymentKeyNames, siteStatus, type SiteStatus } from "./env-rules";

/**
 * Vercel の本番環境（Production デプロイ）か。
 * ローカルの `next start`（自動テスト）や Preview デプロイは本番扱いにしない（開発用の無料テスト機能を維持するため）。
 */
export function isProductionDeployment(e: RawProcessEnv = process.env): boolean {
  return e.VERCEL_ENV === "production";
}

/** ENABLE_TEST_PAYMENT=true が設定されているか（本番かどうかに関係なく、設定値そのもの） */
export function isTestPaymentConfigured(e: RawProcessEnv = process.env): boolean {
  return e.ENABLE_TEST_PAYMENT === "true";
}

/**
 * 無料テストモードを提供するか。DB等の設定が無くても判定できるよう process.env を直接見る。
 * Vercel の本番では ENABLE_TEST_PAYMENT=true でも常に false（運営・店舗アカウントも含め例外なし）。
 */
export function isTestPaymentEnabled(e: RawProcessEnv = process.env): boolean {
  return isTestPaymentConfigured(e) && !isProductionDeployment(e);
}

/**
 * 占いの受付（無料テスト・開発モード・有料の決済とも）を止めるか。
 * Vercel の本番で ENABLE_TEST_PAYMENT=true または PAYMENT_PROVIDER=mock のままのとき、
 * または開発モード（SITE_STATUS=development）で本番用の決済キーが設定されているときは、
 * テストのつもりの設定で実際の課金へ切り替わらないよう、運営・店舗アカウントを含め誰にも提供しない（安全側で停止）。
 * 運営・店舗の管理画面は停止しない。
 */
export function isPaidFlowBlocked(e: RawProcessEnv = process.env): boolean {
  if (isDevModeLiveKeyConflict(e)) return true;
  return isProductionDeployment(e) && (isTestPaymentConfigured(e) || e.PAYMENT_PROVIDER === "mock");
}

/**
 * 占いの受付を止めている危険な設定の種類（isPaidFlowBlocked の内訳）。値は返さず、種類と変数名だけ。
 *  test_payment_in_production … 本番で ENABLE_TEST_PAYMENT=true（無料テストの設定）
 *  mock_in_production         … 本番で PAYMENT_PROVIDER=mock（疑似決済）
 *  live_key_in_development    … 開発モードで本番用の決済キーが設定されている（keys に変数名）
 */
export type DangerousConfigReason =
  | { kind: "test_payment_in_production" }
  | { kind: "mock_in_production" }
  | { kind: "live_key_in_development"; keys: string[] };

export function dangerousConfigReasons(e: RawProcessEnv = process.env): DangerousConfigReason[] {
  const out: DangerousConfigReason[] = [];
  if (isProductionDeployment(e) && isTestPaymentConfigured(e)) out.push({ kind: "test_payment_in_production" });
  if (isProductionDeployment(e) && e.PAYMENT_PROVIDER === "mock") out.push({ kind: "mock_in_production" });
  if (isDevModeLiveKeyConflict(e)) out.push({ kind: "live_key_in_development", keys: livePaymentKeyNames(e) });
  return out;
}

/** 危険な設定で停止しているときの説明（/api/health 用。種類と変数名だけで、値は出さない） */
export function pausedMessage(reasons: DangerousConfigReason[]): string {
  const parts = reasons.map((r) =>
    r.kind === "test_payment_in_production"
      ? "本番で無料テストの設定（ENABLE_TEST_PAYMENT=true）が有効になっている"
      : r.kind === "mock_in_production"
        ? "本番で疑似決済（PAYMENT_PROVIDER=mock）が設定されている"
        : `開発モードで本番用の決済キー（${r.keys.join("・")}）が設定されている`,
  );
  return `paused (${parts.length ? `${parts.join("・")}ため` : "危険な設定のため"}、占いの受付を停止中)`;
}

/**
 * 一般向けの占いの受付（無料テスト・有料の決済）を止める理由。止めないときは null。
 *  dangerous_config … 危険な設定（本番の ENABLE_TEST_PAYMENT=true・PAYMENT_PROVIDER=mock、開発モードでの本番用決済キー）。
 *                     設定の誤りとして警告する。開発モードの無料占いも含めて止める（最優先）
 *  development      … 開発モード（SITE_STATUS=development）。決済は誰に対しても受け付けない。
 *                     無料の占いは運営アカウントだけ（判定は lib/services/dev-mode.ts。ここでは一般向けとして停止を返す）
 *  coming_soon      … 準備中モード（SITE_STATUS=coming_soon・不明な値）。正常な運用状態
 * 決済の API・ページは、null 以外ならどの理由でも受け付けない。
 */
export type ServiceStopReason = "dangerous_config" | "development" | "coming_soon";

export function serviceStopReason(e: RawProcessEnv = process.env): ServiceStopReason | null {
  if (isPaidFlowBlocked(e)) return "dangerous_config";
  const s = siteStatus(e).status;
  if (s === "development") return "development";
  if (s === "coming_soon") return "coming_soon";
  return null;
}

/**
 * 公開URL（QRコード・Origin 確認に使う）。
 *  - APP_URL があればそれを使う。ただし Preview では、本番のドメインを指している APP_URL は使わない
 *    （「全環境」に登録した APP_URL のせいで、Preview で発行した QR コードが本番を指さないように）
 *  - Production: 本番ドメイン（VERCEL_PROJECT_PRODUCTION_URL）→ デプロイURL
 *  - Preview / Development: ブランチの固定URL（VERCEL_BRANCH_URL）→ デプロイURL。本番ドメインは決して使わない
 *  - ローカル: http://localhost:3000
 */
export function appUrlFromEnv(e: RawProcessEnv = process.env): string {
  const prodHost = (e.VERCEL_PROJECT_PRODUCTION_URL ?? "").trim().toLowerCase();
  const nonProdVercel = e.VERCEL_ENV === "preview" || e.VERCEL_ENV === "development";
  const explicit = e.APP_URL?.trim().replace(/\/$/, "");
  if (explicit) {
    let host = "";
    try {
      host = new URL(explicit).host.toLowerCase();
    } catch {
      host = "";
    }
    if (!(nonProdVercel && prodHost && host === prodHost)) return explicit;
  }
  const https = (h: string | undefined) => (h && h.trim() ? `https://${h.trim().replace(/^https?:\/\//, "").replace(/\/$/, "")}` : null);
  if (nonProdVercel) return https(e.VERCEL_BRANCH_URL) ?? https(e.VERCEL_URL) ?? "http://localhost:3000";
  return https(e.VERCEL_PROJECT_PRODUCTION_URL) ?? https(e.VERCEL_URL) ?? "http://localhost:3000";
}

/** Vercel の Preview / Development（開発・テスト環境）か */
export function isNonProductionVercel(e: RawProcessEnv = process.env): boolean {
  return e.VERCEL_ENV === "preview" || e.VERCEL_ENV === "development";
}

export type ProductionConfigIssue = {
  /** error = 本番で使ってはいけない設定（安全のため一部の機能を停止中）。warning = 確認が必要な設定 */
  level: "error" | "warning";
  key: string;
  message: string;
};

/**
 * 本番環境の危険な設定・設定漏れ。値そのもの（秘密鍵など）は返さない。本番以外では空。
 * /api/health と運営ダッシュボードで表示する。
 */
export function productionConfigIssues(e: RawProcessEnv = process.env): ProductionConfigIssue[] {
  if (!isProductionDeployment(e)) return [];
  const issues: ProductionConfigIssue[] = [];
  if (isTestPaymentConfigured(e)) {
    issues.push({
      level: "error",
      key: "ENABLE_TEST_PAYMENT",
      message: "本番で ENABLE_TEST_PAYMENT=true になっています。安全のため、占いの受付（無料テスト・有料の決済とも、運営・店舗アカウントを含む）を停止しています。削除してください。",
    });
  }
  if (e.PAYMENT_PROVIDER === "mock") {
    issues.push({ level: "error", key: "PAYMENT_PROVIDER", message: "本番で PAYMENT_PROVIDER=mock になっています。疑似決済は本番では使えないため、占いの受付（無料テスト・有料の決済とも）を停止しています。削除してください。" });
  }
  if (e.PAYMENT_PROVIDER === "stripe") {
    issues.push({ level: "warning", key: "PAYMENT_PROVIDER", message: "PAYMENT_PROVIDER=stripe ですが、Stripe の本番決済はまだ実装されていないため、本番では決済を受け付けていません。" });
  }
  if (e.ALLOW_MOCK_PAYMENTS_IN_PRODUCTION === "true") {
    issues.push({ level: "error", key: "ALLOW_MOCK_PAYMENTS_IN_PRODUCTION", message: "本番では無視しています（疑似決済は使えません）。削除してください。" });
  }
  if (!e.CRON_SECRET) {
    issues.push({
      level: "error",
      key: "CRON_SECRET",
      message: "CRON_SECRET が未設定です。定期処理（期限切れの処理・占い結果の30日削除など）が認証できず実行されません。",
    });
  }
  if (siteStatus(e).unknown) {
    issues.push({ level: "warning", key: "SITE_STATUS", message: "SITE_STATUS に open・coming_soon・development 以外の値が設定されています。安全のため準備中として扱っています。" });
  }
  if (isDevModeLiveKeyConflict(e)) {
    issues.push({
      level: "error",
      key: "SITE_STATUS",
      message: `開発モードなのに本番用の決済キー（${livePaymentKeyNames(e).join("・")}）が設定されています。安全のため、占いの受付（開発モードの無料占いを含む）を停止しています。開発モード中は本番用の決済キーを削除してください。`,
    });
  }
  if ((e.STRIPE_TEST_CHECKOUT ?? "").trim()) {
    issues.push({ level: "error", key: "STRIPE_TEST_CHECKOUT", message: "Stripe のテスト決済の設定が本番にあります（本番では常に無効にしています）。Preview だけに設定し、本番からは削除してください。" });
  }
  if ((e.STRIPE_SECRET_KEY ?? "").startsWith("sk_test_") || (e.STRIPE_API_BASE ?? "").trim()) {
    issues.push({ level: "warning", key: "STRIPE_KEYS", message: "Stripe のテスト用の設定が本番にあります。本番では使いません。Preview だけに設定してください。" });
  }
  // Stripe の本番決済のスイッチがあるときは、本番の条件（キー・Firebase の接続先など）がそろっているか確かめる（値は出さない）
  if ((e.STRIPE_LIVE_CHECKOUT ?? "").trim() || (e.STRIPE_LIVE_OPERATOR_TEST ?? "").trim()) {
    const live = stripeLiveConfig({ ...e, VERCEL_ENV: "production" });
    issues.push(
      live.ok
        ? { level: "warning", key: "STRIPE_LIVE_CHECKOUT", message: "Stripe の本番決済の設定はそろっていますが、本番決済はまだ実装されていません（使われません）。" }
        : { level: "error", key: "STRIPE_LIVE_CHECKOUT", message: `Stripe の本番決済の設定に問題があります：${STRIPE_LIVE_DENY_MESSAGE[live.reason]}` },
    );
  }
  const prodFs = (e.PRODUCTION_FIREBASE_PROJECT_ID ?? "").trim();
  if (prodFs && e.FIREBASE_PROJECT_ID && e.FIREBASE_PROJECT_ID.trim().toLowerCase() !== prodFs.toLowerCase()) {
    issues.push({ level: "warning", key: "FIREBASE_PROJECT_ID", message: "本番の Firebase プロジェクトが PRODUCTION_FIREBASE_PROJECT_ID と一致しません。本番以外のプロジェクトに接続していないか確認してください。" });
  }
  const sk = e.PAYJP_SECRET_KEY ?? "";
  const pk = e.PAYJP_PUBLIC_KEY ?? "";
  if (sk.startsWith("sk_test_") || pk.startsWith("pk_test_")) {
    issues.push({ level: "warning", key: "PAYJP_KEYS", message: "PAY.JP のテスト用キーが設定されています。テスト決済は売上・店舗の取り分・月次精算には含めません。公開時は本番用キーにしてください。" });
  }
  if ((sk.startsWith("sk_live_") && pk.startsWith("pk_test_")) || (sk.startsWith("sk_test_") && pk.startsWith("pk_live_"))) {
    issues.push({ level: "warning", key: "PAYJP_KEYS", message: "PAY.JP の公開鍵と秘密鍵で、本番用とテスト用が混在しています。決済が失敗します。" });
  }
  return issues;
}

/** 本番(HTTPS)では Secure Cookie を必須にする */
export function secureCookiesEnabled(): boolean {
  return env().APP_URL.startsWith("https://");
}
