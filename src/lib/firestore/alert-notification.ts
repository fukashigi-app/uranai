import "server-only";
import { FieldValue } from "firebase-admin/firestore";
import { C, fsdb, toDate } from "./admin";

/**
 * 運営者への通知の状態（system/alertNotification）。
 *  notifiedAlertIds / notifiedReviewIds … 通知済みの未確認の決済監視の異常・決済要確認の ID（今も未確認のものだけを残す）
 *  deletionDelayRuns                    … 保存期間の削除が、続けて上限で打ち切られた回数
 *  last*                                … 最後の通知の試行の結果（状態・エラーの種類・時刻。送信先の URL は保存しない）
 * 通知済みの ID は、送信に成功したときだけ進める（失敗したら次の定期処理で、同じ異常をもう一度通知する）。
 */
export type AlertNotificationState = { notifiedAlertIds: string[]; notifiedReviewIds: string[]; deletionDelayRuns: number; lastHeartbeatAt: Date | null };

/** 通知済みの ID を残す件数の上限（一覧が上限で切れたときに、読めなかった分の通知済みの記録を消さないため、一覧の上限より多く残す） */
export const NOTIFIED_IDS_MAX = 1000;

const ref = () => fsdb().collection(C.system).doc("alertNotification");
const ids = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").slice(0, NOTIFIED_IDS_MAX) : []);

export async function readAlertNotificationState(): Promise<AlertNotificationState> {
  const d = await ref().get();
  return {
    notifiedAlertIds: ids(d.get("notifiedAlertIds")),
    notifiedReviewIds: ids(d.get("notifiedReviewIds")),
    deletionDelayRuns: Number(d.get("deletionDelayRuns") ?? 0) || 0,
    lastHeartbeatAt: toDate(d.get("lastHeartbeatAt")),
  };
}

export async function writeAlertNotificationState(
  s: AlertNotificationState,
  meta: { at: Date; status: string; errorCode: string | null; sent: boolean; listsTruncated?: { alerts: boolean; reviews: boolean } },
): Promise<void> {
  await ref().set(
    {
      notifiedAlertIds: s.notifiedAlertIds.slice(0, NOTIFIED_IDS_MAX),
      notifiedReviewIds: s.notifiedReviewIds.slice(0, NOTIFIED_IDS_MAX),
      deletionDelayRuns: s.deletionDelayRuns,
      lastHeartbeatAt: s.lastHeartbeatAt,
      ...(meta.listsTruncated ? { lastListsTruncated: meta.listsTruncated } : {}),
      lastAttemptAt: meta.at,
      lastStatus: meta.status.slice(0, 40),
      lastErrorCode: meta.errorCode ? meta.errorCode.slice(0, 40) : null,
      ...(meta.sent ? { lastSentAt: meta.at } : {}),
      updatedAt: FieldValue.serverTimestamp(),
    },
    { merge: true },
  );
}

export type MaintenanceTaskSignal = { task: string; truncated: boolean; stoppedBy: "time" | "aborted" | "cap" | null; overdueFound: number };

/** 最後のメンテナンスの処理ごとの結果（system/maintenanceTasks。削除の遅れの判定に使う） */
export async function readMaintenanceTaskStats(): Promise<MaintenanceTaskSignal[]> {
  const d = await fsdb().collection(C.system).doc("maintenanceTasks").get();
  const t = d.get("lastTasks");
  if (!Array.isArray(t)) return [];
  return t
    .filter((x) => x && typeof x.task === "string")
    .map((x) => ({
      task: String(x.task),
      truncated: x.truncated === true,
      stoppedBy: x.stoppedBy === "time" || x.stoppedBy === "aborted" || x.stoppedBy === "cap" ? x.stoppedBy : null,
      overdueFound: typeof x.overdueFound === "number" && x.overdueFound > 0 ? Math.floor(x.overdueFound) : 0,
    }));
}

/** 定期処理の実行の履歴（system/cronRun の開始の時刻。記録が無ければ starts は空、since は null） */
export async function readCronRunHistory(): Promise<{ starts: Date[]; since: Date | null }> {
  const d = await fsdb().collection(C.system).doc("cronRun").get();
  const starts = (Array.isArray(d.get("recentStarts")) ? (d.get("recentStarts") as unknown[]) : []).map((v) => toDate(v)).filter((x): x is Date => x !== null);
  return { starts, since: toDate(d.get("recentStartsSince")) };
}
