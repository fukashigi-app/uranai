/**
 * Sandbox v2 専用：運営者が行う Discord の「テスト異常」の通知（運営画面の「設定」→ POST /api/admin/test-alert）。
 *
 * 作り物の定期処理の異常を、本番の通知と同じ部品（collectCronIssues → buildAlertMessage → sendDiscordAlert）に通して、
 * 異常の判定・本文の組み立て・送信・結果の分類までを、本物の送信先で1回だけ確かめるためのもの。
 *  - 実際の定期処理・決済監視は動かさない。Stripe には接続しない
 *  - Firestore には書き込まない（通知の状態 system/alertNotification・定期処理の記録 system/cronRun・決済監視の異常 paymentAlerts・
 *    決済・返金・占い権利・売上のデータに触れない）。回数の制限はサーバーのメモリだけで数える
 *  - 見出しは「【テスト異常】100円占い・決済の運用（Sandbox v2・テスト）」。テストであること・対応が不要なことを本文に書く。メンションは無効
 *  - 送信先（OPS_ALERT_WEBHOOK_URL）・トークンは画面・ログ・本文に出さない
 * route や単体テストから読み込めるよう、server-only・env.ts・Firestore・Stripe SDK に依存しない。
 */
import { buildAlertMessage, collectCronIssues, type DiscordPayload } from "./alert-notifier";
import { isSandboxV2Environment } from "./stripe-account-diagnostics";
import { SANDBOX_V2_FIREBASE_PROJECT_ID } from "@/lib/firestore/target-guard";

type Env = Record<string, string | undefined>;

export const SANDBOX_V2_BRANCH = "preview/stripe-sandbox-v2";
export const SANDBOX_V2_ENV_LABEL = "Sandbox v2・テスト";
export const TEST_ALERT_NOTICE = "これは運営者が実施したテスト通知です。実際の障害ではありません。対応は不要です。";
/** 作り物の段階の名前とエラーの識別子（本文に出る。実在の段階・エラーと取り違えない名前にする） */
export const TEST_ALERT_PHASE = "テスト用の段階（作り物）";
export const TEST_ALERT_ERROR_CODE = "TestAlert";

/**
 * テストの通知を使えるか。既存の Sandbox v2 の判定（isSandboxV2Environment：Vercel の Preview・Firebase の接続先の安全確認・
 * プロジェクトとブランチの組み合わせ）に加えて、ブランチの名前とプロジェクトの ID をそのままの値でも確かめる（判定の取り違えへの備え）。
 */
export function isTestAlertAllowed(e: Env = process.env): boolean {
  return isSandboxV2Environment(e) && e.VERCEL_ENV === "preview" && e.VERCEL_GIT_COMMIT_REF === SANDBOX_V2_BRANCH && e.FIREBASE_PROJECT_ID === SANDBOX_V2_FIREBASE_PROJECT_ID;
}

/** テストの通知の本文（作り物の定期処理の結果を、本番と同じ判定・組み立てに通す） */
export function buildTestAlertPayload(now: Date = new Date()): DiscordPayload {
  const issues = collectCronIssues({
    runStatus: "partial",
    unsettled: false,
    phases: [{ name: TEST_ALERT_PHASE, status: "failed", reason: null, errorCode: TEST_ALERT_ERROR_CODE }],
  });
  return buildAlertMessage({ envLabel: SANDBOX_V2_ENV_LABEL, at: now, issues, newAlerts: [], newReviews: [], test: { notice: TEST_ALERT_NOTICE } });
}
