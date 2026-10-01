import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";

export const dynamic = "force-dynamic";

/**
 * 動作確認用の診断エンドポイント。秘密情報は返さない（設定の有無とDB接続可否のみ）。
 */
export async function GET() {
  const checks: Record<string, string> = {
    DATABASE_URL: process.env.DATABASE_URL ? "set" : "missing",
    SESSION_SECRET: (process.env.SESSION_SECRET?.length ?? 0) >= 32 ? "set" : "missing (32文字以上が必要)",
    APP_URL: process.env.APP_URL ? "set" : "auto (Vercel URL)",
    paymentMode: process.env.ENABLE_TEST_PAYMENT === "true" ? "test (ENABLE_TEST_PAYMENT=true)" : process.env.PAYJP_SECRET_KEY ? "payjp" : "none (決済未設定)",
  };
  let database = "not checked";
  try {
    const { db } = await import("@/lib/db");
    const r = await db().execute(sql`SELECT to_regclass('public.stores') IS NOT NULL AS ok`);
    database = r.rows[0]?.ok ? "ok" : "connected, but tables are missing (run migrations)";
  } catch (e) {
    database = `error: ${(e as Error).message.slice(0, 120)}`;
  }
  const ok = database === "ok" && checks.DATABASE_URL === "set" && checks.SESSION_SECRET === "set";
  return NextResponse.json({ ok, database, ...checks }, { status: ok ? 200 : 503, headers: { "Cache-Control": "no-store" } });
}
