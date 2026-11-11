import "server-only";
import { isFirestore } from "@/lib/data-provider";
import * as fsMisc from "@/lib/firestore/misc";
import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { purgeOldRateLimits } from "@/lib/security/rate-limit";

/** 定期メンテナンス（期限切れ処理・不要データの削除）。冪等。signal … 中止の合図（Firestore 版だけが確かめる） */
/**
 * opts.deadlineMs … メンテナンスの中の時間の区切り（Firestore 版。省略時は従来どおり MAINTENANCE_DEADLINE_MS）。
 * 定期処理を段階ごとに短い関数で実行するとき（/api/cron/maintenance?phase=…）に、関数の実行時間の上限より短くするために渡す
 */
export async function runMaintenance(signal?: AbortSignal, opts: { deadlineMs?: number } = {}) {
  if (isFirestore()) return fsMisc.runMaintenance(opts.deadlineMs ? { deadlineMs: opts.deadlineMs } : {}, Date.now, signal);
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
