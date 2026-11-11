/**
 * 定期処理（/api/cron/maintenance）を「段階ごと」に短い関数で実行するモード（Netlify など、関数の実行時間が60秒の環境用）。
 * Firestore・Stripe に依存しない純粋な処理（パラメータの解釈・時間の区切り・1日分の結果のまとめ）。
 *
 *  - `?phase=` が無い … 従来どおり、全段階を1回の呼び出しで実行する（Vercel・Cloud Run。動作は変えない）
 *  - `?phase=maintenance|webhookRecovery|recheckRecovery|paymentMonitor` … その段階だけを実行する
 *  - `?phase=notify` … 段階の処理はせず、各段階の直近の結果（system/cronPhaseRuns）をまとめて、運営者への通知と1日分の記録（system/cronRun）を行う
 *  - それ以外の値（空を含む）… 400（何も実行しない）
 *
 * 段階ごとの時間の区切り（呼び出しから。関数の実行時間の上限60秒の中に、応答・記録・ロックの解除の時間を残す）
 *  - 段階を始めてよいのは10秒まで（ロックの取得が遅れたとき）。段階を待つ上限40秒。全体の締め切り45秒
 *  - 段階の中の時間の区切り（メンテナンス・Webhook の復旧・再確認の回収・決済監視）は35秒（待つ上限より短くし、時間切れで中止せずに区切りよく終える）
 *  - 通知の段階：送信は10秒まで、開始から55秒までに終える
 *  - ロックの有効期限90秒（関数が強制終了されても、90秒後には次の段階が実行できる）。段階の間隔は2分以上あける
 */
import type { CronPhaseRecord, CronRunStatus } from "./cron-phases";
import { cronRunStatusOf } from "./cron-phases";

export const CRON_WORK_PHASES = ["maintenance", "webhookRecovery", "recheckRecovery", "paymentMonitor"] as const;
export type CronWorkPhase = (typeof CRON_WORK_PHASES)[number];
export type CronPhaseParam = CronWorkPhase | "notify";

export type CronModeChoice = { mode: "full" } | { mode: "phase"; phase: CronPhaseParam } | { mode: "invalid" };

/** `phase` のクエリの値を解釈する（完全一致だけ。前後の空白・大文字小文字の違いも不正として扱う） */
export function parseCronPhaseParam(v: string | null): CronModeChoice {
  if (v === null) return { mode: "full" };
  if ((CRON_WORK_PHASES as readonly string[]).includes(v) || v === "notify") return { mode: "phase", phase: v as CronPhaseParam };
  return { mode: "invalid" };
}

export const CRON_PHASE_MODE = {
  lockTtlMs: 90 * 1000,
  startNotAfterMs: 10 * 1000,
  maxMs: 40 * 1000,
  hardDeadlineMs: 45 * 1000,
  innerDeadlineMs: 35 * 1000,
  notifyMaxMs: 10 * 1000,
  notifyFinishByMs: 55 * 1000,
  /** 通知の段階で、この時間より古い段階の結果は「今日は実行されなかった」として扱う */
  resultMaxAgeMs: 23 * 60 * 60 * 1000,
} as const;

/** 保存された段階の結果（system/cronPhaseRuns。firestore/cron-run.ts の CronPhaseRunEntry と同じ形） */
export type StoredCronPhaseResult = {
  status: CronPhaseRecord["status"];
  reason: CronPhaseRecord["reason"];
  errorCode: string | null;
  startedAt: Date;
  finishedAt: Date;
  durationMs: number;
  abortSettled: boolean | null;
  detail: Record<string, unknown> | null;
};

export type CronPaymentMonitorLike = { status: string; found: number | null; uncheckedCount: number | null; openReviews: number | null; stripeMode: "test" | "live" | null; finishedAt: Date | null };

export type ComposedDailyRun = {
  /** 1日分の開始の時刻（今日実行された段階のうち最も早い開始。1つも無ければ now） */
  startedAt: Date;
  phases: CronPhaseRecord[];
  status: CronRunStatus;
  unsettled: boolean;
  maintenanceOk: boolean;
  webhookRecovery: unknown;
  recheckRecovery: unknown;
  paymentMonitor: CronPaymentMonitorLike;
};

const EMPTY_MONITOR = { found: null, uncheckedCount: null, openReviews: null, stripeMode: null, finishedAt: null } as const;

/**
 * 各段階の直近の結果から、1日分の定期処理の結果を組み立てる（通知・system/cronRun の記録に使う）。
 * 結果が無い・古すぎる段階は「開始してよい時刻を過ぎて始めなかった」（skipped: deadline）として扱う（実行されなかったことを通知で分かるようにする）。
 */
export function composeDailyRun(stored: Partial<Record<string, StoredCronPhaseResult>>, now: Date, maxAgeMs: number = CRON_PHASE_MODE.resultMaxAgeMs): ComposedDailyRun {
  const fresh = (name: CronWorkPhase): StoredCronPhaseResult | null => {
    const r = stored[name];
    if (!r) return null;
    const age = now.getTime() - r.startedAt.getTime();
    return age >= 0 && age <= maxAgeMs ? r : null;
  };
  const present = CRON_WORK_PHASES.map(fresh).filter((r): r is StoredCronPhaseResult => r !== null);
  const startedAt = present.length ? new Date(Math.min(...present.map((r) => r.startedAt.getTime()))) : now;
  const phases: CronPhaseRecord[] = CRON_WORK_PHASES.map((name) => {
    const r = fresh(name);
    if (!r) return { name, status: "skipped", reason: "deadline", errorCode: null, startedAtMs: null, durationMs: 0, abortSettled: null };
    return { name, status: r.status, reason: r.reason, errorCode: r.errorCode, startedAtMs: r.startedAt.getTime() - startedAt.getTime(), durationMs: r.durationMs, abortSettled: r.abortSettled };
  });
  const status = cronRunStatusOf({ phases, timedOut: phases.some((p) => p.status === "timed_out"), lockLost: phases.some((p) => p.reason === "lock_lost") });
  const unsettled = phases.some((p) => p.status === "timed_out" && p.abortSettled === false);

  const detailOr = (name: CronWorkPhase, phase: CronPhaseRecord): unknown => {
    if (phase.status === "timed_out") return { status: "timed_out" };
    if (phase.status === "skipped") return { status: "skipped", reason: phase.reason };
    return fresh(name)?.detail ?? { status: phase.status === "ok" ? "ok" : "failed" };
  };
  const byName = (n: CronWorkPhase) => phases.find((p) => p.name === n)!;

  const pm = byName("paymentMonitor");
  const pmDetail = fresh("paymentMonitor")?.detail ?? null;
  let paymentMonitor: CronPaymentMonitorLike;
  if (pm.status === "timed_out") paymentMonitor = { status: "timed_out", ...EMPTY_MONITOR };
  else if (pm.status === "skipped" && pm.reason === "deadline") paymentMonitor = { status: "skipped_time", ...EMPTY_MONITOR };
  else if (pm.status === "skipped" && pm.reason === "lock_lost") paymentMonitor = { status: "skipped_lock_lost", ...EMPTY_MONITOR };
  else if (pmDetail && typeof pmDetail.status === "string") {
    paymentMonitor = {
      status: pmDetail.status,
      found: typeof pmDetail.found === "number" ? pmDetail.found : null,
      uncheckedCount: typeof pmDetail.uncheckedCount === "number" ? pmDetail.uncheckedCount : null,
      openReviews: typeof pmDetail.openReviews === "number" ? pmDetail.openReviews : null,
      stripeMode: pmDetail.stripeMode === "test" || pmDetail.stripeMode === "live" ? pmDetail.stripeMode : null,
      finishedAt: pmDetail.finishedAt instanceof Date ? pmDetail.finishedAt : null,
    };
  } else paymentMonitor = { status: pm.status === "ok" ? "ok" : "failed", ...EMPTY_MONITOR };

  return {
    startedAt,
    phases,
    status,
    unsettled,
    maintenanceOk: byName("maintenance").status === "ok",
    webhookRecovery: detailOr("webhookRecovery", byName("webhookRecovery")),
    recheckRecovery: detailOr("recheckRecovery", byName("recheckRecovery")),
    paymentMonitor,
  };
}
