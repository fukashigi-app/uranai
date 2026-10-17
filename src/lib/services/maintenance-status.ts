import "server-only";
import { isFirestore } from "@/lib/data-provider";
import type { MaintenanceRun } from "@/lib/firestore/misc";

/**
 * 定期処理（/api/cron/maintenance）の実行状況。
 * Firestore では system/maintenance に「最終実行時刻・成功/失敗・失敗の種類・処理件数」だけを記録する（秘密情報・個人情報は保存しない）。
 * PostgreSQL では記録用のテーブルが無いため記録しない（Vercel のログで確認する）。データ構造は変更しない。
 */

/** 最後の成功からこの時間を過ぎたら「止まっている可能性」とみなす（毎日1回の実行＋余裕） */
export const MAINTENANCE_STALE_MS = 36 * 60 * 60 * 1000;

export type MaintenanceStatus =
  | { tracked: false }
  | { tracked: true; lastRunAt: Date | null; lastStatus: string | null; lastSuccessAt: Date | null; lastFailureAt: Date | null; lastErrorCode: string | null; stale: boolean };

export async function recordMaintenanceRun(run: MaintenanceRun, startedAt: Date, finishedAt = new Date()): Promise<void> {
  if (!isFirestore()) return;
  try {
    const { recordMaintenanceRun: fsRecord } = await import("@/lib/firestore/misc");
    await fsRecord(run, startedAt, finishedAt);
  } catch (e) {
    // 記録できなくても定期処理の結果は変えない
    console.error("[cron] failed to record maintenance status", (e as { code?: unknown })?.code ?? (e as Error)?.name ?? "error");
  }
}

export async function getMaintenanceStatus(now = new Date()): Promise<MaintenanceStatus> {
  if (!isFirestore()) return { tracked: false };
  const { getMaintenanceStatus: fsGet } = await import("@/lib/firestore/misc");
  const s = await fsGet();
  return { tracked: true, ...s, stale: !s.lastSuccessAt || now.getTime() - s.lastSuccessAt.getTime() > MAINTENANCE_STALE_MS };
}

/** エラーから記録・ログ用の短い識別子だけを取り出す（メッセージ本文や秘密情報は含めない） */
export function errorCodeOf(e: unknown): string {
  const code = (e as { code?: unknown })?.code;
  if (typeof code === "string" || typeof code === "number") return `code:${String(code)}`.slice(0, 80);
  const name = (e as Error)?.name;
  return (typeof name === "string" && name ? name : "error").slice(0, 80);
}
