import { NextResponse } from "next/server";
import { dataProvider } from "@/lib/data-provider";

export const dynamic = "force-dynamic";

/**
 * 動作確認用の診断エンドポイント。秘密情報は返さない（設定の有無と接続可否のみ）。
 */
export async function GET() {
  const provider = dataProvider();
  const checks: Record<string, string> = {
    dataProvider: provider,
    SESSION_SECRET: (process.env.SESSION_SECRET?.length ?? 0) >= 32 ? "set" : "missing (32文字以上が必要)",
    DATA_ENCRYPTION_KEY: process.env.DATA_ENCRYPTION_KEY ? "set" : "missing (振込先の登録に必要)",
    APP_URL: process.env.APP_URL ? "set" : "auto (Vercel URL)",
    paymentMode: process.env.ENABLE_TEST_PAYMENT === "true" ? "test (ENABLE_TEST_PAYMENT=true)" : process.env.PAYJP_SECRET_KEY ? "payjp" : "none (決済未設定)",
  };
  if (provider === "firestore") {
    checks.FIREBASE_PROJECT_ID = process.env.FIREBASE_PROJECT_ID ? "set" : "missing";
    checks.FIREBASE_CLIENT_EMAIL = process.env.FIREBASE_CLIENT_EMAIL ? "set" : "missing";
    checks.FIREBASE_PRIVATE_KEY = !process.env.FIREBASE_PRIVATE_KEY
      ? "missing"
      : /BEGIN PRIVATE KEY/.test(process.env.FIREBASE_PRIVATE_KEY) && /END PRIVATE KEY/.test(process.env.FIREBASE_PRIVATE_KEY)
        ? "set"
        : "set (形式が正しくない可能性: -----BEGIN PRIVATE KEY----- から -----END PRIVATE KEY----- まで全体を登録してください)";
  } else {
    checks.DATABASE_URL = process.env.DATABASE_URL ? "set" : "missing";
  }

  let database = "not checked";
  try {
    if (provider === "firestore") {
      const { ping } = await import("@/lib/firestore/misc");
      database = await ping();
    } else if (process.env.DATABASE_URL) {
      const { sql } = await import("drizzle-orm");
      const { db } = await import("@/lib/db");
      const r = await db().execute(sql`SELECT to_regclass('public.stores') IS NOT NULL AS ok`);
      database = r.rows[0]?.ok ? "ok" : "connected, but tables are missing (run migrations)";
    } else {
      database = "not configured";
    }
  } catch (e) {
    // 秘密情報を含まないよう、エラー文は先頭のみ
    database = `error: ${(e as Error).message.split("\n")[0].slice(0, 160)}`;
  }
  const ok = database === "ok" && checks.SESSION_SECRET === "set";
  return NextResponse.json({ ok, database, ...checks }, { status: ok ? 200 : 503, headers: { "Cache-Control": "no-store" } });
}
