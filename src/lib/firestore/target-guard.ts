/**
 * Firestore の接続先の安全確認（Preview から本番の Firebase プロジェクトに接続させない）。
 * Firebase Admin SDK の初期化・Firestore への接続の前に、毎回この判定を行う（lib/firestore/admin.ts の fsdb・initApp）。
 *
 *  - Vercel の Preview（VERCEL_ENV=preview）… 次のすべてを満たすときだけ許可（環境変数の登録の誤りがあっても本番に接続しない）
 *      ・PRODUCTION_FIREBASE_PROJECT_ID・FIREBASE_PROJECT_ID が設定されていて、両者が異なる
 *      ・FIREBASE_PROJECT_ID が Preview 用のプロジェクト（uranai-preview）と完全に一致する
 *        （本番のプロジェクト uranai-b6edf は、PRODUCTION_FIREBASE_PROJECT_ID の値に関係なく必ず拒否）
 *      ・PRODUCTION_FIREBASE_PROJECT_ID が本番のプロジェクト（uranai-b6edf）と完全に一致する（登録の誤り・入れ違いを検出する）
 *      ・FIREBASE_CLIENT_EMAIL が uranai-preview のサービスアカウント（…@uranai-preview.iam.gserviceaccount.com）
 *      Preview では Firestore Emulator の設定があっても、この判定を省略しない
 *  - Firestore Emulator（FIRESTORE_EMULATOR_HOST）… 本番には接続しないので許可（Preview を除く）
 *  - Vercel の Development … PRODUCTION_FIREBASE_PROJECT_ID が必須。接続先（FIREBASE_PROJECT_ID）と一致したら停止。どちらかが未設定でも停止
 *  - Vercel の Production … 本番のプロジェクトに接続するので許可（不一致は /api/health で警告）
 *  - ローカル（VERCEL_ENV なし）… PRODUCTION_FIREBASE_PROJECT_ID が設定されていて一致したら停止。未設定なら許可
 *
 * 判定に使うのは環境変数の値だけで、秘密鍵には触れない。プロジェクトID・メールアドレスなどの値はメッセージに含めない。
 * next.config やテストからも読み込めるよう、他のモジュールに依存しない。
 */
type Env = Record<string, string | undefined>;

/** 本番の Firebase プロジェクト */
export const PRODUCTION_FIREBASE_PROJECT_ID = "uranai-b6edf" as const;
/** Vercel の Preview で使ってよい Firebase プロジェクト（これ以外は拒否） */
export const PREVIEW_FIREBASE_PROJECT_ID = "uranai-preview" as const;
/** uranai-preview のサービスアカウント（名前@プロジェクトID.iam.gserviceaccount.com） */
export const PREVIEW_SERVICE_ACCOUNT_RE = /^[a-z][a-z0-9-]{4,28}[a-z0-9]@uranai-preview\.iam\.gserviceaccount\.com$/;

export type FirestoreTargetBlockReason =
  | "preview_uses_production_project"
  | "production_project_id_not_set"
  | "project_id_not_set"
  | "preview_project_not_allowed"
  | "preview_production_project_id_unexpected"
  | "preview_service_account_mismatch";

export type FirestoreTargetCheck = { ok: true } | { ok: false; reason: FirestoreTargetBlockReason };

const norm = (v: string | undefined) => (v ?? "").trim().toLowerCase();

export function checkFirestoreTarget(e: Env = process.env): FirestoreTargetCheck {
  const env = e.VERCEL_ENV;
  if (env === "preview") return checkPreviewTarget(e);
  if (e.FIRESTORE_EMULATOR_HOST) return { ok: true };
  const target = norm(e.FIREBASE_PROJECT_ID);
  const production = norm(e.PRODUCTION_FIREBASE_PROJECT_ID);
  if (env === "production") return { ok: true };
  if (env === "development") {
    if (!production) return { ok: false, reason: "production_project_id_not_set" };
    if (!target) return { ok: false, reason: "project_id_not_set" };
    if (target === production) return { ok: false, reason: "preview_uses_production_project" };
    return { ok: true };
  }
  if (production && target && target === production) return { ok: false, reason: "preview_uses_production_project" };
  return { ok: true };
}

/** Vercel の Preview：uranai-preview と、そのサービスアカウントだけを許可する（値は加工せず、アプリが使う値そのもので比べる） */
function checkPreviewTarget(e: Env): FirestoreTargetCheck {
  const target = norm(e.FIREBASE_PROJECT_ID);
  const production = norm(e.PRODUCTION_FIREBASE_PROJECT_ID);
  if (!production) return { ok: false, reason: "production_project_id_not_set" };
  if (!target) return { ok: false, reason: "project_id_not_set" };
  if (target === production || target === PRODUCTION_FIREBASE_PROJECT_ID) return { ok: false, reason: "preview_uses_production_project" };
  if (e.FIREBASE_PROJECT_ID !== PREVIEW_FIREBASE_PROJECT_ID) return { ok: false, reason: "preview_project_not_allowed" };
  if (e.PRODUCTION_FIREBASE_PROJECT_ID !== PRODUCTION_FIREBASE_PROJECT_ID) return { ok: false, reason: "preview_production_project_id_unexpected" };
  if (typeof e.FIREBASE_CLIENT_EMAIL !== "string" || !PREVIEW_SERVICE_ACCOUNT_RE.test(e.FIREBASE_CLIENT_EMAIL)) return { ok: false, reason: "preview_service_account_mismatch" };
  return { ok: true };
}

export const FIRESTORE_TARGET_MESSAGE: Record<FirestoreTargetBlockReason, string> = {
  preview_uses_production_project: "本番の Firebase プロジェクトに接続しようとしたため、データベースへのアクセスを停止しました（開発・テスト環境では別のプロジェクトを使ってください）。",
  production_project_id_not_set: "PRODUCTION_FIREBASE_PROJECT_ID が未設定のため、接続先が本番かどうか判定できません。安全のためデータベースへのアクセスを停止しました。",
  project_id_not_set: "FIREBASE_PROJECT_ID が未設定のため、データベースへのアクセスを停止しました。",
  preview_project_not_allowed: "Preview では Preview 用の Firebase プロジェクトにだけ接続できます。FIREBASE_PROJECT_ID が Preview 用のプロジェクトではないため、データベースへのアクセスを停止しました。",
  preview_production_project_id_unexpected: "PRODUCTION_FIREBASE_PROJECT_ID が本番のプロジェクトIDと一致しないため（登録の誤りの可能性）、安全のためデータベースへのアクセスを停止しました。",
  preview_service_account_mismatch: "FIREBASE_CLIENT_EMAIL が Preview 用のプロジェクトのサービスアカウントではないため、データベースへのアクセスを停止しました。",
};

export class FirestoreTargetBlockedError extends Error {
  readonly code = "firestore_target_blocked";
  constructor(readonly reason: FirestoreTargetBlockReason) {
    super(FIRESTORE_TARGET_MESSAGE[reason]);
    this.name = "FirestoreTargetBlockedError";
  }
}

/** 接続してはいけない場合は例外を投げる（データベースに接続する前に必ず呼ぶ） */
export function assertFirestoreTarget(e: Env = process.env): void {
  const r = checkFirestoreTarget(e);
  if (!r.ok) throw new FirestoreTargetBlockedError(r.reason);
}
