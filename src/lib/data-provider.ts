/**
 * データの保存先の切り替え口。
 *
 *  - DB_PROVIDER=firestore / postgres で明示指定できる
 *  - 未指定なら FIREBASE_PROJECT_ID（または Firestore Emulator）が設定されていれば Firestore、
 *    それ以外は従来どおり PostgreSQL（DATABASE_URL）
 *
 * Vercel に Firebase の環境変数を登録するまでは従来どおりの動作になり、本番環境は壊れない。
 * Firestore での本番確認が済んだら PostgreSQL 側のコードを削除する予定。
 */
export type DataProvider = "firestore" | "postgres";

export function dataProvider(): DataProvider {
  const explicit = process.env.DB_PROVIDER;
  if (explicit === "firestore" || explicit === "postgres") return explicit;
  if (process.env.FIREBASE_PROJECT_ID || process.env.FIRESTORE_EMULATOR_HOST) return "firestore";
  return "postgres";
}

export const isFirestore = () => dataProvider() === "firestore";

/** データベースが設定されているか（テストモード等で DB 無しでも動かすための判定） */
export function hasDatabase(): boolean {
  return isFirestore() || Boolean(process.env.DATABASE_URL);
}
