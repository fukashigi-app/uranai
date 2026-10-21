import { NextResponse } from "next/server";
import { dataProvider } from "@/lib/data-provider";
import { readOperatorInfo } from "@/config/operator";
import { dangerousConfigReasons, isPaidFlowBlocked, isTestPaymentConfigured, pausedMessage, productionConfigIssues, siteStatus } from "@/lib/env";
import { checkFirestoreTarget } from "@/lib/firestore/target-guard";
import { getMaintenanceStatus } from "@/lib/services/maintenance-status";

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
    environment: process.env.VERCEL_ENV ?? "local",
    siteStatus: siteStatus().status + (siteStatus().unknown ? " (SITE_STATUS が不明な値のため準備中として扱っています)" : ""),
    paymentMode: isPaidFlowBlocked()
      ? pausedMessage(dangerousConfigReasons())
      : siteStatus().status === "development"
        ? "development (開発モード：決済は受け付けていません。無料の占いは運営アカウントのみ)"
      : siteStatus().status === "coming_soon"
        ? "coming_soon (準備中：無料テスト・決済とも受け付けていません)"
        : isTestPaymentConfigured()
        ? "test (ENABLE_TEST_PAYMENT=true)"
        : process.env.PAYJP_SECRET_KEY
          ? process.env.PAYJP_SECRET_KEY.startsWith("sk_live_")
            ? "payjp (live)"
            : "payjp (test keys: 売上・精算には含めない)"
          : "none (決済未設定)",
    CRON_SECRET: process.env.CRON_SECRET ? "set" : "missing (定期処理が実行されません)",
  };
  // 本番環境の危険な設定・設定漏れ（値は返さない）。error があれば ok=false
  const prodIssues = productionConfigIssues();
  const prodErrors = prodIssues.filter((i) => i.level === "error");
  checks.productionConfig = prodIssues.length ? prodIssues.map((i) => `${i.level}: ${i.key}`).join(", ") : process.env.VERCEL_ENV === "production" ? "ok" : "not production";
  // 特商法表記などの運営者情報（値そのものは返さない。表示の可否に影響しないため ok の判定には含めない）
  const operator = readOperatorInfo().issues;
  const opErrors = operator.filter((i) => i.level === "error").map((i) => i.key);
  checks.operatorInfo = opErrors.length ? `error: 仮の値または不正な値を無視しています (${opErrors.join(", ")})` : "ok";
  checks.operatorDisclosure = operator.some((i) => i.key === "disclosure") ? "on-request (氏名・住所・電話番号は請求時開示の表示。法令上の条件は要確認)" : "listed";
  if (provider === "firestore") {
    const target = checkFirestoreTarget();
    checks.firestoreTarget = target.ok ? "ok" : `blocked (${target.reason})`;
    checks.PRODUCTION_FIREBASE_PROJECT_ID = process.env.PRODUCTION_FIREBASE_PROJECT_ID ? "set" : "missing";
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
  // 定期処理の最終実行（Firestore のみ記録。時刻と成否だけ）
  try {
    const m = await getMaintenanceStatus();
    checks.maintenance = !m.tracked
      ? "not tracked (PostgreSQL: Vercel のログで確認)"
      : m.lastSuccessAt
        ? `${m.stale ? "stale" : "ok"} (last success ${m.lastSuccessAt.toISOString()}${m.lastStatus === "failure" ? `, last run failed ${m.lastFailureAt?.toISOString() ?? ""}` : ""})`
        : m.lastStatus === "failure"
          ? `failing (last failure ${m.lastFailureAt?.toISOString() ?? ""})`
          : "never run";
  } catch {
    checks.maintenance = "unknown";
  }
  const ok = database === "ok" && checks.SESSION_SECRET === "set" && prodErrors.length === 0;
  return NextResponse.json({ ok, database, ...checks }, { status: ok ? 200 : 503, headers: { "Cache-Control": "no-store" } });
}
