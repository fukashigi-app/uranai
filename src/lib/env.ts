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
  const testEnabled = e.ENABLE_TEST_PAYMENT === "true";
  const mockAllowed = e.NODE_ENV !== "production" || e.ALLOW_MOCK_PAYMENTS_IN_PRODUCTION === "true";

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

/** テストモード（ENABLE_TEST_PAYMENT=true）か。DB等の設定が無くても判定できるよう process.env を直接見る */
export function isTestPaymentEnabled(): boolean {
  return process.env.ENABLE_TEST_PAYMENT === "true";
}

/** 本番(HTTPS)では Secure Cookie を必須にする */
export function secureCookiesEnabled(): boolean {
  return env().APP_URL.startsWith("https://");
}
