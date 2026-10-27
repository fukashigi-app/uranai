import "dotenv/config";
import { migrationDecision, MIGRATION_SKIP_MESSAGE } from "../src/lib/db/migration-guard";

/**
 * マイグレーション適用（冪等）。Vercel のビルド時（npm run vercel-build）にも実行される。
 * Vercel の Preview・DATABASE_URL が無い環境ではスキップする（判定は src/lib/db/migration-guard.ts）。
 * 判定はデータベースのクライアントを読み込む前に行い、スキップするときは接続しない。
 */
async function main() {
  const decision = migrationDecision(process.env);
  if (!decision.run) {
    console.warn(MIGRATION_SKIP_MESSAGE[decision.reason]);
    return;
  }
  const url = process.env.DATABASE_URL!;
  const [{ drizzle }, { migrate }, { Pool }, { poolConfig }] = await Promise.all([
    import("drizzle-orm/node-postgres"),
    import("drizzle-orm/node-postgres/migrator"),
    import("pg"),
    import("../src/lib/db/connection"),
  ]);
  const pool = new Pool(poolConfig(url, 1));
  await migrate(drizzle(pool), { migrationsFolder: "./drizzle" });
  await pool.end();
  console.log("[migrate] migrations applied");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
