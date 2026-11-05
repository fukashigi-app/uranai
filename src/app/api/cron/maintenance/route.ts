import { NextResponse } from "next/server";
import { env } from "@/lib/env";
import { safeEqual } from "@/lib/security/crypto";
import { runMaintenance } from "@/lib/services/maintenance";
import { errorCodeOf, recordMaintenanceRun } from "@/lib/services/maintenance-status";
import { runCronWebhookRecovery } from "@/lib/payments/webhook-recovery";
import { runCronRecheckRecovery } from "@/lib/payments/recheck-recovery";

import { acquireCronRunLock, recordCronRunResult, releaseCronRunLock, stillCronRunOwner } from "@/lib/services/cron-run";
import { cronRunStatusOf, runCronPhases, type CronPhase } from "@/lib/ops/cron-phases";

/**
 * 段階ごとの時間の区切り（定期処理の開始からの時間）。関数の実行時間の上限（maxDuration）は300秒。
 *  - メンテナンス … 最初に始める。中で件数・時間（60秒）を区切る（firestore/misc.ts）。待つのは最大120秒
 *  - Webhook の通知の自動の復旧 … 150秒までに始める（中で60秒を区切る）。待つのは最大120秒
 *  - 決済記録の再確認の自動の回収 … 180秒までに始める（中で同じ時刻を区切りとして渡す）。待つのは最大90秒
 *  - 全体 … 270秒を過ぎたら新しい段階を始めない（応答・記録・ロックの解除の時間を残す）
 */
const MAINTENANCE_NOT_AFTER_MS = 30 * 1000;
const MAINTENANCE_MAX_MS = 120 * 1000;
const WEBHOOK_RECOVERY_NOT_AFTER_MS = 150 * 1000;
const WEBHOOK_RECOVERY_MAX_MS = 120 * 1000;
/** 決済記録の再確認の自動の回収は、定期処理の開始からこの時間を過ぎたら新しい回収を始めない（maxDuration 300秒の中で、ほかの処理を待たせない） */
const RECHECK_RECOVERY_NOT_AFTER_MS = 180 * 1000;
const RECHECK_RECOVERY_MAX_MS = 90 * 1000;
export const CRON_HARD_DEADLINE_MS = 270 * 1000;

/**
 * 関数の実行時間の上限（秒）。Hobby プラン・Fluid Compute 有効の上限の300秒（Webhook と同じ。docs/preview-verification.md §11）。
 */
export const maxDuration = 300;

const NO_STORE = { "Cache-Control": "no-store" };

type MaintenanceOutcome = { ok: true; result: Record<string, number> } | { ok: false; errorCode: string };

/**
 * Vercel Cron 等から `Authorization: Bearer <CRON_SECRET>` で呼び出す。
 * CRON_SECRET が未設定なら常に 401（認証を弱めない）。未設定は /api/health と運営ダッシュボードで検知する。
 *
 * 処理は段階に分けて順に実行する（src/lib/ops/cron-phases.ts）：メンテナンス → Webhook の通知の自動の復旧 → 決済記録の再確認の自動の回収。
 *  - 1つの段階が失敗・時間切れでも、次の段階は実行する（全体の締め切りを過ぎたら、新しい段階は始めない）
 *  - 定期処理全体は同時に1つだけ（Firestore のロック。所有者の ID・有効期限つき）。実行中なら何もせず 200（cron_busy）、
 *    ロックを取れない（Firestore の失敗）なら何もせず 503
 *  - 段階ごとの結果（成功・失敗・時間切れ・スキップ・実行時間）は system/cronRun に記録する。メンテナンスの結果は今までどおり system/maintenance
 *  - 応答の状態コードはメンテナンスの結果で決める（今までどおり。復旧・回収の失敗では変えない）
 * 秘密鍵やリクエストヘッダーの値は出さない。決済の確定・返金・占い権利の処理は、各段階の既存の処理のまま（ここでは変えない）。
 */
export async function GET(req: Request) {
  const secret = env().CRON_SECRET;
  const auth = req.headers.get("authorization") ?? "";
  if (!secret || !safeEqual(auth, `Bearer ${secret}`)) {
    console.warn(`[cron] maintenance unauthorized (${secret ? "token mismatch" : "CRON_SECRET not configured"})`);
    return new NextResponse("unauthorized", { status: 401 });
  }
  const startedAt = new Date();
  const lock = await acquireCronRunLock(startedAt);
  if (lock.status === "busy") {
    console.warn("[cron] another run is in progress; skipped", { heldUntil: lock.heldUntil?.toISOString() ?? null });
    return NextResponse.json({ ok: true, skipped: "cron_busy" }, { headers: NO_STORE });
  }
  if (lock.status === "failed") {
    console.error("[cron] lock could not be acquired; nothing was run", { error: lock.errorName });
    return NextResponse.json({ ok: false, error: "cron_lock_failed" }, { status: 503, headers: NO_STORE });
  }
  const ownerId = lock.status === "acquired" ? lock.ownerId : null;
  if (lock.status === "acquired" && lock.tookOverExpired) console.warn("[cron] took over an expired lock (the previous run may have been stopped)");

  let maintenance: MaintenanceOutcome | null = null;
  let webhookRecovery: unknown = { status: "skipped", reason: "deadline" };
  let recheckRecovery: unknown = { status: "skipped", reason: "deadline" };

  const phases: CronPhase[] = [
    {
      name: "maintenance",
      startNotAfterMs: MAINTENANCE_NOT_AFTER_MS,
      maxMs: MAINTENANCE_MAX_MS,
      run: async () => {
        try {
          const result = await runMaintenance();
          maintenance = { ok: true, result };
          await recordMaintenanceRun({ ok: true, result }, startedAt);
          console.log("[cron] maintenance ok", { ...result, ms: Date.now() - startedAt.getTime() });
        } catch (e) {
          const errorCode = errorCodeOf(e);
          maintenance = { ok: false, errorCode };
          await recordMaintenanceRun({ ok: false, errorCode }, startedAt);
          // ログには原因の確認に必要な先頭1行だけ（記録には識別子だけを保存）
          console.error("[cron] maintenance failed", { errorCode, message: String((e as Error)?.message ?? "").split("\n")[0].slice(0, 200), ms: Date.now() - startedAt.getTime() });
          throw e;
        }
      },
    },
    {
      name: "webhookRecovery",
      startNotAfterMs: WEBHOOK_RECOVERY_NOT_AFTER_MS,
      maxMs: WEBHOOK_RECOVERY_MAX_MS,
      run: async () => {
        webhookRecovery = { status: "failed" };
        try {
          // Webhook の通知の自動の復旧（失敗してもメンテナンスの結果を変えない。結果はログと記録に残す）
          webhookRecovery = await runCronWebhookRecovery();
          console.log("[cron] webhook recovery", webhookRecovery);
        } catch (e) {
          console.error("[cron] webhook recovery failed", { errorCode: errorCodeOf(e) });
          throw e;
        }
      },
    },
    {
      name: "recheckRecovery",
      startNotAfterMs: RECHECK_RECOVERY_NOT_AFTER_MS,
      maxMs: RECHECK_RECOVERY_MAX_MS,
      run: async () => {
        recheckRecovery = { status: "failed" };
        try {
          // 決済記録の再確認の自動の回収（失敗してもメンテナンスの結果を変えない。結果はログと記録に残す）
          recheckRecovery = await runCronRecheckRecovery(new Date(startedAt.getTime() + RECHECK_RECOVERY_NOT_AFTER_MS));
          console.log("[cron] recheck recovery", recheckRecovery);
        } catch (e) {
          console.error("[cron] recheck recovery failed", { errorCode: errorCodeOf(e) });
          throw e;
        }
      },
    },
  ];

  const outcome = await runCronPhases(phases, {
    startedAt: startedAt.getTime(),
    hardDeadlineMs: CRON_HARD_DEADLINE_MS,
    ...(ownerId ? { stillOwner: () => stillCronRunOwner(ownerId) } : {}),
    errorCodeOf,
  });
  // 時間切れ・スキップの段階は、応答にもその状態を返す（成功・失敗は各段階が設定した結果のまま）
  for (const p of outcome.phases) {
    if (p.status !== "timed_out" && p.status !== "skipped") continue;
    const r = p.status === "timed_out" ? { status: "timed_out" } : { status: "skipped", reason: p.reason };
    if (p.name === "webhookRecovery") webhookRecovery = r;
    if (p.name === "recheckRecovery") recheckRecovery = r;
  }

  // メンテナンスが時間切れ・スキップで結果が無い：失敗として記録する（時間切れの処理が後で終われば、その結果で上書きされる）
  const m = maintenance as MaintenanceOutcome | null; // 段階の中で代入される（TypeScript の絞り込みは関数の中の代入を追わない）
  if (!m) {
    const mp = outcome.phases.find((p) => p.name === "maintenance");
    await recordMaintenanceRun({ ok: false, errorCode: mp?.status === "timed_out" ? "PhaseTimeout" : `skipped_${mp?.reason ?? "unknown"}` }, startedAt);
  }
  const finishedAt = new Date();
  const status = cronRunStatusOf(outcome);
  console.log("[cron] run finished", { status, ms: finishedAt.getTime() - startedAt.getTime(), phases: outcome.phases.map((p) => `${p.name}:${p.status}${p.reason ? `(${p.reason})` : ""}:${p.durationMs}ms`) });
  if (ownerId) {
    await recordCronRunResult(ownerId, { status, startedAt, finishedAt, phases: outcome.phases });
    // 時間切れの段階は裏で続いている可能性があるので、ロックは外さず期限（CRON_LOCK_TTL_MS）で外れるのを待つ
    if (!outcome.timedOut) await releaseCronRunLock(ownerId);
  }
  if (!m || !m.ok) return NextResponse.json({ ok: false, error: "maintenance_failed" }, { status: 500 });
  return NextResponse.json({ ...m.result, webhookRecovery, recheckRecovery });
}
