import "server-only";
import { isFirestore } from "@/lib/data-provider";
import type { CronPhaseRunEntry, CronRunRecord } from "@/lib/firestore/cron-run";

/**
 * 定期処理全体の排他制御と実行の記録の入口（firestore/cron-run.ts）。
 * PostgreSQL（以前の構成）には記録用の仕組みが無いので、ロック・記録をせずに今までどおり実行する（unsupported）。
 */
export type CronLockOutcome = { status: "acquired"; ownerId: string; tookOverExpired: boolean } | { status: "busy"; heldUntil: Date | null } | { status: "unsupported" } | { status: "failed"; errorName: string };

/** ttlMs … ロックの有効期限（省略時は従来どおり CRON_LOCK_TTL_MS。段階ごとの短い実行では短くする） */
export async function acquireCronRunLock(now: Date, ttlMs?: number): Promise<CronLockOutcome> {
  if (!isFirestore()) return { status: "unsupported" };
  try {
    const { acquireCronLock } = await import("@/lib/firestore/cron-run");
    const r = await acquireCronLock(now, ttlMs);
    return r.ok ? { status: "acquired", ownerId: r.ownerId, tookOverExpired: r.tookOverExpired } : { status: "busy", heldUntil: r.heldUntil };
  } catch (e) {
    return { status: "failed", errorName: ((e as Error)?.name || "Error").slice(0, 60) };
  }
}

export async function stillCronRunOwner(ownerId: string): Promise<boolean> {
  const { isCronLockOwner } = await import("@/lib/firestore/cron-run");
  return isCronLockOwner(ownerId);
}

/** 解除の失敗は例外にしない（期限で外れる） */
export async function releaseCronRunLock(ownerId: string): Promise<void> {
  try {
    const { releaseCronLock } = await import("@/lib/firestore/cron-run");
    await releaseCronLock(ownerId);
  } catch (e) {
    console.error("[cron] lock release failed", { error: (e as Error)?.name });
  }
}

/** 記録の失敗は例外にしない（定期処理の結果は変えない） */
export async function recordCronRunResult(ownerId: string, r: CronRunRecord): Promise<void> {
  try {
    const { recordCronRun } = await import("@/lib/firestore/cron-run");
    await recordCronRun(ownerId, r);
  } catch (e) {
    console.error("[cron] failed to record cron run", { error: (e as Error)?.name });
  }
}

/**
 * 段階ごとの実行（/api/cron/maintenance?phase=…）の結果の記録（system/cronPhaseRuns）。失敗は例外にしない（定期処理の結果は変えない）。
 * PostgreSQL（以前の構成）では記録しない。
 */
export async function recordCronPhaseResult(phase: string, entry: CronPhaseRunEntry): Promise<void> {
  if (!isFirestore()) return;
  try {
    const { recordCronPhaseRun } = await import("@/lib/firestore/cron-run");
    await recordCronPhaseRun(phase, entry);
  } catch (e) {
    console.error("[cron] failed to record cron phase run", { error: (e as Error)?.name });
  }
}

/** 段階ごとの実行の結果を読む（通知の段階で使う）。Firestore の失敗は例外（呼び出し側で扱う） */
export async function readCronPhaseResults(): Promise<Record<string, CronPhaseRunEntry>> {
  if (!isFirestore()) return {};
  const { readCronPhaseRuns } = await import("@/lib/firestore/cron-run");
  return readCronPhaseRuns();
}
