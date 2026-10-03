import "server-only";
import { isFirestore } from "@/lib/data-provider";
import * as fsMisc from "@/lib/firestore/misc";
import { sql } from "drizzle-orm";
import { db } from "@/lib/db";

/**
 * DBベースの固定ウィンドウRate Limit（サーバーレスの複数インスタンスでも有効）。
 * @returns 許可されれば true
 */
export async function rateLimit(key: string, limit: number, windowSec: number): Promise<boolean> {
  if (isFirestore()) return fsMisc.rateLimit(key, limit, windowSec);
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
  if (isFirestore()) return; // Firestore 版は runMaintenance 内で削除
  await db().execute(sql`DELETE FROM rate_limits WHERE window_start < now() - interval '1 day'`);
}
