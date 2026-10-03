import "server-only";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema";
import { env } from "@/lib/env";
import { poolConfig } from "./connection";

type DB = NodePgDatabase<typeof schema>;

const globalForDb = globalThis as unknown as { __uranaiPool?: Pool; __uranaiDb?: DB };

function create(): DB {
  const url = env().DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set (PostgreSQL is not configured)");
  const pool =
    globalForDb.__uranaiPool ??
    new Pool(poolConfig(url, Number(process.env.DB_POOL_MAX ?? 5)));
  globalForDb.__uranaiPool = pool;
  return drizzle(pool, { schema });
}

export function db(): DB {
  if (!globalForDb.__uranaiDb) globalForDb.__uranaiDb = create();
  return globalForDb.__uranaiDb;
}

export type Tx = Parameters<Parameters<DB["transaction"]>[0]>[0];
export { schema };
