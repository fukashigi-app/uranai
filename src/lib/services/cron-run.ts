import "server-only";
import { isFirestore } from "@/lib/data-provider";
import type { CronRunRecord } from "@/lib/firestore/cron-run";

/**
 * 定期処理全体の排他制御と実行の記録の入口（firestore/cron-run.ts）。
 * PostgreSQL（以前の構成）には記録用の仕組みが無いので、ロック・記録をせずに今までどおり実行する（unsupported）。
 */
export type CronLockOutcome = { status: "acquired"; ownerId: string; tookOverExpired: boolean } | { status: "busy"; heldUntil: Date | null } | { status: "unsupported" } | { status: "failed"; errorName: string };

export async function acquireCronRunLock(now: Date): Promise<CronLockOutcome> {
  if (!isFirestore()) return { status: "unsupported" };
  try {
    const { acquireCronLock } = await import("@/lib/firestore/cron-run");
    const r = await acquireCronLock(now);
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
