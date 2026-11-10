import { NextResponse } from "next/server";
import { isStripeNewCheckoutPaused, isStripeProviderSelected, stripeNewCheckoutState, stripePublicCheckoutAccess } from "@/lib/payments/stripe-access";
import { dataProvider } from "@/lib/data-provider";
import { readOperatorInfo } from "@/config/operator";
import { dangerousConfigReasons, isPaidFlowBlocked, isTestPaymentConfigured, pausedMessage, productionConfigIssues, siteStatus } from "@/lib/env";
import { checkFirestoreTarget } from "@/lib/firestore/target-guard";
import { firebaseCredentialMode } from "@/lib/firestore/credential-mode";
import { stripeLiveConfig } from "@/lib/payments/stripe-guard";

const stripeLiveOperatorAudience = () => {
  const c = stripeLiveConfig();
  return c.ok && c.audience === "operator";
};
import { getMaintenanceStatus } from "@/lib/services/maintenance-status";
import { getSessionUser } from "@/lib/auth/session";
import { clientIpMode } from "@/lib/security/client-ip";
import { trustedOriginMode } from "@/lib/security/trusted-origin";

/** Cloud Run 用の設定の状態（3種類だけ。位置・APP_URL などの値は返さない。環境変数を見るだけで、データベースには接続しない） */
type CloudRunSettingState = "未設定" | "有効" | "設定の誤り";

/** CLIENT_IP_SOURCE と CLIENT_IP_XFF_POSITION_FROM_RIGHT の組み合わせ（位置だけ残っているのも誤りとして扱う） */
function clientIpSourceState(): CloudRunSettingState {
  try {
    if (clientIpMode().kind === "xff-from-right") return "有効";
  } catch {
    return "設定の誤り";
  }
  return (process.env.CLIENT_IP_XFF_POSITION_FROM_RIGHT ?? "").trim() === "" ? "未設定" : "設定の誤り";
}

/** TRUSTED_ORIGIN_SOURCE と APP_URL（https のオリジン・アプリが使う公開 URL と一致）の組み合わせ */
function trustedOriginSourceState(): CloudRunSettingState {
  try {
    return trustedOriginMode().kind === "app-url" ? "有効" : "未設定";
  } catch {
    return "設定の誤り";
  }
}

export const dynamic = "force-dynamic";

/**
 * 動作確認用の診断エンドポイント。秘密情報は返さない。
 *  - 運営アカウントでログインしているとき：詳細（設定の有無・接続先・Firestore の接続確認・定期処理の状況）
 *  - それ以外（認証なし）：Firestore を読み書きしない簡易の稼働確認だけ（ok と案内）。
 *    大量のアクセスで Firestore の無料枠（Spark）を消費させないため。環境の詳細も返さない。
 *    ログインのセッションの Cookie が無ければ、運営かどうかの確認でも Firestore を読まない（getSessionUser）。
 */
export async function GET() {
  const user = await getSessionUser().catch(() => null);
  if (user?.role === "OPERATOR") return detailedHealth();
  // 設定だけで判断できる稼働状態（環境変数を見るだけ。Firestore は使わない）
  const ok = (process.env.SESSION_SECRET?.length ?? 0) >= 32 && productionConfigIssues().every((i) => i.level !== "error");
  return NextResponse.json(
    { ok, detail: "詳細は、運営アカウントでログインしたブラウザで開くと表示します。" },
    { status: ok ? 200 : 503, headers: { "Cache-Control": "no-store" } },
  );
}

/** 運営向けの詳細（従来の /api/health の内容。Firestore の読み取り2回：接続確認・定期処理の状況） */
async function detailedHealth(): Promise<Response> {
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
        ? stripeLiveOperatorAudience()
          ? "development + live operator test (開発モード：運営アカウントだけの本番決済テスト。一般の方の決済は受け付けていません)"
          : "development (開発モード：決済は受け付けていません。無料の占いは運営アカウントのみ)"
      : siteStatus().status === "coming_soon"
        ? "coming_soon (準備中：無料テスト・決済とも受け付けていません)"
        : isTestPaymentConfigured()
        ? "test (ENABLE_TEST_PAYMENT=true)"
        : isStripeProviderSelected()
          ? stripePublicCheckoutAccess().ok
            ? (stripePublicCheckoutAccess() as { mode?: string }).mode === "live"
              ? "stripe (live: 本番決済。売上・精算の対象)"
              : "stripe (test: Sandbox。売上・精算には含めない)"
            : isStripeNewCheckoutPaused()
              ? "stripe (新規の決済の受付を停止中：STRIPE_NEW_CHECKOUT。既存の決済の Webhook・返金・定期処理は継続)"
              : "stripe (決済を受け付けていません：設定が不足しています)"
          : "none (決済未設定。決済は Stripe だけ：PAYMENT_PROVIDER=stripe)",
    CRON_SECRET: process.env.CRON_SECRET ? "set" : "missing (定期処理が実行されません)",
  };
  // Stripe との接続（Webhook・定期処理・運営の操作に使う）と、新規の決済の受付は別に表示する（値は返さない）
  {
    const st = stripeNewCheckoutState();
    checks.stripeConnection = st.connection ? `${st.mode} (Webhook・返金・異議申し立て・再確認・決済監視を処理します)` : "unavailable (Stripe の Webhook・決済を受け付けていません)";
    checks.stripeNewCheckout = !st.connection ? "unavailable" : st.accepting ? "accepting (STRIPE_NEW_CHECKOUT=on)" : `stopped (${st.reason})`;
  }
  // Cloud Run 用の設定（未設定は正常。設定の誤りは API が停止するため ok=false。値は返さない）
  checks.CLIENT_IP_SOURCE = clientIpSourceState();
  checks.TRUSTED_ORIGIN_SOURCE = trustedOriginSourceState();
  const cloudRunConfigError = checks.CLIENT_IP_SOURCE === "設定の誤り" || checks.TRUSTED_ORIGIN_SOURCE === "設定の誤り";
  // 本番環境の危険な設定・設定漏れ（値は返さない）。error があれば ok=false
  const prodIssues = productionConfigIssues();
  const prodErrors = prodIssues.filter((i) => i.level === "error");
  checks.productionConfig = prodIssues.length ? prodIssues.map((i) => `${i.level}: ${i.key}`).join(", ") : process.env.VERCEL_ENV === "production" ? "ok" : "not production";
  // 特商法表記などの運営者情報（値そのものは返さない。表示の可否に影響しないため ok の判定には含めない）
  const operator = readOperatorInfo().issues;
  const opErrors = operator.filter((i) => i.level === "error").map((i) => i.key);
  checks.operatorInfo = opErrors.length ? `error: 仮の値または不正な値を無視しています (${opErrors.join(", ")})` : "ok";
  // Cloud Run 上（K_SERVICE がある）では、運営者情報の仮の値・不正な値を ok=false にする（公開前のチェックで確実に気付くため。
  // 表示には使わず既定の屋号・問い合わせ先を出す動作は従来どおり。Vercel では K_SERVICE が無いので ok の判定は変えない）
  const operatorBlocksHealth = Boolean(process.env.K_SERVICE) && opErrors.length > 0;
  checks.operatorDisclosure = operator.some((i) => i.key === "disclosure") ? "on-request (氏名・住所・電話番号は請求時開示の表示。法令上の条件は要確認)" : "listed";
  if (provider === "firestore") {
    const target = checkFirestoreTarget();
    checks.firestoreTarget = target.ok ? "ok" : `blocked (${target.reason})`;
    checks.PRODUCTION_FIREBASE_PROJECT_ID = process.env.PRODUCTION_FIREBASE_PROJECT_ID ? "set" : "missing";
    checks.FIREBASE_PROJECT_ID = process.env.FIREBASE_PROJECT_ID ? "set" : "missing";
    let credentialMode: string;
    try {
      credentialMode = firebaseCredentialMode();
    } catch {
      credentialMode = "invalid";
    }
    checks.FIREBASE_CREDENTIALS = credentialMode === "invalid" ? "invalid (空または application-default のどちらかにしてください)" : credentialMode;
    if (credentialMode === "application-default") {
      // 実行用サービスアカウントで接続する（秘密鍵は使わない。登録されていると接続を停止する）
      checks.FIREBASE_CLIENT_EMAIL = process.env.FIREBASE_CLIENT_EMAIL ? "set (application-default では登録しないでください)" : "not used";
      checks.FIREBASE_PRIVATE_KEY = process.env.FIREBASE_PRIVATE_KEY ? "set (application-default では登録しないでください)" : "not used";
    } else {
      checks.FIREBASE_CLIENT_EMAIL = process.env.FIREBASE_CLIENT_EMAIL ? "set" : "missing";
      checks.FIREBASE_PRIVATE_KEY = !process.env.FIREBASE_PRIVATE_KEY
        ? "missing"
        : /BEGIN PRIVATE KEY/.test(process.env.FIREBASE_PRIVATE_KEY) && /END PRIVATE KEY/.test(process.env.FIREBASE_PRIVATE_KEY)
          ? "set"
          : "set (形式が正しくない可能性: -----BEGIN PRIVATE KEY----- から -----END PRIVATE KEY----- まで全体を登録してください)";
    }
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
  const ok = database === "ok" && checks.SESSION_SECRET === "set" && prodErrors.length === 0 && !cloudRunConfigError && !operatorBlocksHealth;
  return NextResponse.json({ ok, database, ...checks }, { status: ok ? 200 : 503, headers: { "Cache-Control": "no-store" } });
}
