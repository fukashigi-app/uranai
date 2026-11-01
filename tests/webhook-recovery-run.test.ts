import { beforeEach, describe, expect, it, vi } from "vitest";

// 自動の復旧の実行（Firestore・Stripe は模擬）。一覧を読めないときは失敗として記録し、何も処理しない
const st = vi.hoisted(() => ({ listFail: false, processed: [] as string[], runs: [] as Record<string, unknown>[], retrieveFail: null as null | Record<string, unknown> }));
vi.mock("@/lib/firestore/payments", () => ({
  listUnfinishedWebhookEvents: async () => {
    if (st.listFail) throw Object.assign(new Error("unavailable"), { name: "FirebaseError" });
    return { records: [{ id: "stripe_evt_a", eventId: "evt_a", type: "charge.refunded", state: "RETRYABLE", livemode: false, leaseExpiresAt: null, recoveryAttempts: 0, lastRecoveryAt: null, createdAt: new Date(0) }], nextCursor: null, hasMore: false, scanned: 1 };
  },
  getWebhookEventRecord: async (_p: string, id: string) => ({ eventId: id, type: "charge.refunded", processed: false, state: "RETRYABLE", livemode: false, leaseOwner: null, leaseExpiresAt: null }),
  recordWebhookRecoveryResult: async () => true,
  markWebhookEventUnavailable: async () => true,
  recordWebhookRecoveryRun: async (r: Record<string, unknown>) => void st.runs.push(r),
}));
vi.mock("@/lib/payments/stripe-webhook", () => ({
  processStripeEvent: async (e: { id: string }) => (st.processed.push(e.id), { status: 200, body: { received: true, outcome: "refunded" } }),
}));
vi.mock("@/lib/payments/stripe-checkout", () => ({
  stripeRuntime: () => ({ mode: "test" }),
  retrieveStripeEvent: async (id: string) => {
    if (st.retrieveFail) throw st.retrieveFail;
    return { id, object: "event", type: "charge.refunded", livemode: false, data: { object: { id: "ch_1" } } };
  },
}));

describe("runStripeWebhookRecovery", () => {
  beforeEach(() => {
    st.listFail = false;
    st.processed = [];
    st.runs = [];
    st.retrieveFail = null;
  });
  const rt = { mode: "test" } as never;

  it("未処理の記録を読めない（Firestore の失敗）なら failed を記録し、何も処理しない", async () => {
    st.listFail = true;
    const { runStripeWebhookRecovery } = await import("@/lib/payments/webhook-recovery");
    const s = await runStripeWebhookRecovery(rt, { source: "cron" });
    expect([s.status, s.errorName, s.attempted]).toEqual(["failed", "FirebaseError", 0]);
    expect(st.processed).toEqual([]);
    expect(st.runs[0]).toMatchObject({ source: "cron", status: "failed", errorName: "FirebaseError" });
  });

  it("Stripe から取り直した通知を Webhook と同じ処理に渡す。取得できない（404）なら処理せず event_unavailable", async () => {
    const { runStripeWebhookRecovery, recoverStripeWebhookEvent } = await import("@/lib/payments/webhook-recovery");
    const s = await runStripeWebhookRecovery(rt, { source: "cron" });
    expect([s.status, s.results.recovered, st.processed]).toEqual(["completed", 1, ["evt_a"]]);
    st.retrieveFail = { type: "StripeInvalidRequestError", statusCode: 404, code: "resource_missing", name: "StripeInvalidRequestError" };
    expect((await recoverStripeWebhookEvent("evt_b", rt)).result).toBe("event_unavailable");
    st.retrieveFail = { type: "StripeConnectionError", name: "StripeConnectionError" };
    expect(await recoverStripeWebhookEvent("evt_c", rt)).toMatchObject({ result: "stripe_error", errorName: "StripeConnectionError" });
    expect(st.processed).toEqual(["evt_a"]);
  });
});
