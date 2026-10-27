/**
 * Vercel のビルド（npm run vercel-build）・手動で PostgreSQL のマイグレーションを実行してよいか（環境変数だけで判定する。値は返さない）。
 *
 *  - Vercel の Preview（VERCEL_ENV=preview）… DATABASE_URL があっても実行しない。
 *      Preview は Firestore（uranai-preview）を使う。「All Environments」に登録した本番の DATABASE_URL が Preview のビルドに渡っても、
 *      本番の PostgreSQL にマイグレーションを適用しないため
 *  - DATABASE_URL が無い … 実行しない（以前からの動作）
 *  - それ以外（Vercel の本番・ローカルの開発など）… 以前どおり実行する
 * scripts/migrate.ts とテストから読み込めるよう、server-only・データベースに依存しない。
 */
type Env = Record<string, string | undefined>;

export type MigrationDecision = { run: true } | { run: false; reason: "vercel_preview" | "no_database_url" };

export function migrationDecision(e: Env = process.env): MigrationDecision {
  // 接続先の有無より先に、Preview かどうかを判定する（Preview では接続先を読まない）
  if ((e.VERCEL_ENV ?? "").trim().toLowerCase() === "preview") return { run: false, reason: "vercel_preview" };
  if (!e.DATABASE_URL) return { run: false, reason: "no_database_url" };
  return { run: true };
}

/** スキップしたときのログ（理由だけ。接続先などの値は含めない） */
export const MIGRATION_SKIP_MESSAGE: Record<Extract<MigrationDecision, { run: false }>["reason"], string> = {
  vercel_preview: "[migrate] Vercel Preview (VERCEL_ENV=preview); skipping migrations. DATABASE_URL is ignored on Preview (Preview uses Firestore)",
  no_database_url: "[migrate] DATABASE_URL is not set; skipping migrations",
};
