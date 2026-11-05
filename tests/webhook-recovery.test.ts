import { afterEach, describe, expect, it, vi } from "vitest";
import { isRecoveryAttempt, RECOVERY_BACKOFF_MS, RECOVERY_MAX_AUTO_ATTEMPTS, recoverySkipReason, selectRecoveryCandidates, WEBHOOK_RECOVERY_RESULT_LABEL, WEBHOOK_RECOVERY_RESULTS } from "@/lib/payments/webhook-recovery-rules";

// Webhook の通知の復旧の規則と、運営の操作・定期処理の入口（Firestore・Stripe には接続しない）
const NOW = new Date("2026-10-31T03:00:00Z");
const ago = (ms: number) => new Date(NOW.getTime() - ms);
const rec = (o: Partial<Parameters<typeof recoverySkipReason>[0]> = {}) => ({ eventId: "evt_1", state: "RETRYABLE", livemode: false, leaseExpiresAt: null, recoveryAttempts: 0, lastRecoveryAt: null, createdAt: ago(3_600_000), ...o });

describe("自動の復旧の対象", () => {
  it("RECEIVED（途中で停止）・RETRYABLE（失敗）だけ。処理中・モード違い・回数の上限・間隔待ち・要確認は対象外", () => {
    expect(recoverySkipReason(rec(), NOW, "test")).toBeNull();
    expect(recoverySkipReason(rec({ state: "RECEIVED" }), NOW, "test")).toBeNull();
    expect(recoverySkipReason(rec({ state: "FAILED_PERMANENT" }), NOW, "test")).toBe("not_retryable");
    expect(recoverySkipReason(rec({ leaseExpiresAt: new Date(NOW.getTime() + 1) }), NOW, "test")).toBe("lease_active");
    expect(recoverySkipReason(rec({ leaseExpiresAt: NOW }), NOW, "test")).toBeNull(); // 期限ちょうどは期限切れ
    expect(recoverySkipReason(rec({ livemode: true }), NOW, "test")).toBe("mode_mismatch");
    expect(recoverySkipReason(rec({ livemode: null }), NOW, "test")).toBeNull(); // モードが記録に無い以前の記録は試す（取り直した通知で確かめる）
    expect(recoverySkipReason(rec({ recoveryAttempts: RECOVERY_MAX_AUTO_ATTEMPTS }), NOW, "test")).toBe("attempts_exhausted");
    expect(recoverySkipReason(rec({ lastRecoveryAt: ago(RECOVERY_BACKOFF_MS - 1) }), NOW, "test")).toBe("backoff");
    expect(recoverySkipReason(rec({ lastRecoveryAt: ago(RECOVERY_BACKOFF_MS) }), NOW, "test")).toBeNull();
  });

  it("試した回数の少ない順・最後に試した時刻の古い順（未実施が先）・作成の古い順に並べ、上限で切る（古い失敗が後の通知を追い出し続けない）", () => {
    const rs = [
      rec({ eventId: "evt_old_failing", createdAt: ago(9e8), recoveryAttempts: 2, lastRecoveryAt: ago(9e7) }),
      rec({ eventId: "evt_new", createdAt: ago(4e6) }),
      rec({ eventId: "evt_older", createdAt: ago(8e6) }),
      rec({ eventId: "evt_once", createdAt: ago(9e8), recoveryAttempts: 1, lastRecoveryAt: ago(9e7) }),
      rec({ eventId: "evt_busy", leaseExpiresAt: new Date(NOW.getTime() + 60_000) }),
    ];
    const s = selectRecoveryCandidates(rs, NOW, "test", 3);
    expect(s.candidates.map((r) => r.eventId)).toEqual(["evt_older", "evt_new", "evt_once"]);
    expect(s.overLimit).toBe(1);
    expect(s.skipped.lease_active).toBe(1);
  });

  it("回数に数えるのは Stripe・処理を試した結果だけ。すべての結果に表示の文言がある", () => {
    expect(isRecoveryAttempt("failed")).toBe(true);
    expect(isRecoveryAttempt("stripe_error")).toBe(true);
    expect(isRecoveryAttempt("event_unavailable")).toBe(true);
    expect(isRecoveryAttempt("busy")).toBe(false);
    expect(isRecoveryAttempt("already_processed")).toBe(false);
    for (const r of WEBHOOK_RECOVERY_RESULTS) expect(WEBHOOK_RECOVERY_RESULT_LABEL[r]).toBeTruthy();
  });
});

// ---- 運営の操作（手動の復旧）：運営のログインが必須。通知の ID だけを受け付ける ----
const calls = vi.hoisted(() => ({ operator: "ok" as "ok" | "redirect", recover: [] as unknown[][], audits: [] as unknown[], runs: 0 }));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw Object.assign(new Error(`NEXT_REDIRECT ${to}`), { digest: `NEXT_REDIRECT;${to}` });
  },
}));
vi.mock("@/lib/auth/session", () => ({
  requireOperator: async () => {
    if (calls.operator === "redirect") throw Object.assign(new Error("NEXT_REDIRECT /admin/login"), { digest: "NEXT_REDIRECT;/admin/login" });
    return { id: "op-1", role: "OPERATOR" };
  },
  getSessionUser: async () => null,
}));
vi.mock("@/lib/data-provider", async (orig) => ({ ...(await orig<object>()), isFirestore: () => true }));
vi.mock("@/lib/services/audit", () => ({ writeAudit: async (e: unknown) => void calls.audits.push(e) }));
vi.mock("@/lib/payments/stripe-checkout", async (orig) => ({ ...(await orig<object>()), stripeRuntime: () => ({ mode: "test" }) }));
vi.mock("@/lib/payments/webhook-recovery", () => ({
  recoverStripeWebhookEvent: async (...a: unknown[]) => (calls.recover.push(a), { eventId: a[0], result: "recovered", errorName: null, outcome: "confirmed" }),
  runStripeWebhookRecovery: async () => (calls.runs++, { status: "completed", candidates: 1, attempted: 1, results: Object.fromEntries(WEBHOOK_RECOVERY_RESULTS.map((k) => [k, k === "recovered" ? 1 : 0])) }),
}));

describe("手動の復旧（運営画面のサーバーの処理）", () => {
  afterEach(() => {
    calls.operator = "ok";
    calls.recover = [];
    calls.audits = [];
    calls.runs = 0;
  });

  it("運営のログインが無ければ（店舗アカウント・ログインなし）、再処理を呼ばない（ログイン画面へ）", async () => {
    calls.operator = "redirect";
    const { recoverWebhookEventAction, runWebhookRecoveryAction } = await import("@/app/admin/actions");
    await expect(recoverWebhookEventAction("evt_test_1", {})).rejects.toThrow(/NEXT_REDIRECT/);
    await expect(runWebhookRecoveryAction({})).rejects.toThrow(/NEXT_REDIRECT/);
    expect(calls.recover).toHaveLength(0);
    expect(calls.runs).toBe(0);
  });

  it("通知の ID の形でなければ拒否（決済の内容などは受け付けない）", async () => {
    const { recoverWebhookEventAction } = await import("@/app/admin/actions");
    for (const id of ["", "cs_test_1", "evt_../x", `evt_${"a".repeat(201)}`, "evt_1;drop"]) await expect(recoverWebhookEventAction(id, {})).rejects.toThrow(/invalid id/);
    expect(calls.recover).toHaveLength(0);
  });

  it("運営なら ID で再処理し、監査ログに記録して、結果の通知付きで一覧に戻る（処理済みの行は一覧から消えるため）", async () => {
    const { recoverWebhookEventAction } = await import("@/app/admin/actions");
    await expect(recoverWebhookEventAction("evt_test_1", {})).rejects.toThrow("NEXT_REDIRECT /admin/webhook-events?notice=recovered");
    expect(calls.recover[0][0]).toBe("evt_test_1");
    expect(calls.audits).toEqual([expect.objectContaining({ actorUserId: "op-1", action: "webhook_event.recover", targetId: "evt_test_1", after: { result: "recovered", outcome: "confirmed", errorName: null } })]);
  });
});

// ---- 定期処理の入口：CRON_SECRET の認証が必須。認証の後だけ自動の復旧を実行する ----
describe("定期処理（/api/cron/maintenance）の自動の復旧", () => {
  const SECRET = "cron-secret-value-for-test-1234567890";
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.doUnmock("@/lib/services/maintenance");
    vi.doUnmock("@/lib/services/maintenance-status");
    vi.doUnmock("@/lib/services/cron-run");
  });
  const load = async (maintenanceFails = false) => {
    vi.resetModules();
    // 定期処理全体のロック（Firestore）は模擬：取得できる。ロックそのものは tests/cron-phases.test.ts と E2E で確かめる
    vi.doMock("@/lib/services/cron-run", () => ({
      acquireCronRunLock: async () => ({ status: "acquired", ownerId: "owner-unit", tookOverExpired: false }),
      stillCronRunOwner: async () => true,
      releaseCronRunLock: async () => {},
      recordCronRunResult: async () => {},
    }));
    const recovery = vi.fn(async () => ({ status: "completed", scanned: 1, attempted: 1, deferred: 0, truncated: false, recovered: 1, failed: 0 }));
    vi.doMock("@/lib/payments/webhook-recovery", () => ({ runCronWebhookRecovery: recovery }));
    vi.doMock("@/lib/services/maintenance", () => ({ runMaintenance: async () => (maintenanceFails ? Promise.reject(new Error("x")) : { expiredSessions: 0, expiredCheckouts: 0, purgedResults: 0, purgedCheckouts: 0 }) }));
    vi.doMock("@/lib/services/maintenance-status", async (orig) => ({ ...(await orig<object>()), recordMaintenanceRun: async () => {} }));
    const { GET, maxDuration } = await import("@/app/api/cron/maintenance/route");
    return { GET, recovery, maxDuration };
  };

  it("認証が無い・違えば 401 で、復旧を実行しない", async () => {
    vi.stubEnv("SESSION_SECRET", "unit-test-session-secret-Qx7v2Lr9Tm4Kp8Zw");
    vi.stubEnv("CRON_SECRET", SECRET);
    const { GET, recovery } = await load();
    for (const h of [{}, { authorization: "Bearer wrong" }] as Record<string, string>[]) expect((await GET(new Request("http://localhost/api/cron/maintenance", { headers: h }))).status).toBe(401);
    expect(recovery).not.toHaveBeenCalled();
  });

  it("認証が正しければメンテナンスの後に復旧を実行し、結果を応答に含める。メンテナンスが失敗しても復旧は実行する（応答は 500 のまま）", async () => {
    vi.stubEnv("SESSION_SECRET", "unit-test-session-secret-Qx7v2Lr9Tm4Kp8Zw");
    vi.stubEnv("CRON_SECRET", SECRET);
    const first = await load();
    let { GET, recovery } = first;
    expect(first.maxDuration).toBe(300);
    const res = await GET(new Request("http://localhost/api/cron/maintenance", { headers: { authorization: `Bearer ${SECRET}` } }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ webhookRecovery: { status: "completed", recovered: 1 } });
    expect(recovery).toHaveBeenCalledTimes(1);
    ({ GET, recovery } = await load(true));
    const r2 = await GET(new Request("http://localhost/api/cron/maintenance", { headers: { authorization: `Bearer ${SECRET}` } }));
    expect(r2.status).toBe(500);
    expect(await r2.json()).toEqual({ ok: false, error: "maintenance_failed" });
    expect(recovery).toHaveBeenCalledTimes(1);
  });
});
