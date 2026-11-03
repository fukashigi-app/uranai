/**
 * Preview の Firebase の接続先の診断（/api/ops/firebase-target）。
 *
 * 環境変数の値を比べるだけで、Firebase・Firestore には一切接続しない（接続先が誤っていても、診断で読み書きは起きない）。
 * 結果は true / false だけで、値・値の一部・長さ・ハッシュ・「未設定か不一致か」は返さない。
 * 比較は加工しない（アプリが使う値そのもの。前後の空白が混じっていれば false になる）。
 *
 * 使えるのは Vercel の Preview で、診断専用のトークン（OPS_DIAGNOSTICS_TOKEN。32文字以上）が設定されているときだけ。
 * 本番（VERCEL_ENV=production）・ローカル・トークンの未設定では常に無効。
 * route や単体テストから読み込めるよう、server-only・env.ts・Firestore に依存しない。
 */
import { createHash, timingSafeEqual } from "node:crypto";

type Env = Record<string, string | undefined>;

// プロジェクトID・サービスアカウントの判定は、データベースの接続の判定（target-guard.ts）と同じものを使う
import { isServiceAccountOf, PREVIEW_FIREBASE_PROJECT_ID, PREVIEW_FIREBASE_TARGETS, previewFirebaseTargetOf, PRODUCTION_FIREBASE_PROJECT_ID, type PreviewFirebaseTarget } from "@/lib/firestore/target-guard";
export { PREVIEW_FIREBASE_PROJECT_ID, PRODUCTION_FIREBASE_PROJECT_ID };
export const DIAGNOSTICS_TOKEN_MIN_LENGTH = 32;

/**
 *  projectIdIsPreview               … FIREBASE_PROJECT_ID が、コードで許可した Preview 用のプロジェクトのどれか
 *  productionProjectIdIsExpected    … PRODUCTION_FIREBASE_PROJECT_ID が本番のプロジェクト
 *  clientEmailBelongsToPreview      … FIREBASE_CLIENT_EMAIL が、FIREBASE_PROJECT_ID（許可した Preview 用のプロジェクト）のサービスアカウント
 *  projectIdMatchesStripeTestProject … FIREBASE_PROJECT_ID と STRIPE_TEST_FIREBASE_PROJECT_ID が一致
 *  stripeAccountIdReady             … STRIPE_ACCOUNT_ID が必要な検証環境なら設定されていて形が正しい（不要な環境では、未設定か形が正しければ true）
 */
export type FirebaseTargetDiagnostics = {
  projectIdIsPreview: boolean;
  productionProjectIdIsExpected: boolean;
  clientEmailBelongsToPreview: boolean;
  projectIdMatchesStripeTestProject: boolean;
  stripeAccountIdReady: boolean;
};

export function firebaseTargetDiagnostics(e: Env = process.env, targets: readonly PreviewFirebaseTarget[] = PREVIEW_FIREBASE_TARGETS): FirebaseTargetDiagnostics {
  const projectId = e.FIREBASE_PROJECT_ID;
  const stripeTestProject = e.STRIPE_TEST_FIREBASE_PROJECT_ID;
  const target = previewFirebaseTargetOf(projectId, targets);
  const account = e.STRIPE_ACCOUNT_ID;
  const accountOk = typeof account === "string" && /^acct_[A-Za-z0-9]{6,64}$/.test(account);
  return {
    projectIdIsPreview: target !== null,
    productionProjectIdIsExpected: e.PRODUCTION_FIREBASE_PROJECT_ID === PRODUCTION_FIREBASE_PROJECT_ID,
    clientEmailBelongsToPreview: target !== null && isServiceAccountOf(e.FIREBASE_CLIENT_EMAIL, target.projectId),
    projectIdMatchesStripeTestProject: typeof projectId === "string" && projectId !== "" && typeof stripeTestProject === "string" && stripeTestProject !== "" && projectId === stripeTestProject,
    stripeAccountIdReady: target?.requireStripeAccountId ? accountOk : account === undefined || account === "" || accountOk,
  };
}

export type DiagnosticsAccess = "disabled" | "unauthorized" | "ok";

/**
 * 診断を返してよいか。
 *  - disabled     … Preview 以外（本番・ローカル）、またはトークンが未設定・短すぎる（存在しないものとして 404）
 *  - unauthorized … Authorization: Bearer <トークン> が無い・一致しない（401。理由は返さない）
 * トークンは URL では受け取らない（ログに残らないよう、ヘッダーだけ）。
 */
export function diagnosticsAccess(authorization: string | null, e: Env = process.env): DiagnosticsAccess {
  if (e.VERCEL_ENV === "production" || e.VERCEL_ENV !== "preview") return "disabled";
  const token = e.OPS_DIAGNOSTICS_TOKEN ?? "";
  if (token.trim().length < DIAGNOSTICS_TOKEN_MIN_LENGTH) return "disabled";
  const m = /^Bearer (\S+)$/.exec(authorization ?? "");
  if (!m || !constantTimeEqual(m[1], token)) return "unauthorized";
  return "ok";
}

/** 長さや内容によらず同じ時間で比べる（ハッシュしてから timingSafeEqual） */
function constantTimeEqual(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a, "utf8").digest();
  const hb = createHash("sha256").update(b, "utf8").digest();
  return timingSafeEqual(ha, hb) && a === b;
}
