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

export const PREVIEW_FIREBASE_PROJECT_ID = "uranai-preview";
export const PRODUCTION_FIREBASE_PROJECT_ID = "uranai-b6edf";
export const DIAGNOSTICS_TOKEN_MIN_LENGTH = 32;

/** uranai-preview のサービスアカウント（名前@プロジェクトID.iam.gserviceaccount.com） */
const PREVIEW_SERVICE_ACCOUNT_RE = /^[a-z][a-z0-9-]{4,28}[a-z0-9]@uranai-preview\.iam\.gserviceaccount\.com$/;

export type FirebaseTargetDiagnostics = {
  projectIdIsPreview: boolean;
  productionProjectIdIsExpected: boolean;
  clientEmailBelongsToPreview: boolean;
  projectIdMatchesStripeTestProject: boolean;
};

export function firebaseTargetDiagnostics(e: Env = process.env): FirebaseTargetDiagnostics {
  const projectId = e.FIREBASE_PROJECT_ID;
  const stripeTestProject = e.STRIPE_TEST_FIREBASE_PROJECT_ID;
  return {
    projectIdIsPreview: projectId === PREVIEW_FIREBASE_PROJECT_ID,
    productionProjectIdIsExpected: e.PRODUCTION_FIREBASE_PROJECT_ID === PRODUCTION_FIREBASE_PROJECT_ID,
    clientEmailBelongsToPreview: typeof e.FIREBASE_CLIENT_EMAIL === "string" && PREVIEW_SERVICE_ACCOUNT_RE.test(e.FIREBASE_CLIENT_EMAIL),
    projectIdMatchesStripeTestProject: typeof projectId === "string" && projectId !== "" && typeof stripeTestProject === "string" && stripeTestProject !== "" && projectId === stripeTestProject,
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
