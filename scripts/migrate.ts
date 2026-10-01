import "dotenv/config";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import { poolConfig } from "../src/lib/db/connection";

/**
 * マイグレーション適用（冪等）。Vercel のビルド時（npm run vercel-build）にも実行される。
 * DATABASE_URL が無い環境ではスキップする。
 */
async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.warn("[migrate] DATABASE_URL is not set; skipping migrations");
    return;
  }
  const pool = new Pool(poolConfig(url, 1));
  await migrate(drizzle(pool), { migrationsFolder: "./drizzle" });
  await pool.end();
  console.log("[migrate] migrations applied");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
