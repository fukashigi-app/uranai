import "server-only";
import { z } from "zod";

/**
 * サーバー専用の環境変数。秘密鍵はこのモジュール経由でのみ参照する。
 * "server-only" により、クライアントコンポーネントから import するとビルドが失敗する。
 */
const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  APP_URL: z.string().url(),
  SESSION_SECRET: z.string().min(32, "SESSION_SECRET must be at least 32 chars"),
  DATA_ENCRYPTION_KEY: z.string().min(1, "DATA_ENCRYPTION_KEY is required"),
  PAYMENT_PROVIDER: z.enum(["payjp", "mock"]).default("mock"),
  PAYJP_PUBLIC_KEY: z.string().optional(),
  PAYJP_SECRET_KEY: z.string().optional(),
  PAYJP_WEBHOOK_TOKEN: z.string().optional(),
  MOCK_WEBHOOK_SECRET: z.string().optional(),
  CRON_SECRET: z.string().optional(),
  ALLOW_MOCK_PAYMENTS_IN_PRODUCTION: z.string().optional(),
});

export type Env = z.infer<typeof schema>;

let cached: Env | null = null;

export function env(): Env {
  if (cached) return cached;
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    const msg = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`Invalid environment variables: ${msg}`);
  }
  const e = parsed.data;
  if (e.PAYMENT_PROVIDER === "payjp") {
    if (!e.PAYJP_PUBLIC_KEY || !e.PAYJP_SECRET_KEY || !e.PAYJP_WEBHOOK_TOKEN) {
      throw new Error("PAYJP_PUBLIC_KEY / PAYJP_SECRET_KEY / PAYJP_WEBHOOK_TOKEN are required for payjp");
    }
    if (e.PAYJP_SECRET_KEY.startsWith("pk_")) {
      throw new Error("PAYJP_SECRET_KEY looks like a public key");
    }
  }
  if (e.PAYMENT_PROVIDER === "mock") {
    if (!e.MOCK_WEBHOOK_SECRET || e.MOCK_WEBHOOK_SECRET.length < 16) {
      throw new Error("MOCK_WEBHOOK_SECRET (16+ chars) is required for mock provider");
    }
    if (e.NODE_ENV === "production" && e.ALLOW_MOCK_PAYMENTS_IN_PRODUCTION !== "true") {
      throw new Error("Mock payment provider must not be used in production");
    }
  }
  cached = e;
  return e;
}

export const isProduction = () => process.env.NODE_ENV === "production";

/** 本番(HTTPS)では Secure Cookie を必須にする */
export function secureCookiesEnabled(): boolean {
  return env().APP_URL.startsWith("https://");
}
