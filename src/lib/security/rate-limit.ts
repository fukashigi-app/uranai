import "server-only";
import { sql } from "drizzle-orm";
import { db } from "@/lib/db";

/**
 * DBベースの固定ウィンドウRate Limit（サーバーレスの複数インスタンスでも有効）。
 * @returns 許可されれば true
 */
export async function rateLimit(key: string, limit: number, windowSec: number): Promise<boolean> {
  const windowMs = windowSec * 1000;
  const windowStart = new Date(Math.floor(Date.now() / windowMs) * windowMs);
  const res = await db().execute<{ count: number }>(sql`
    INSERT INTO rate_limits (key, window_start, count)
    VALUES (${key}, ${windowStart.toISOString()}, 1)
    ON CONFLICT (key, window_start) DO UPDATE SET count = rate_limits.count + 1
    RETURNING count
  `);
  const count = Number(res.rows[0]?.count ?? 0);
  return count <= limit;
}

export async function purgeOldRateLimits(): Promise<void> {
  await db().execute(sql`DELETE FROM rate_limits WHERE window_start < now() - interval '1 day'`);
}
