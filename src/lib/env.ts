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
 */
const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  /** PostgreSQL（Firestore 移行完了まで残す）。Firestore 利用時は不要 */
  DATABASE_URL: z.string().optional(),
  APP_URL: z.string().url().optional(),
  SESSION_SECRET: z.string().min(32, "SESSION_SECRET must be at least 32 chars"),
  DATA_ENCRYPTION_KEY: z.string().optional(),
  ENABLE_TEST_PAYMENT: z.string().optional(),
  PAYMENT_PROVIDER: z.enum(["payjp", "mock"]).optional(),
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
  /** 有料フローの新規決済に使うプロバイダ。null = 決済受付不可（本番決済が未設定） */
  PAYMENT_PROVIDER: "payjp" | "mock" | null;
  TEST_PAYMENT_ENABLED: boolean;
  MOCK_WEBHOOK_SECRET: string;
};

let cached: Env | null = null;

/** Vercel では APP_URL 未設定でも本番ドメインを自動で使う */
function resolveAppUrl(raw: RawEnv): string {
  if (raw.APP_URL) return raw.APP_URL.replace(/\/$/, "");
  const vercel = process.env.VERCEL_PROJECT_PRODUCTION_URL ?? process.env.VERCEL_URL;
  if (vercel) return `https://${vercel}`;
  return "http://localhost:3000";
}

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
  } else {
    const configured = Boolean(e.PAYJP_PUBLIC_KEY && e.PAYJP_SECRET_KEY && e.PAYJP_WEBHOOK_TOKEN);
    if (configured && e.PAYJP_SECRET_KEY!.startsWith("pk_")) throw new Error("PAYJP_SECRET_KEY looks like a public key");
    provider = configured ? "payjp" : null;
  }

  cached = {
    ...e,
    APP_URL: resolveAppUrl(e),
    PAYMENT_PROVIDER: provider,
    TEST_PAYMENT_ENABLED: testEnabled,
    // 未指定ならセッション秘密鍵から派生（テスト決済の署名用。本番決済には使われない）
    MOCK_WEBHOOK_SECRET: e.MOCK_WEBHOOK_SECRET && e.MOCK_WEBHOOK_SECRET.length >= 16 ? e.MOCK_WEBHOOK_SECRET : `mock:${e.SESSION_SECRET}`,
  };
  return cached;
}

export const isProduction = () => process.env.NODE_ENV === "production";

type RawProcessEnv = Record<string, string | undefined>;

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
 * 占いの受付（無料テスト・有料の決済とも）を止めるか。
 * Vercel の本番で ENABLE_TEST_PAYMENT=true または PAYMENT_PROVIDER=mock のままのときは、
 * テストのつもりの設定で実際の課金へ切り替わらないよう、運営・店舗アカウントを含め誰にも提供しない（安全側で停止）。
 * 運営・店舗の管理画面は停止しない。
 */
export function isPaidFlowBlocked(e: RawProcessEnv = process.env): boolean {
  return isProductionDeployment(e) && (isTestPaymentConfigured(e) || e.PAYMENT_PROVIDER === "mock");
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
    issues.push({ level: "error", key: "PAYMENT_PROVIDER", message: "本番で PAYMENT_PROVIDER=mock になっています。疑似決済は本番では使えないため、占いの受付（無料テスト・有料の決済とも）を停止しています。payjp に変更してください。" });
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
