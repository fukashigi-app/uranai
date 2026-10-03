import "server-only";
import { isFirestore } from "@/lib/data-provider";
import * as fsMisc from "@/lib/firestore/misc";
import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { purgeOldRateLimits } from "@/lib/security/rate-limit";

/** 定期メンテナンス（期限切れ処理・不要データの削除）。冪等。 */
export async function runMaintenance() {
  if (isFirestore()) return fsMisc.runMaintenance();
  const d = db();
  const expiredSessions = await d.execute(sql`
    WITH s AS (
      UPDATE fortune_sessions SET status = 'EXPIRED'
      WHERE status = 'PAID' AND expires_at < now()
      RETURNING transaction_id
    )
    UPDATE transactions SET fortune_status = 'EXPIRED', updated_at = now()
    WHERE id IN (SELECT transaction_id FROM s) AND fortune_status = 'PENDING'
  `);
  const expiredCheckouts = await d.execute(sql`
    UPDATE checkouts SET status = 'EXPIRED', updated_at = now()
    WHERE status IN ('CREATED', 'FAILED') AND expires_at < now()
  `);
  // 課金されたか不明なまま放置された処理中（Charge IDなし）は失敗扱い
  await d.execute(sql`
    UPDATE checkouts SET status = 'FAILED', failure_code = 'stale_processing', updated_at = now()
    WHERE status = 'PROCESSING' AND provider_payment_id IS NULL AND processing_started_at < now() - interval '15 minutes'
  `);
  // プライバシー: 結果本文は30日、未決済の注文は7日で削除
  const purgedResults = await d.execute(sql`DELETE FROM fortune_results WHERE created_at < now() - interval '30 days'`);
  const purgedCheckouts = await d.execute(sql`
    DELETE FROM checkouts c
    WHERE c.status IN ('EXPIRED', 'FAILED', 'CREATED') AND c.created_at < now() - interval '7 days'
      AND NOT EXISTS (SELECT 1 FROM transactions t WHERE t.checkout_id = c.id)
  `);
  await d.execute(sql`DELETE FROM auth_sessions WHERE expires_at < now()`);
  await d.execute(sql`DELETE FROM webhook_events WHERE created_at < now() - interval '90 days' AND processed_at IS NOT NULL`);
  await purgeOldRateLimits();
  return {
    expiredSessions: expiredSessions.rowCount ?? 0,
    expiredCheckouts: expiredCheckouts.rowCount ?? 0,
    purgedResults: purgedResults.rowCount ?? 0,
    purgedCheckouts: purgedCheckouts.rowCount ?? 0,
  };
}
