import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cronRunStatusOf, runCronPhases, type CronPhase } from "@/lib/ops/cron-phases";

const errorCodeOf = (e: unknown) => ((e as Error)?.name || "error").slice(0, 80);
const never = () => new Promise<void>(() => undefined);

describe("段階の実行（runCronPhases）", () => {
  it("順に実行し、1つが失敗しても次を実行する。失敗はエラーの識別子だけ（文面は記録しない）", async () => {
    const order: string[] = [];
    const phases: CronPhase[] = [
      { name: "a", startNotAfterMs: 1000, maxMs: 1000, run: async () => void order.push("a") },
      {
        name: "b",
        startNotAfterMs: 1000,
        maxMs: 1000,
        run: async () => {
          order.push("b");
          throw Object.assign(new Error("secret-ish message sk_test_xxx"), { name: "SimulatedError" });
        },
      },
      { name: "c", startNotAfterMs: 1000, maxMs: 1000, run: async () => void order.push("c") },
    ];
    const o = await runCronPhases(phases, { startedAt: Date.now(), hardDeadlineMs: 5000, errorCodeOf });
    expect(order).toEqual(["a", "b", "c"]);
    expect(o.phases.map((p) => [p.name, p.status, p.errorCode])).toEqual([
      ["a", "ok", null],
      ["b", "failed", "SimulatedError"],
      ["c", "ok", null],
    ]);
    expect(JSON.stringify(o)).not.toContain("sk_test_xxx");
    expect(cronRunStatusOf(o)).toBe("partial");
  });

  it("開始してよい時刻を過ぎた段階は始めない（前の段階が長引いても、後ろは締め切りで判断）", async () => {
    let now = 0;
    const ran: string[] = [];
    const phases: CronPhase[] = [
      {
        name: "slow",
        startNotAfterMs: 10,
        maxMs: 10_000,
        run: async () => {
          ran.push("slow");
          now = 200; // 200ms かかった
        },
      },
      { name: "late", startNotAfterMs: 150, maxMs: 10_000, run: async () => void ran.push("late") },
      { name: "ok", startNotAfterMs: 250, maxMs: 10_000, run: async () => void ran.push("ok") },
    ];
    const o = await runCronPhases(phases, { startedAt: 0, hardDeadlineMs: 1000, clock: () => now, errorCodeOf });
    expect(ran).toEqual(["slow", "ok"]);
    expect(o.phases.find((p) => p.name === "late")).toMatchObject({ status: "skipped", reason: "deadline", startedAtMs: null });
  });

  it("全体の締め切りを過ぎたら、新しい段階を始めない", async () => {
    let now = 0;
    const phases: CronPhase[] = [
      { name: "a", startNotAfterMs: 10_000, maxMs: 10_000, run: async () => void (now = 500) },
      { name: "b", startNotAfterMs: 10_000, maxMs: 10_000, run: async () => void (now = 600) },
    ];
    const o = await runCronPhases(phases, { startedAt: 0, hardDeadlineMs: 500, clock: () => now, errorCodeOf });
    expect(o.phases.map((p) => [p.name, p.status, p.reason])).toEqual([
      ["a", "ok", null],
      ["b", "skipped", "deadline"],
    ]);
  });

  it("待つ上限を過ぎた段階は timed_out（中止の合図を送る）。止まらなければ unsettled。残りの時間があれば次の段階は実行する", async () => {
    const ran: string[] = [];
    let aborted = false;
    const phases: CronPhase[] = [
      {
        name: "hang",
        startNotAfterMs: 10_000,
        maxMs: 30,
        run: (signal) => {
          signal.addEventListener("abort", () => void (aborted = true));
          return never(); // 合図を受けても止まらない
        },
      },
      { name: "next", startNotAfterMs: 10_000, maxMs: 1000, run: async () => void ran.push("next") },
    ];
    const o = await runCronPhases(phases, { startedAt: Date.now(), hardDeadlineMs: 5000, abortGraceMs: 30, errorCodeOf });
    expect(aborted).toBe(true);
    expect(o.timedOut).toBe(true);
    expect(o.unsettled).toBe(true);
    expect(o.phases[0]).toMatchObject({ name: "hang", status: "timed_out", errorCode: "PhaseTimeout", abortSettled: false });
    expect(ran).toEqual(["next"]);
    expect(cronRunStatusOf(o)).toBe("timed_out");
  });

  it("中止の合図で止まった段階も timed_out のまま（正常終了とは記録しない）。unsettled にはしない", async () => {
    const o = await runCronPhases(
      [
        {
          name: "cooperative",
          startNotAfterMs: 10_000,
          maxMs: 30,
          run: (signal) => new Promise<void>((ok) => signal.addEventListener("abort", () => setTimeout(ok, 10))), // ページの途中を終えてから止まる
        },
      ],
      { startedAt: Date.now(), hardDeadlineMs: 5000, abortGraceMs: 2000, errorCodeOf },
    );
    expect(o.phases[0]).toMatchObject({ status: "timed_out", abortSettled: true });
    expect(o.timedOut).toBe(true);
    expect(o.unsettled).toBe(false);
    expect(cronRunStatusOf(o)).toBe("timed_out");
  });

  it("止まるのを待つ時間は、全体の締め切りを超えない", async () => {
    const t0 = Date.now();
    const o = await runCronPhases([{ name: "hang", startNotAfterMs: 10_000, maxMs: 20, run: never }], { startedAt: t0, hardDeadlineMs: 60, abortGraceMs: 60_000, errorCodeOf });
    expect(o.phases[0].abortSettled).toBe(false);
    expect(Date.now() - t0).toBeLessThan(2000);
  });

  it("正常に終わった段階には中止の合図を送らない", async () => {
    let aborted = false;
    await runCronPhases([{ name: "a", startNotAfterMs: 1000, maxMs: 1000, run: async (signal) => void signal.addEventListener("abort", () => (aborted = true)) }], { startedAt: Date.now(), hardDeadlineMs: 5000, errorCodeOf });
    await new Promise((r) => setTimeout(r, 20));
    expect(aborted).toBe(false);
  });

  it("待つ上限は全体の締め切りまでの残りに切り詰める", async () => {
    const t0 = Date.now();
    const o = await runCronPhases([{ name: "hang", startNotAfterMs: 10_000, maxMs: 60_000, run: never }], { startedAt: t0, hardDeadlineMs: 40, abortGraceMs: 10, errorCodeOf });
    expect(o.phases[0].status).toBe("timed_out");
    expect(Date.now() - t0).toBeLessThan(2000);
  });

  it("時間切れの後に失敗しても、未処理の例外にならない", async () => {
    const onUnhandled = vi.fn();
    process.on("unhandledRejection", onUnhandled);
    const o = await runCronPhases(
      [{ name: "late_fail", startNotAfterMs: 10_000, maxMs: 10, run: () => new Promise<void>((_, rej) => setTimeout(() => rej(new Error("late")), 40)) }],
      { startedAt: Date.now(), hardDeadlineMs: 5000, abortGraceMs: 5, errorCodeOf },
    );
    await new Promise((r) => setTimeout(r, 80));
    process.off("unhandledRejection", onUnhandled);
    expect(o.phases[0].status).toBe("timed_out");
    expect(onUnhandled).not.toHaveBeenCalled();
  });

  it("ロックを失った（または確かめられない）ら、残りの段階を始めない", async () => {
    for (const stillOwner of [async () => false, async () => Promise.reject(new Error("firestore down"))]) {
      let calls = 0;
      const ran: string[] = [];
      const o = await runCronPhases(
        [
          { name: "a", startNotAfterMs: 10_000, maxMs: 1000, run: async () => void ran.push("a") },
          { name: "b", startNotAfterMs: 10_000, maxMs: 1000, run: async () => void ran.push("b") },
          { name: "c", startNotAfterMs: 10_000, maxMs: 1000, run: async () => void ran.push("c") },
        ],
        { startedAt: Date.now(), hardDeadlineMs: 5000, errorCodeOf, stillOwner: async () => (calls++ === 0 ? true : stillOwner()) },
      );
      expect(ran).toEqual(["a"]);
      expect(o.lockLost).toBe(true);
      expect(o.phases.map((p) => [p.status, p.reason])).toEqual([
        ["ok", null],
        ["skipped", "lock_lost"],
        ["skipped", "lock_lost"],
      ]);
      expect(cronRunStatusOf(o)).toBe("lock_lost");
    }
  });

  it("すべて成功なら completed。実行時間を記録する", async () => {
    const o = await runCronPhases([{ name: "a", startNotAfterMs: 1000, maxMs: 1000, run: async () => undefined }], { startedAt: Date.now(), hardDeadlineMs: 5000, errorCodeOf });
    expect(cronRunStatusOf(o)).toBe("completed");
    expect(o.phases[0].durationMs).toBeGreaterThanOrEqual(0);
    expect(o.phases[0].startedAtMs).toBeGreaterThanOrEqual(0);
  });
});

describe("定期処理（/api/cron/maintenance）：段階・ロック", () => {
  const SECRET = "cron-secret-value-for-test-1234567890";
  const st = {
    lock: { status: "acquired", ownerId: "owner-1", tookOverExpired: false } as Record<string, unknown>,
    owner: true,
    released: [] as string[],
    runs: [] as { ownerId: string; r: { status: string; phases: { name: string; status: string; reason: string | null }[] } }[],
    maint: [] as unknown[],
    calls: [] as string[],
    maintFails: false,
    webhookFails: false,
    /** hang … 中止の合図を無視して止まらない・cooperative … 合図を受けて途中の結果を返す */
    maintMode: "normal" as "normal" | "hang" | "cooperative",
  };
  let logs: string[];
  const load = async () => {
    vi.resetModules();
    vi.doMock("@/lib/services/cron-run", () => ({
      acquireCronRunLock: async () => st.lock,
      stillCronRunOwner: async () => st.owner,
      releaseCronRunLock: async (id: string) => void st.released.push(id),
      recordCronRunResult: async (ownerId: string, r: never) => void st.runs.push({ ownerId, r }),
    }));
    vi.doMock("@/lib/services/maintenance", () => ({
      runMaintenance: async (signal?: AbortSignal) => {
        st.calls.push("maintenance");
        if (st.maintFails) throw Object.assign(new Error("boom"), { name: "SimulatedMaintenanceError" });
        if (st.maintMode === "hang") return new Promise(() => undefined);
        if (st.maintMode === "cooperative") {
          await new Promise<void>((ok) => signal!.addEventListener("abort", () => setTimeout(ok, 1000)));
          return { expiredSessions: 0, expiredCheckouts: 0, purgedResults: 0, purgedCheckouts: 0, truncatedTasks: 3 };
        }
        return { expiredSessions: 0, expiredCheckouts: 0, purgedResults: 1, purgedCheckouts: 0, truncatedTasks: 0 };
      },
    }));
    vi.doMock("@/lib/services/maintenance-status", async (orig) => ({ ...(await orig<object>()), recordMaintenanceRun: async (r: unknown) => void st.maint.push(r) }));
    vi.doMock("@/lib/payments/webhook-recovery", () => ({
      runCronWebhookRecovery: async () => {
        st.calls.push("webhook");
        if (st.webhookFails) throw Object.assign(new Error("x"), { name: "SimulatedRecoveryError" });
        return { status: "completed", recovered: 0 };
      },
    }));
    vi.doMock("@/lib/payments/recheck-recovery", () => ({ runCronRecheckRecovery: async () => (st.calls.push("recheck"), { status: "completed", done: 0 }) }));
    const { GET } = await import("@/app/api/cron/maintenance/route");
    return () => GET(new Request("http://localhost/api/cron/maintenance", { headers: { authorization: `Bearer ${SECRET}` } }));
  };
  beforeEach(() => {
    vi.stubEnv("SESSION_SECRET", "unit-test-session-secret-Qx7v2Lr9Tm4Kp8Zw");
    vi.stubEnv("CRON_SECRET", SECRET);
    Object.assign(st, { lock: { status: "acquired", ownerId: "owner-1", tookOverExpired: false }, owner: true, released: [], runs: [], maint: [], calls: [], maintFails: false, webhookFails: false, maintMode: "normal" });
    logs = [];
    for (const k of ["log", "warn", "error"] as const) vi.spyOn(console, k).mockImplementation((...a: unknown[]) => void logs.push(JSON.stringify(a)));
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    for (const m of ["@/lib/services/cron-run", "@/lib/services/maintenance", "@/lib/services/maintenance-status", "@/lib/payments/webhook-recovery", "@/lib/payments/recheck-recovery"]) vi.doUnmock(m);
  });

  it("正常：3段階を順に実行し、応答は今までどおり（メンテナンスの結果＋復旧・回収）。段階の結果を記録し、ロックを外す", async () => {
    const cron = await load();
    const res = await cron();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ expiredSessions: 0, expiredCheckouts: 0, purgedResults: 1, purgedCheckouts: 0, truncatedTasks: 0, webhookRecovery: { status: "completed", recovered: 0 }, recheckRecovery: { status: "completed", done: 0 } });
    expect(st.calls).toEqual(["maintenance", "webhook", "recheck"]);
    expect(st.runs).toHaveLength(1);
    expect(st.runs[0].ownerId).toBe("owner-1");
    expect(st.runs[0].r.status).toBe("completed");
    expect(st.runs[0].r.phases.map((p) => [p.name, p.status])).toEqual([
      ["maintenance", "ok"],
      ["webhookRecovery", "ok"],
      ["recheckRecovery", "ok"],
    ]);
    expect(st.released).toEqual(["owner-1"]);
    expect(logs.join(" ")).not.toContain(SECRET);
  });

  it("実行中の定期処理があれば、何もせず 200（cron_busy）", async () => {
    st.lock = { status: "busy", heldUntil: new Date() };
    const cron = await load();
    const res = await cron();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, skipped: "cron_busy" });
    expect(st.calls).toEqual([]);
    expect(st.runs).toEqual([]);
    expect(st.released).toEqual([]);
  });

  it("ロックを取れない（Firestore の失敗）なら、何もせず 503", async () => {
    st.lock = { status: "failed", errorName: "Error" };
    const cron = await load();
    const res = await cron();
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ ok: false, error: "cron_lock_failed" });
    expect(st.calls).toEqual([]);
  });

  it("メンテナンスが失敗しても復旧・回収は実行する（応答は今までどおり 500。失敗を記録）", async () => {
    st.maintFails = true;
    const cron = await load();
    const res = await cron();
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ ok: false, error: "maintenance_failed" });
    expect(st.calls).toEqual(["maintenance", "webhook", "recheck"]);
    expect(st.maint).toEqual([{ ok: false, errorCode: "SimulatedMaintenanceError" }]);
    expect(st.runs[0].r.status).toBe("partial");
    expect(st.released).toEqual(["owner-1"]);
  });

  it("Webhook の復旧が失敗しても回収は実行する（応答は 200・復旧は failed）", async () => {
    st.webhookFails = true;
    const cron = await load();
    const res = await cron();
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ webhookRecovery: { status: "failed" }, recheckRecovery: { status: "completed" } });
    expect(st.calls).toEqual(["maintenance", "webhook", "recheck"]);
    expect(st.runs[0].r.phases.find((p) => p.name === "webhookRecovery")).toMatchObject({ status: "failed" });
  });

  it("メンテナンスが時間切れで止まらない：中止の合図を送り、後ろの段階は実行する。ロックは外さない（期限で外れる）。成功とは記録しない", async () => {
    st.maintMode = "hang";
    const cron = await load();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    try {
      const p = cron();
      await vi.advanceTimersByTimeAsync(200_000);
      const res = await p;
      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({ ok: false, error: "maintenance_failed" });
      expect(st.calls).toEqual(["maintenance", "webhook", "recheck"]);
      expect(st.maint).toEqual([{ ok: false, errorCode: "PhaseTimeout" }]);
      expect(st.runs[0].r.status).toBe("timed_out");
      expect(st.runs[0].r.phases[0]).toMatchObject({ name: "maintenance", status: "timed_out", abortSettled: false });
      expect(st.runs[0].r.phases.slice(1).map((x) => x.status)).toEqual(["ok", "ok"]);
      expect(st.released).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("メンテナンスが時間切れで、合図を受けて止まった：途中の結果でも成功とは記録しない。続いている処理は無いのでロックを外す", async () => {
    st.maintMode = "cooperative";
    const cron = await load();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    try {
      const p = cron();
      await vi.advanceTimersByTimeAsync(200_000);
      const res = await p;
      expect(res.status).toBe(500);
      expect(st.maint).toEqual([{ ok: false, errorCode: "PhaseTimeout" }]);
      expect(st.runs[0].r.phases[0]).toMatchObject({ name: "maintenance", status: "timed_out", abortSettled: true });
      expect(st.calls).toEqual(["maintenance", "webhook", "recheck"]);
      expect(st.released).toEqual(["owner-1"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("ロックを失ったら残りを始めない（メンテナンスを始める前に失えば、何も実行せず失敗を記録）", async () => {
    st.owner = false;
    const cron = await load();
    const res = await cron();
    expect(res.status).toBe(500);
    expect(st.calls).toEqual([]);
    expect(st.maint).toEqual([{ ok: false, errorCode: "skipped_lock_lost" }]);
    expect(st.runs[0].r.status).toBe("lock_lost");
    expect(await res.json()).toEqual({ ok: false, error: "maintenance_failed" });
  });
});
