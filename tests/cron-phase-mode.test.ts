/**
 * 定期処理の段階ごとの実行（/api/cron/maintenance?phase=…。lib/ops/cron-phase-mode.ts）。
 *  - `phase` が無い：従来どおり全段階を1回で実行（呼び出しの引数・時間の区切り・記録・通知は変更前と同じ）
 *  - `phase=<段階>`：その段階だけ。60秒の関数に収まる時間の区切り（段階の中35秒・待つ上限40秒・全体45秒）。結果は段階ごとに記録し、通知はしない
 *  - `phase=notify`：段階の処理はせず、各段階の直近の結果をまとめて通知と1日分の記録を1回だけ行う
 *  - 不正な値は 400（何も実行しない・ロックも取らない）
 * Firestore・Stripe・通知は模擬。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { composeDailyRun, CRON_PHASE_MODE, parseCronPhaseParam, type StoredCronPhaseResult } from "@/lib/ops/cron-phase-mode";

const m = vi.hoisted(() => ({
  calls: [] as { fn: string; args: unknown[] }[],
  lock: { status: "acquired", ownerId: "owner-1", tookOverExpired: false } as Record<string, unknown>,
  stored: {} as Record<string, unknown>,
  readFails: false,
  phaseImpl: {} as Record<string, (...a: unknown[]) => Promise<unknown>>,
}));
const rec = (fn: string) => (...args: unknown[]) => {
  m.calls.push({ fn, args });
  const impl = m.phaseImpl[fn];
  return impl ? impl(...args) : undefined;
};

vi.mock("@/lib/env", () => ({ env: () => ({ CRON_SECRET: "cron-unit-test-secret" }) }));
vi.mock("@/lib/data-provider", () => ({ isFirestore: () => true }));
vi.mock("@/lib/services/maintenance", () => ({
  runMaintenance: async (...a: unknown[]) => (await rec("runMaintenance")(...a)) ?? { expiredSessions: 1 },
}));
vi.mock("@/lib/services/maintenance-status", () => ({
  errorCodeOf: (e: unknown) => (e as Error)?.name ?? "Error",
  recordMaintenanceRun: async (...a: unknown[]) => void rec("recordMaintenanceRun")(...a),
}));
vi.mock("@/lib/payments/webhook-recovery", () => ({
  runCronWebhookRecovery: async (...a: unknown[]) => (await rec("runCronWebhookRecovery")(...a)) ?? { status: "ok", scanned: 0, attempted: 0, deferred: 0, truncated: false, recovered: 0, failed: 0 },
}));
vi.mock("@/lib/payments/recheck-recovery", () => ({
  runCronRecheckRecovery: async (...a: unknown[]) => (await rec("runCronRecheckRecovery")(...a)) ?? { status: "ok", scanned: 0, attempted: 0, done: 0, pending: 0, rejected: 0, error: 0, deferred: 0 },
}));
vi.mock("@/lib/payments/payment-monitor", () => ({
  runPaymentMonitor: async (...a: unknown[]) =>
    (await rec("runPaymentMonitor")(...a)) ?? { started: true, report: { result: "ok", found: 0, unchecked: [], openReviews: 0, stripeMode: "test" } },
}));
vi.mock("@/lib/services/cron-run", () => ({
  acquireCronRunLock: async (...a: unknown[]) => {
    rec("acquireCronRunLock")(...a);
    return m.lock;
  },
  stillCronRunOwner: async () => true,
  releaseCronRunLock: async (...a: unknown[]) => void rec("releaseCronRunLock")(...a),
  recordCronRunResult: async (...a: unknown[]) => void rec("recordCronRunResult")(...a),
  recordCronPhaseResult: async (...a: unknown[]) => void rec("recordCronPhaseResult")(...a),
  readCronPhaseResults: async () => {
    rec("readCronPhaseResults")();
    if (m.readFails) throw Object.assign(new Error("x"), { name: "FirestoreUnavailable" });
    return m.stored;
  },
}));
vi.mock("@/lib/services/alert-notification", () => ({
  notifyCronRun: async (...a: unknown[]) => {
    rec("notifyCronRun")(...a);
    return { status: "sent", issues: 0, newAlerts: 0, newReviews: 0, errorCode: null };
  },
  notifyCronLockFailure: async () => ({ status: "sent" }),
}));

const AUTH = { authorization: "Bearer cron-unit-test-secret" };
const call = async (query = "", headers: Record<string, string> = AUTH) => {
  const { GET } = await import("@/app/api/cron/maintenance/route");
  return GET(new Request(`https://uranai.example.jp/api/cron/maintenance${query}`, { headers }));
};
const calledFns = () => m.calls.map((c) => c.fn);
const argsOf = (fn: string) => m.calls.filter((c) => c.fn === fn).map((c) => c.args);
const WORK = ["runMaintenance", "runCronWebhookRecovery", "runCronRecheckRecovery", "runPaymentMonitor"];

beforeEach(() => {
  m.calls.length = 0;
  m.lock = { status: "acquired", ownerId: "owner-1", tookOverExpired: false };
  m.stored = {};
  m.readFails = false;
  m.phaseImpl = {};
});
afterEach(() => vi.useRealTimers());

describe("パラメータの解釈", () => {
  it("無ければ全段階・段階の名前と notify は段階ごと・それ以外は不正", () => {
    expect(parseCronPhaseParam(null)).toEqual({ mode: "full" });
    for (const p of ["maintenance", "webhookRecovery", "recheckRecovery", "paymentMonitor", "notify"]) expect(parseCronPhaseParam(p)).toEqual({ mode: "phase", phase: p });
    for (const p of ["", " maintenance", "Maintenance", "all", "maintenance,notify", "../x"]) expect(parseCronPhaseParam(p), p).toEqual({ mode: "invalid" });
  });

  it("時間の区切りは60秒の関数に収まる（段階の中 < 待つ上限 < 全体の締め切り < 60秒。通知も60秒より前に終える）", () => {
    const c = CRON_PHASE_MODE;
    expect(c.innerDeadlineMs).toBeLessThan(c.maxMs);
    expect(c.maxMs).toBeLessThan(c.hardDeadlineMs);
    expect(c.hardDeadlineMs).toBeLessThan(60_000);
    expect(c.notifyFinishByMs).toBeLessThan(60_000);
    expect(c.lockTtlMs).toBeGreaterThan(60_000); // 関数が強制終了されても、その後に別の実行と重ならない
  });
});

describe("全段階の実行（phase なし）：変更前と同じ", () => {
  it("4段階を順に実行し、引数は変更前と同じ（段階の中の時間の区切りを渡さない・ロックの期限は既定）。通知と1日分の記録を1回ずつ", async () => {
    const t0 = Date.now();
    const res = await call();
    expect(res.status).toBe(200);
    expect(calledFns().filter((f) => WORK.includes(f))).toEqual(WORK);
    expect(argsOf("acquireCronRunLock")[0]).toHaveLength(1); // ttl を渡さない（CRON_LOCK_TTL_MS のまま）
    expect(argsOf("runMaintenance")[0]).toHaveLength(1); // signal だけ
    expect(argsOf("runCronWebhookRecovery")[0]).toHaveLength(1);
    expect(argsOf("runPaymentMonitor")[0]).toEqual([{ source: "cron" }]);
    const notAfter = argsOf("runCronRecheckRecovery")[0][0] as Date;
    expect(notAfter.getTime() - t0).toBeGreaterThanOrEqual(180_000 - 50);
    expect(notAfter.getTime() - t0).toBeLessThanOrEqual(180_000 + 1000);
    expect(argsOf("notifyCronRun")).toHaveLength(1);
    expect(argsOf("recordCronRunResult")).toHaveLength(1);
    expect(argsOf("recordCronPhaseResult")).toHaveLength(0);
    const body = (await res.json()) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(["expiredSessions", "paymentMonitor", "recheckRecovery", "webhookRecovery"]);
  });
});

describe("段階ごとの実行（phase=<段階>）", () => {
  it("phase=maintenance：メンテナンスだけ。段階の中35秒・ロック90秒。段階の結果を記録し、通知・1日分の記録はしない", async () => {
    const res = await call("?phase=maintenance");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(calledFns().filter((f) => WORK.includes(f))).toEqual(["runMaintenance"]);
    expect(argsOf("acquireCronRunLock")[0][1]).toBe(CRON_PHASE_MODE.lockTtlMs);
    expect(argsOf("runMaintenance")[0][1]).toEqual({ deadlineMs: CRON_PHASE_MODE.innerDeadlineMs });
    expect(argsOf("recordMaintenanceRun")).toHaveLength(1); // /api/health の定期処理の状況（system/maintenance）は今までどおり
    const [phase, entry] = argsOf("recordCronPhaseResult")[0] as [string, Record<string, unknown>];
    expect(phase).toBe("maintenance");
    expect(entry.status).toBe("ok");
    expect(argsOf("notifyCronRun")).toHaveLength(0);
    expect(argsOf("recordCronRunResult")).toHaveLength(0);
    expect(argsOf("releaseCronRunLock")).toHaveLength(1);
    expect(await res.json()).toMatchObject({ ok: true, phase: "maintenance", status: "ok", expiredSessions: 1 });
  });

  it("各段階に、60秒の関数用の短い時間の区切りを渡す（Webhook の復旧・再確認の回収・決済監視）", async () => {
    let t0 = Date.now();
    await call("?phase=webhookRecovery");
    expect(argsOf("runCronWebhookRecovery")[0][1]).toEqual({ deadlineMs: CRON_PHASE_MODE.innerDeadlineMs });
    m.calls.length = 0;
    t0 = Date.now();
    await call("?phase=recheckRecovery");
    const notAfter = argsOf("runCronRecheckRecovery")[0][0] as Date;
    expect(notAfter.getTime() - t0).toBeGreaterThanOrEqual(CRON_PHASE_MODE.innerDeadlineMs - 50);
    expect(notAfter.getTime() - t0).toBeLessThanOrEqual(CRON_PHASE_MODE.innerDeadlineMs + 1000);
    m.calls.length = 0;
    await call("?phase=paymentMonitor");
    expect(argsOf("runPaymentMonitor")[0]).toEqual([{ source: "cron", limits: { deadlineMs: CRON_PHASE_MODE.innerDeadlineMs } }]);
    const [, entry] = argsOf("recordCronPhaseResult")[0] as [string, Record<string, unknown>];
    expect(entry.detail).toMatchObject({ status: "ok", found: 0, uncheckedCount: 0 });
  });

  it("段階の失敗：500・失敗として記録。メンテナンスの失敗は system/maintenance にも失敗を記録", async () => {
    m.phaseImpl.runCronWebhookRecovery = async () => {
      throw Object.assign(new Error("boom"), { name: "StripeDown" });
    };
    let res = await call("?phase=webhookRecovery");
    expect(res.status).toBe(500);
    expect((argsOf("recordCronPhaseResult")[0][1] as Record<string, unknown>).status).toBe("failed");
    expect((argsOf("recordCronPhaseResult")[0][1] as Record<string, unknown>).errorCode).toBe("StripeDown");
    m.calls.length = 0;
    m.phaseImpl.runMaintenance = async () => {
      throw Object.assign(new Error("boom"), { name: "FirestoreDown" });
    };
    res = await call("?phase=maintenance");
    expect(res.status).toBe(500);
    expect(argsOf("recordMaintenanceRun")[0][0]).toEqual({ ok: false, errorCode: "FirestoreDown" });
  });

  it("時間切れ（待つ上限40秒）：timed_out として記録し 500。全体は45秒以内に応答する", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    m.phaseImpl.runCronRecheckRecovery = () => new Promise(() => undefined); // 終わらない
    const p = call("?phase=recheckRecovery");
    await vi.advanceTimersByTimeAsync(CRON_PHASE_MODE.hardDeadlineMs + 1000);
    const res = await p;
    expect(res.status).toBe(500);
    const entry = argsOf("recordCronPhaseResult")[0][1] as Record<string, unknown>;
    expect(entry.status).toBe("timed_out");
    expect((entry.finishedAt as Date).getTime() - (entry.startedAt as Date).getTime()).toBeLessThanOrEqual(CRON_PHASE_MODE.hardDeadlineMs);
    expect(argsOf("releaseCronRunLock")).toHaveLength(0); // 止まらなかった段階があるので、ロックは期限で外れるのを待つ
  });

  it("別の実行中（ロックを取れない）：何もせず 200（cron_busy）", async () => {
    m.lock = { status: "busy", heldUntil: null };
    const res = await call("?phase=paymentMonitor");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, phase: "paymentMonitor", skipped: "cron_busy" });
    expect(calledFns().filter((f) => WORK.includes(f))).toEqual([]);
  });

  it("不正な値は 400。認証の前には何も解釈しない（認証なしは 401）", async () => {
    for (const q of ["?phase=", "?phase=all", "?phase=Maintenance"]) {
      const res = await call(q);
      expect(res.status, q).toBe(400);
    }
    expect(argsOf("acquireCronRunLock")).toHaveLength(0);
    expect((await call("?phase=maintenance", {})).status).toBe(401);
    expect((await call("?phase=maintenance", { authorization: "Bearer wrong" })).status).toBe(401);
    expect(calledFns().filter((f) => WORK.includes(f) || f === "acquireCronRunLock")).toEqual([]);
  });
});

describe("通知の段階（phase=notify）", () => {
  const at = (ms: number) => new Date(Date.now() - ms);
  const entry = (status: StoredCronPhaseResult["status"], ago: number, detail: Record<string, unknown> | null = null): StoredCronPhaseResult => ({
    status,
    reason: null,
    errorCode: status === "failed" ? "StripeDown" : null,
    startedAt: at(ago),
    finishedAt: at(ago - 1000),
    durationMs: 1000,
    abortSettled: null,
    detail,
  });

  it("段階の処理はせず、直近の結果をまとめて通知と1日分の記録を1回ずつ（開始は最も早い段階）", async () => {
    m.stored = {
      maintenance: entry("ok", 40 * 60_000),
      webhookRecovery: entry("failed", 30 * 60_000),
      recheckRecovery: entry("ok", 20 * 60_000, { status: "ok", done: 1 }),
      paymentMonitor: entry("ok", 10 * 60_000, { status: "issues", found: 2, uncheckedCount: 0, openReviews: 1, stripeMode: "live" }),
    };
    const res = await call("?phase=notify");
    expect(res.status).toBe(200);
    expect(calledFns().filter((f) => WORK.includes(f))).toEqual([]);
    const [input] = argsOf("notifyCronRun")[0] as [Record<string, unknown>];
    expect(input.runStatus).toBe("partial");
    expect(input.maintenanceOk).toBe(true);
    expect(input.paymentMonitor).toMatchObject({ status: "issues", found: 2, stripeMode: "live" });
    expect(input.recheckRecovery).toEqual({ status: "ok", done: 1 });
    const [owner, run] = argsOf("recordCronRunResult")[0] as [string, Record<string, unknown>];
    expect(owner).toBe("owner-1");
    expect((run.startedAt as Date).getTime()).toBe((m.stored.maintenance as StoredCronPhaseResult).startedAt.getTime());
    expect(argsOf("releaseCronRunLock")).toHaveLength(1);
  });

  it("結果を読めない：通知も記録もせず 503", async () => {
    m.readFails = true;
    const res = await call("?phase=notify");
    expect(res.status).toBe(503);
    expect(argsOf("notifyCronRun")).toHaveLength(0);
    expect(argsOf("recordCronRunResult")).toHaveLength(0);
  });
});

describe("1日分の結果のまとめ（composeDailyRun）", () => {
  const now = new Date("2026-11-11T03:00:00Z");
  const e = (status: StoredCronPhaseResult["status"], startedAt: Date, extra: Partial<StoredCronPhaseResult> = {}): StoredCronPhaseResult => ({
    status,
    reason: null,
    errorCode: null,
    startedAt,
    finishedAt: new Date(startedAt.getTime() + 2000),
    durationMs: 2000,
    abortSettled: null,
    detail: null,
    ...extra,
  });

  it("結果が無い・古すぎる（23時間超）段階は「実行されなかった」（skipped: deadline）。すべて成功なら completed", () => {
    const fresh = new Date(now.getTime() - 3600_000);
    const all = { maintenance: e("ok", fresh), webhookRecovery: e("ok", fresh), recheckRecovery: e("ok", fresh), paymentMonitor: e("ok", fresh) };
    expect(composeDailyRun(all, now).status).toBe("completed");
    const old = { ...all, webhookRecovery: e("ok", new Date(now.getTime() - 24 * 3600_000)) };
    const d = composeDailyRun(old, now);
    expect(d.phases.find((p) => p.name === "webhookRecovery")).toMatchObject({ status: "skipped", reason: "deadline" });
    expect(d.status).toBe("partial");
    expect(d.webhookRecovery).toEqual({ status: "skipped", reason: "deadline" });
    const none = composeDailyRun({}, now);
    expect(none.phases.every((p) => p.status === "skipped")).toBe(true);
    expect(none.maintenanceOk).toBe(false);
    expect(none.paymentMonitor.status).toBe("skipped_time");
    expect(none.startedAt).toEqual(now);
  });

  it("時間切れは timed_out、止まらなかったものがあれば unsettled。メンテナンスの成否は段階の状態で決める", () => {
    const t = new Date(now.getTime() - 600_000);
    const d = composeDailyRun({ maintenance: e("failed", t), paymentMonitor: e("timed_out", t, { abortSettled: false }) }, now);
    expect(d.status).toBe("timed_out");
    expect(d.unsettled).toBe(true);
    expect(d.maintenanceOk).toBe(false);
    expect(d.paymentMonitor.status).toBe("timed_out");
  });
});
