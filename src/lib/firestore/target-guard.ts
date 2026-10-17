/**
 * Firestore の接続先の安全確認（Preview から本番の Firebase プロジェクトに接続させない）。
 *
 *  - Firestore Emulator（FIRESTORE_EMULATOR_HOST）… 本番には接続しないので常に許可
 *  - Vercel の Preview / Development … PRODUCTION_FIREBASE_PROJECT_ID（本番のプロジェクトID）が必須。
 *      接続先（FIREBASE_PROJECT_ID）と一致したら停止。どちらかが未設定（判定できない）でも停止する
 *  - Vercel の Production … 本番のプロジェクトに接続するので許可（不一致は /api/health で警告）
 *  - ローカル（VERCEL_ENV なし）… PRODUCTION_FIREBASE_PROJECT_ID が設定されていて一致したら停止。未設定なら許可
 *
 * 判定に使うのは環境変数の値だけで、秘密鍵には触れない。プロジェクトIDはメッセージに含めない。
 * next.config やテストからも読み込めるよう、他のモジュールに依存しない。
 */
type Env = Record<string, string | undefined>;

export type FirestoreTargetCheck = { ok: true } | { ok: false; reason: "preview_uses_production_project" | "production_project_id_not_set" | "project_id_not_set" };

const norm = (v: string | undefined) => (v ?? "").trim().toLowerCase();

export function checkFirestoreTarget(e: Env = process.env): FirestoreTargetCheck {
  if (e.FIRESTORE_EMULATOR_HOST) return { ok: true };
  const target = norm(e.FIREBASE_PROJECT_ID);
  const production = norm(e.PRODUCTION_FIREBASE_PROJECT_ID);
  const env = e.VERCEL_ENV;
  if (env === "production") return { ok: true };
  if (env === "preview" || env === "development") {
    if (!production) return { ok: false, reason: "production_project_id_not_set" };
    if (!target) return { ok: false, reason: "project_id_not_set" };
    if (target === production) return { ok: false, reason: "preview_uses_production_project" };
    return { ok: true };
  }
  if (production && target && target === production) return { ok: false, reason: "preview_uses_production_project" };
  return { ok: true };
}

export const FIRESTORE_TARGET_MESSAGE: Record<Exclude<FirestoreTargetCheck, { ok: true }>["reason"], string> = {
  preview_uses_production_project: "本番の Firebase プロジェクトに接続しようとしたため、データベースへのアクセスを停止しました（開発・テスト環境では別のプロジェクトを使ってください）。",
  production_project_id_not_set: "PRODUCTION_FIREBASE_PROJECT_ID が未設定のため、接続先が本番かどうか判定できません。安全のためデータベースへのアクセスを停止しました。",
  project_id_not_set: "FIREBASE_PROJECT_ID が未設定のため、データベースへのアクセスを停止しました。",
};

export class FirestoreTargetBlockedError extends Error {
  readonly code = "firestore_target_blocked";
  constructor(readonly reason: Exclude<FirestoreTargetCheck, { ok: true }>["reason"]) {
    super(FIRESTORE_TARGET_MESSAGE[reason]);
    this.name = "FirestoreTargetBlockedError";
  }
}

/** 接続してはいけない場合は例外を投げる（データベースに接続する前に必ず呼ぶ） */
export function assertFirestoreTarget(e: Env = process.env): void {
  const r = checkFirestoreTarget(e);
  if (!r.ok) throw new FirestoreTargetBlockedError(r.reason);
}
