import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  user: { id: "u1", role: "OPERATOR" } as { id: string; role: string } | null,
  sameOrigin: true,
  firestore: true,
  runtime: true,
  audits: [] as unknown[],
  starts: [] as unknown[],
  resumes: [] as unknown[],
}));

vi.mock("@/lib/auth/session", () => ({ getSessionUser: async () => state.user }));
vi.mock("@/lib/security/request", () => ({ isSameOrigin: () => state.sameOrigin }));
vi.mock("@/lib/data-provider", () => ({ isFirestore: () => state.firestore }));
vi.mock("@/lib/services/audit", () => ({ writeAudit: async (e: unknown) => void state.audits.push(e) }));
vi.mock("@/lib/payments/stripe-checkout", () => ({
  stripeRuntime: () => {
    if (!state.runtime) throw new Error("no runtime");
    return { mode: "live", envTag: "fp_0123456789abcdef" };
  },
}));
vi.mock("@/lib/payments/stripe-reconcile", async () => {
  class ReconcileInputError extends Error {
    constructor(public readonly code: string) {
      super(code);
    }
  }
  const run = (done: boolean) => ({
    state: {
      runId: "r1", mode: "live", from: 1, to: 2, startedAt: 0, done, pages: 1,
      counts: { scanned: 1, anomalies: 0, pending: 0, needsReview: 0 }, byKind: {}, anomalies: [], pendingItems: [], reviewItems: [], truncated: {},
    },
    verdict: done ? "ok" : "incomplete",
    stoppedBy: done ? null : "time",
    token: done ? null : "signed.token",
    segmentPages: 1,
  });
  return {
    RECONCILE_TOKEN_MAX_LENGTH: 1000,
    ReconcileInputError,
    startReconcile: async (o: unknown) => {
      state.starts.push(o);
      return run(false);
    },
    resumeReconcile: async (o: { token: unknown }) => {
      state.resumes.push(o);
      if (o.token === "bad") throw new ReconcileInputError("invalid_token");
      return run(true);
    },
  };
});

const post = async (body: unknown, raw?: string) => {
  const { POST } = await import("@/app/api/admin/payment-reconcile/route");
  return POST(new Request("https://uranai.example.test/api/admin/payment-reconcile", { method: "POST", body: raw ?? JSON.stringify(body) }));
};

describe("POST /api/admin/payment-reconcile", () => {
  beforeEach(() => {
    Object.assign(state, { user: { id: "u1", role: "OPERATOR" }, sameOrigin: true, firestore: true, runtime: true, audits: [], starts: [], resumes: [] });
    vi.resetModules(); // レート制限（メモリ）を毎回新しくする
  });
  it("運営アカウント以外は 404（存在を見せない）・別のサイトからの送信は 403", async () => {
    state.user = null;
    expect((await post({ action: "start", from: "2026-11-01", to: "2026-11-07" })).status).toBe(404);
    state.user = { id: "s1", role: "STORE" };
    expect((await post({ action: "start", from: "2026-11-01", to: "2026-11-07" })).status).toBe(404);
    state.user = { id: "u1", role: "OPERATOR" };
    state.sameOrigin = false;
    expect((await post({ action: "start", from: "2026-11-01", to: "2026-11-07" })).status).toBe(403);
    expect(state.starts).toHaveLength(0);
  });
  it("Firestore・Stripe の接続が無い環境では照合しない", async () => {
    state.firestore = false;
    expect((await post({ action: "start", from: "2026-11-01", to: "2026-11-07" })).status).toBe(409);
    state.firestore = true;
    state.runtime = false;
    expect(await (await post({ action: "start", from: "2026-11-01", to: "2026-11-07" })).json()).toEqual({ error: "stripe_unavailable" });
  });
  it("入力の検証（形・日付）", async () => {
    expect((await post(null, "{")).status).toBe(400);
    expect((await post({ action: "delete" })).status).toBe(400);
    expect(await (await post({ action: "start", from: "2026-02-31", to: "2026-03-01" })).json()).toEqual({ error: "invalid_range" });
    expect((await post(null, "x".repeat(6000))).status).toBe(413);
    expect(state.starts).toHaveLength(0);
  });
  it("開始：日本時間の日付の期間で始め、未完了なら再開用の値を返す。監査ログは1件", async () => {
    const res = await post({ action: "start", from: "2026-11-01", to: "2026-11-07" });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toContain("no-store");
    const j = await res.json();
    expect([j.verdict, j.stoppedBy, j.token]).toEqual(["incomplete", "time", "signed.token"]);
    expect(state.starts[0]).toMatchObject({ userId: "u1", fromSec: Date.parse("2026-10-31T15:00:00Z") / 1000, toSec: Date.parse("2026-11-07T15:00:00Z") / 1000 });
    expect(state.audits).toHaveLength(1);
    expect(state.audits[0]).toMatchObject({ action: "payment_reconcile.run", actorUserId: "u1", targetId: "r1" });
  });
  it("再開：期間は送らせない（token だけ）。署名が正しくなければ 400", async () => {
    const ok = await post({ action: "resume", token: "signed.token", from: "2020-01-01", to: "2020-01-31" });
    const j = await ok.json();
    expect([j.verdict, j.token]).toEqual(["ok", null]);
    expect(state.resumes[0]).toEqual({ rt: expect.anything(), userId: "u1", token: "signed.token" });
    expect(await (await post({ action: "resume", token: "bad" })).json()).toEqual({ error: "invalid_token" });
  });
});
