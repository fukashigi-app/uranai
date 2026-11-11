import { NextResponse } from "next/server";
import { env } from "@/lib/env";
import { safeEqual } from "@/lib/security/crypto";
import { runMaintenance } from "@/lib/services/maintenance";
import { errorCodeOf, recordMaintenanceRun } from "@/lib/services/maintenance-status";
import { runCronWebhookRecovery } from "@/lib/payments/webhook-recovery";
import { runCronRecheckRecovery } from "@/lib/payments/recheck-recovery";

import { runPaymentMonitor } from "@/lib/payments/payment-monitor";
import { isFirestore } from "@/lib/data-provider";
import type { CronPaymentMonitorSummary } from "@/lib/firestore/cron-run";
import {
  acquireCronRunLock,
  readCronPhaseResults,
  recordCronPhaseResult,
  recordCronRunResult,
  releaseCronRunLock,
  stillCronRunOwner,
} from "@/lib/services/cron-run";
import { notifyCronLockFailure, notifyCronRun, type NotificationSummary } from "@/lib/services/alert-notification";
import { cronRunStatusOf, runCronPhases, type CronPhase, type CronRunOutcome } from "@/lib/ops/cron-phases";
import { composeDailyRun, CRON_PHASE_MODE, parseCronPhaseParam, type CronWorkPhase } from "@/lib/ops/cron-phase-mode";

/**
 * 段階ごとの時間の区切り（定期処理の開始からの時間）。関数の実行時間の上限（maxDuration）は300秒。
 *  - メンテナンス … 最初に始める。中で件数・時間（60秒）を区切る（firestore/misc.ts）。待つのは最大120秒
 *  - Webhook の通知の自動の復旧 … 150秒までに始める（中で60秒を区切る）。待つのは最大120秒
 *  - 決済記録の再確認の自動の回収 … 180秒までに始める（中で同じ時刻を区切りとして渡す）。待つのは最大90秒
 *  - 決済監視の点検 … 210秒までに始める（点検の中で45秒を区切る。payment-monitor.ts）。待つのは最大60秒（210＋60＝270秒に収まる）
 *  - 全体 … 270秒を過ぎたら新しい段階を始めない（応答・記録・ロックの解除の時間を残す）
 * 段階ごとの短い実行（?phase=…）の時間の区切りは lib/ops/cron-phase-mode.ts（CRON_PHASE_MODE）。
 */
const MAINTENANCE_NOT_AFTER_MS = 30 * 1000;
const MAINTENANCE_MAX_MS = 120 * 1000;
const WEBHOOK_RECOVERY_NOT_AFTER_MS = 150 * 1000;
const WEBHOOK_RECOVERY_MAX_MS = 120 * 1000;
/** 決済記録の再確認の自動の回収は、定期処理の開始からこの時間を過ぎたら新しい回収を始めない（maxDuration 300秒の中で、ほかの処理を待たせない） */
const RECHECK_RECOVERY_NOT_AFTER_MS = 180 * 1000;
const RECHECK_RECOVERY_MAX_MS = 90 * 1000;
const PAYMENT_MONITOR_NOT_AFTER_MS = 210 * 1000;
const PAYMENT_MONITOR_MAX_MS = 60 * 1000;
export const CRON_HARD_DEADLINE_MS = 270 * 1000;
/** 運営者への通知は、すべての段階の後に行う。開始からこの時間までに終える（応答の時間を残す） */
const NOTIFY_FINISH_BY_MS = 292 * 1000;
const NOTIFY_MAX_MS = 15 * 1000;

/**
 * 関数の実行時間の上限（秒）。Hobby プラン・Fluid Compute 有効の上限の300秒（Webhook と同じ。docs/preview-verification.md §11）。
 */
export const maxDuration = 300;

const NO_STORE = { "Cache-Control": "no-store" };

type MaintenanceOutcome = { ok: true; result: Record<string, number> } | { ok: false; errorCode: string };

/** 段階の処理が結果を書き込む場所（段階の中で代入する） */
type PhaseState = {
  maintenance: MaintenanceOutcome | null;
  webhookRecovery: unknown;
  recheckRecovery: unknown;
  paymentMonitor: CronPaymentMonitorSummary;
};

/** 段階ごとの時間の区切り。innerDeadlineMs … 段階の中の時間の区切り（省略＝各処理の従来の既定値。全段階の実行では渡さない） */
type PhaseBudgets = Record<CronWorkPhase, { startNotAfterMs: number; maxMs: number }> & { innerDeadlineMs?: number };

const FULL_RUN_BUDGETS: PhaseBudgets = {
  maintenance: { startNotAfterMs: MAINTENANCE_NOT_AFTER_MS, maxMs: MAINTENANCE_MAX_MS },
  webhookRecovery: { startNotAfterMs: WEBHOOK_RECOVERY_NOT_AFTER_MS, maxMs: WEBHOOK_RECOVERY_MAX_MS },
  recheckRecovery: { startNotAfterMs: RECHECK_RECOVERY_NOT_AFTER_MS, maxMs: RECHECK_RECOVERY_MAX_MS },
  paymentMonitor: { startNotAfterMs: PAYMENT_MONITOR_NOT_AFTER_MS, maxMs: PAYMENT_MONITOR_MAX_MS },
};

const SINGLE_PHASE = { startNotAfterMs: CRON_PHASE_MODE.startNotAfterMs, maxMs: CRON_PHASE_MODE.maxMs };
const PHASE_MODE_BUDGETS: PhaseBudgets = {
  maintenance: SINGLE_PHASE,
  webhookRecovery: SINGLE_PHASE,
  recheckRecovery: SINGLE_PHASE,
  paymentMonitor: SINGLE_PHASE,
  innerDeadlineMs: CRON_PHASE_MODE.innerDeadlineMs,
};

const emptyMonitor = { found: null, uncheckedCount: null, openReviews: null, stripeMode: null, finishedAt: null };

function newPhaseState(): PhaseState {
  return {
    maintenance: null,
    webhookRecovery: { status: "skipped", reason: "deadline" },
    recheckRecovery: { status: "skipped", reason: "deadline" },
    paymentMonitor: { status: "skipped_time", ...emptyMonitor },
  };
}

/** 段階の定義（全段階の実行・段階ごとの実行で共通。中身は各段階の既存の処理のまま） */
function buildPhases(startedAt: Date, b: PhaseBudgets, st: PhaseState): CronPhase[] {
  const inner = b.innerDeadlineMs;
  return [
    {
      name: "maintenance",
      ...b.maintenance,
      run: async (signal) => {
        try {
          const result = inner ? await runMaintenance(signal, { deadlineMs: inner }) : await runMaintenance(signal);
          st.maintenance = { ok: true, result };
          // 中止の合図の後に終わった（時間切れ）：途中までの結果なので成功とは記録しない（下で時間切れの失敗として記録する）
          if (signal.aborted) return;
          await recordMaintenanceRun({ ok: true, result }, startedAt);
          console.log("[cron] maintenance ok", { ...result, ms: Date.now() - startedAt.getTime() });
        } catch (e) {
          const errorCode = errorCodeOf(e);
          st.maintenance = { ok: false, errorCode };
          await recordMaintenanceRun({ ok: false, errorCode }, startedAt);
          // ログには原因の確認に必要な先頭1行だけ（記録には識別子だけを保存）
          console.error("[cron] maintenance failed", { errorCode, message: String((e as Error)?.message ?? "").split("\n")[0].slice(0, 200), ms: Date.now() - startedAt.getTime() });
          throw e;
        }
      },
    },
    {
      name: "webhookRecovery",
      ...b.webhookRecovery,
      run: async (signal) => {
        st.webhookRecovery = { status: "failed" };
        try {
          // Webhook の通知の自動の復旧（失敗してもメンテナンスの結果を変えない。結果はログと記録に残す）
          st.webhookRecovery = inner ? await runCronWebhookRecovery(signal, { deadlineMs: inner }) : await runCronWebhookRecovery(signal);
          console.log("[cron] webhook recovery", st.webhookRecovery);
        } catch (e) {
          console.error("[cron] webhook recovery failed", { errorCode: errorCodeOf(e) });
          throw e;
        }
      },
    },
    {
      name: "recheckRecovery",
      ...b.recheckRecovery,
      run: async (signal) => {
        st.recheckRecovery = { status: "failed" };
        try {
          // 決済記録の再確認の自動の回収（失敗してもメンテナンスの結果を変えない。結果はログと記録に残す）
          st.recheckRecovery = inner
            ? await runCronRecheckRecovery(new Date(startedAt.getTime() + inner), signal)
            : await runCronRecheckRecovery(new Date(startedAt.getTime() + RECHECK_RECOVERY_NOT_AFTER_MS), signal);
          console.log("[cron] recheck recovery", st.recheckRecovery);
        } catch (e) {
          console.error("[cron] recheck recovery failed", { errorCode: errorCodeOf(e) });
          throw e;
        }
      },
    },
    {
      name: "paymentMonitor",
      ...b.paymentMonitor,
      run: async () => {
        // 決済監視は Firestore だけに対応（以前の PostgreSQL の構成では点検しない）
        if (!isFirestore()) {
          st.paymentMonitor = { status: "unsupported", ...emptyMonitor };
          return { skipped: "unsupported" };
        }
        st.paymentMonitor = { status: "failed", ...emptyMonitor };
        try {
          const r = inner ? await runPaymentMonitor({ source: "cron", limits: { deadlineMs: inner } }) : await runPaymentMonitor({ source: "cron" });
          if (!r.started) {
            if (r.reason === "busy") {
              st.paymentMonitor = { status: "busy", ...emptyMonitor };
              console.warn("[cron] payment monitor is already running; skipped", { source: r.source });
              return { skipped: "busy" };
            }
            st.paymentMonitor = { status: "lock_failed", ...emptyMonitor };
            throw Object.assign(new Error("payment monitor lock could not be acquired"), { name: "MonitorLockFailed" });
          }
          const rep = r.report;
          st.paymentMonitor = { status: rep.result, found: rep.found, uncheckedCount: rep.unchecked.length, openReviews: rep.openReviews, stripeMode: rep.stripeMode, finishedAt: new Date() };
          console.log("[cron] payment monitor", { result: rep.result, found: rep.found, unchecked: rep.unchecked.length });
          // 点検の手順がすべて失敗した：段階としても失敗にする（点検の記録は点検の側が残している）
          if (rep.result === "failed") throw Object.assign(new Error("payment monitor checks failed"), { name: "MonitorChecksFailed" });
        } catch (e) {
          console.error("[cron] payment monitor failed", { errorCode: errorCodeOf(e) });
          throw e;
        }
      },
    },
  ];
}

/** 時間切れ・スキップの段階は、結果にもその状態を反映する（成功・失敗は各段階が設定した結果のまま） */
function applySkips(outcome: CronRunOutcome, st: PhaseState): void {
  for (const p of outcome.phases) {
    if (p.status !== "timed_out" && p.status !== "skipped") continue;
    const r = p.status === "timed_out" ? { status: "timed_out" } : { status: "skipped", reason: p.reason };
    if (p.name === "webhookRecovery") st.webhookRecovery = r;
    if (p.name === "recheckRecovery") st.recheckRecovery = r;
    // 決済監視が実行されなかった・終わらなかった理由（busy・unsupported は段階の中で設定済み）
    if (p.name === "paymentMonitor" && (p.status === "timed_out" || p.reason === "deadline" || p.reason === "lock_lost")) {
      st.paymentMonitor = { ...st.paymentMonitor, status: p.status === "timed_out" ? "timed_out" : p.reason === "deadline" ? "skipped_time" : "skipped_lock_lost", finishedAt: null };
    }
  }
}

/** メンテナンスの時間切れ・スキップは失敗として記録する（途中で結果が出ていても成功とは記録しない） */
async function recordMaintenanceSkip(outcome: CronRunOutcome, startedAt: Date): Promise<void> {
  const mp = outcome.phases.find((p) => p.name === "maintenance");
  if (mp?.status === "timed_out" || mp?.status === "skipped") {
    await recordMaintenanceRun({ ok: false, errorCode: mp.status === "timed_out" ? "PhaseTimeout" : `skipped_${mp.reason ?? "unknown"}` }, startedAt);
  }
}

/**
 * Vercel Cron 等から `Authorization: Bearer <CRON_SECRET>` で呼び出す。
 * CRON_SECRET が未設定なら常に 401（認証を弱めない）。未設定は /api/health と運営ダッシュボードで検知する。
 *
 * 処理は段階に分けて順に実行する（src/lib/ops/cron-phases.ts）：メンテナンス → Webhook の通知の自動の復旧 → 決済記録の再確認の自動の回収 → 決済監視の点検。
 * すべての段階の後に、運営者に異常を通知する（Discord。src/lib/services/alert-notification.ts。送信先は OPS_ALERT_WEBHOOK_URL。結果は system/cronRun）。
 * 決済監視の点検は読み取りと異常の記録だけ（決済の確定・返金・再決済はしない）。点検のロック（system/paymentMonitorLock）は今までどおりで、
 * 運営画面の「今すぐ点検」と重なったら開始しない（busy として、正常の実行と区別して記録する）。
 *  - 1つの段階が失敗・時間切れでも、次の段階は実行する（全体の締め切りを過ぎたら、新しい段階は始めない）
 *  - 時間切れの段階には中止の合図を送る（メンテナンスはページ・書き込みのまとまりごと、復旧・回収は1件ごとに確かめ、新しい処理を始めない）
 *  - 定期処理全体は同時に1つだけ（Firestore のロック。所有者の ID・有効期限つき）。実行中なら何もせず 200（cron_busy）、
 *    ロックを取れない（Firestore の失敗）なら何もせず 503
 *  - 段階ごとの結果（成功・失敗・時間切れ・スキップ・実行時間）は system/cronRun に記録する。メンテナンスの結果は今までどおり system/maintenance
 *  - 応答の状態コードはメンテナンスの結果で決める（今までどおり。復旧・回収の失敗では変えない）
 * `?phase=…` を付けたときは、段階ごとの短い実行（関数の実行時間が60秒の環境用。lib/ops/cron-phase-mode.ts）。付けなければ従来どおり。
 * 秘密鍵やリクエストヘッダーの値は出さない。決済の確定・返金・占い権利の処理は、各段階の既存の処理のまま（ここでは変えない）。
 */
export async function GET(req: Request) {
  const secret = env().CRON_SECRET;
  const auth = req.headers.get("authorization") ?? "";
  if (!secret || !safeEqual(auth, `Bearer ${secret}`)) {
    console.warn(`[cron] maintenance unauthorized (${secret ? "token mismatch" : "CRON_SECRET not configured"})`);
    return new NextResponse("unauthorized", { status: 401 });
  }
  const choice = parseCronPhaseParam(new URL(req.url).searchParams.get("phase"));
  if (choice.mode === "invalid") return NextResponse.json({ ok: false, error: "invalid_phase" }, { status: 400, headers: NO_STORE });
  if (choice.mode === "phase") return choice.phase === "notify" ? runNotifyPhase() : runSinglePhase(choice.phase);

  const startedAt = new Date();
  const lock = await acquireCronRunLock(startedAt);
  if (lock.status === "busy") {
    console.warn("[cron] another run is in progress; skipped", { heldUntil: lock.heldUntil?.toISOString() ?? null });
    return NextResponse.json({ ok: true, skipped: "cron_busy" }, { headers: NO_STORE });
  }
  if (lock.status === "failed") {
    console.error("[cron] lock could not be acquired; nothing was run", { error: lock.errorName });
    // 運営者に知らせる（Firestore を使わない。失敗しても応答は変えない）
    const n = await notifyCronLockFailure({ timeoutMs: 8000 });
    console.log("[cron] notification", n);
    return NextResponse.json({ ok: false, error: "cron_lock_failed" }, { status: 503, headers: NO_STORE });
  }
  const ownerId = lock.status === "acquired" ? lock.ownerId : null;
  if (lock.status === "acquired" && lock.tookOverExpired) console.warn("[cron] took over an expired lock (the previous run may have been stopped)");

  const st = newPhaseState();
  const outcome = await runCronPhases(buildPhases(startedAt, FULL_RUN_BUDGETS, st), {
    startedAt: startedAt.getTime(),
    hardDeadlineMs: CRON_HARD_DEADLINE_MS,
    ...(ownerId ? { stillOwner: () => stillCronRunOwner(ownerId) } : {}),
    errorCodeOf,
  });
  applySkips(outcome, st);

  // メンテナンスの成否は段階の結果で決める（時間切れ・スキップは、途中で結果が出ていても失敗。成功とは記録しない）
  const m = st.maintenance;
  const mp = outcome.phases.find((p) => p.name === "maintenance");
  const maintenanceOk = mp?.status === "ok" && m?.ok === true;
  await recordMaintenanceSkip(outcome, startedAt);
  const status = cronRunStatusOf(outcome);
  // 運営者への通知（Discord）：すべての段階の後に、残りの時間の中で行う。失敗しても定期処理の結果・応答は変えない
  const remaining = NOTIFY_FINISH_BY_MS - (Date.now() - startedAt.getTime());
  const notification: NotificationSummary =
    remaining >= 2000
      ? await notifyCronRun(
          { runStatus: status, unsettled: outcome.unsettled, phases: outcome.phases, webhookRecovery: st.webhookRecovery, recheckRecovery: st.recheckRecovery, paymentMonitor: st.paymentMonitor, maintenanceOk, startedAt },
          { timeoutMs: Math.min(NOTIFY_MAX_MS, remaining) },
        )
      : { status: "skipped_time", issues: 0, newAlerts: 0, newReviews: 0, errorCode: null };
  console.log("[cron] notification", notification);
  const finishedAt = new Date();
  console.log("[cron] run finished", { status, ms: finishedAt.getTime() - startedAt.getTime(), phases: outcome.phases.map((p) => `${p.name}:${p.status}${p.reason ? `(${p.reason})` : ""}:${p.durationMs}ms`) });
  if (ownerId) {
    await recordCronRunResult(ownerId, { status, startedAt, finishedAt, phases: outcome.phases, paymentMonitor: st.paymentMonitor, notification });
    // 中止の合図の後も止まらなかった段階は裏で続いている可能性があるので、ロックは外さず期限（CRON_LOCK_TTL_MS）で外れるのを待つ。
    // 時間切れでも止まった（abortSettled）なら、続いている処理は無いので外す
    if (!outcome.unsettled) await releaseCronRunLock(ownerId);
  }
  if (!maintenanceOk || !m || !m.ok) return NextResponse.json({ ok: false, error: "maintenance_failed" }, { status: 500 });
  return NextResponse.json({ ...m.result, webhookRecovery: st.webhookRecovery, recheckRecovery: st.recheckRecovery, paymentMonitor: st.paymentMonitor });
}

/** 段階ごとの実行のロック（有効期限は短い。CRON_PHASE_MODE.lockTtlMs）。取れなければ応答を返す */
async function acquirePhaseLock(startedAt: Date, phase: string): Promise<{ ownerId: string | null } | { response: Response }> {
  const lock = await acquireCronRunLock(startedAt, CRON_PHASE_MODE.lockTtlMs);
  if (lock.status === "busy") {
    console.warn("[cron] another run is in progress; phase skipped", { phase, heldUntil: lock.heldUntil?.toISOString() ?? null });
    return { response: NextResponse.json({ ok: true, phase, skipped: "cron_busy" }, { headers: NO_STORE }) };
  }
  if (lock.status === "failed") {
    console.error("[cron] lock could not be acquired; phase was not run", { phase, error: lock.errorName });
    const n = await notifyCronLockFailure({ timeoutMs: 8000 });
    console.log("[cron] notification", n);
    return { response: NextResponse.json({ ok: false, phase, error: "cron_lock_failed" }, { status: 503, headers: NO_STORE }) };
  }
  if (lock.status === "acquired" && lock.tookOverExpired) console.warn("[cron] took over an expired lock (the previous run may have been stopped)", { phase });
  return { ownerId: lock.status === "acquired" ? lock.ownerId : null };
}

/** 1つの段階だけを実行する（?phase=maintenance|webhookRecovery|recheckRecovery|paymentMonitor）。結果は system/cronPhaseRuns に記録し、通知は notify の段階でまとめて行う */
async function runSinglePhase(phase: CronWorkPhase): Promise<Response> {
  const startedAt = new Date();
  const lock = await acquirePhaseLock(startedAt, phase);
  if ("response" in lock) return lock.response;
  const { ownerId } = lock;

  const st = newPhaseState();
  const phases = buildPhases(startedAt, PHASE_MODE_BUDGETS, st).filter((p) => p.name === phase);
  const outcome = await runCronPhases(phases, {
    startedAt: startedAt.getTime(),
    hardDeadlineMs: CRON_PHASE_MODE.hardDeadlineMs,
    ...(ownerId ? { stillOwner: () => stillCronRunOwner(ownerId) } : {}),
    errorCodeOf,
  });
  applySkips(outcome, st);
  await recordMaintenanceSkip(outcome, startedAt);
  const rec = outcome.phases[0];
  const finishedAt = new Date();
  const detail = phase === "webhookRecovery" ? st.webhookRecovery : phase === "recheckRecovery" ? st.recheckRecovery : phase === "paymentMonitor" ? st.paymentMonitor : null;
  await recordCronPhaseResult(phase, {
    status: rec.status,
    reason: rec.reason,
    errorCode: rec.errorCode,
    startedAt,
    finishedAt,
    durationMs: rec.durationMs,
    abortSettled: rec.abortSettled,
    detail: detail && typeof detail === "object" ? (detail as Record<string, unknown>) : null,
  });
  console.log("[cron] phase finished", { phase, status: rec.status, reason: rec.reason, ms: finishedAt.getTime() - startedAt.getTime() });
  // 中止の合図の後も止まらなかったときは、ロックを外さず期限（CRON_PHASE_MODE.lockTtlMs）で外れるのを待つ
  if (ownerId && !outcome.unsettled) await releaseCronRunLock(ownerId);

  const ok = rec.status === "ok" || (rec.status === "skipped" && (rec.reason === "busy" || rec.reason === "unsupported"));
  if (phase === "maintenance") {
    const m = st.maintenance;
    if (!ok || !m || !m.ok) return NextResponse.json({ ok: false, phase, status: rec.status, error: "maintenance_failed" }, { status: 500, headers: NO_STORE });
    return NextResponse.json({ ok: true, phase, status: rec.status, ...m.result }, { headers: NO_STORE });
  }
  return NextResponse.json({ ok, phase, status: rec.status, ...(rec.reason ? { reason: rec.reason } : {}), result: detail }, { status: ok ? 200 : 500, headers: NO_STORE });
}

/** 通知の段階（?phase=notify）：各段階の直近の結果をまとめ、運営者への通知と1日分の記録（system/cronRun）を行う。段階の処理はしない */
async function runNotifyPhase(): Promise<Response> {
  const startedAt = new Date();
  const lock = await acquirePhaseLock(startedAt, "notify");
  if ("response" in lock) return lock.response;
  const { ownerId } = lock;

  let stored;
  try {
    stored = await readCronPhaseResults();
  } catch (e) {
    console.error("[cron] phase results could not be read; notification skipped", { error: errorCodeOf(e) });
    if (ownerId) await releaseCronRunLock(ownerId);
    return NextResponse.json({ ok: false, phase: "notify", error: "phase_results_unavailable" }, { status: 503, headers: NO_STORE });
  }
  const day = composeDailyRun(stored, startedAt);
  const remaining = CRON_PHASE_MODE.notifyFinishByMs - (Date.now() - startedAt.getTime());
  const notification: NotificationSummary =
    remaining >= 2000
      ? await notifyCronRun(
          {
            runStatus: day.status,
            unsettled: day.unsettled,
            phases: day.phases,
            webhookRecovery: day.webhookRecovery,
            recheckRecovery: day.recheckRecovery,
            paymentMonitor: day.paymentMonitor,
            maintenanceOk: day.maintenanceOk,
            startedAt: day.startedAt,
          },
          { timeoutMs: Math.min(CRON_PHASE_MODE.notifyMaxMs, remaining) },
        )
      : { status: "skipped_time", issues: 0, newAlerts: 0, newReviews: 0, errorCode: null };
  console.log("[cron] notification", notification);
  const finishedAt = new Date();
  console.log("[cron] daily run summarized", { status: day.status, phases: day.phases.map((p) => `${p.name}:${p.status}${p.reason ? `(${p.reason})` : ""}`) });
  if (ownerId) {
    await recordCronRunResult(ownerId, { status: day.status, startedAt: day.startedAt, finishedAt, phases: day.phases, paymentMonitor: day.paymentMonitor, notification });
    await releaseCronRunLock(ownerId);
  }
  return NextResponse.json({ ok: true, phase: "notify", status: day.status, notification: { status: notification.status } }, { headers: NO_STORE });
}
