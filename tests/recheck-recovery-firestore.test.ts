import { beforeEach, describe, expect, it, vi } from "vitest";

// Firestore の代わり（メモリ上。トランザクションの get・update だけ）
const store = vi.hoisted(() => ({ docs: new Map<string, Record<string, unknown>>(), tx: 0, failTx: false }));

vi.mock("@/lib/firestore/admin", async (orig) => {
  const actual = await orig<typeof import("@/lib/firestore/admin")>();
  const ref = (path: string) => ({ path, id: path.split("/").pop() });
  const fake = {
    collection: (c: string) => ({ doc: (id: string) => ref(`${c}/${id}`) }),
    runTransaction: async (fn: (tx: unknown) => Promise<unknown>) => {
      store.tx++;
      if (store.failTx) throw Object.assign(new Error("unavailable"), { name: "FirebaseError" });
      const tx = {
        get: async (r: { path: string }) => {
          const d = store.docs.get(r.path);
          return { exists: !!d, get: (k: string) => d?.[k] };
        },
        update: (r: { path: string }, data: Record<string, unknown>) => store.docs.set(r.path, { ...store.docs.get(r.path), ...data }),
      };
      return fn(tx);
    },
  };
  return { ...actual, fsdb: () => fake };
});

const { claimManualRecheck, claimRecheckRecovery, finishManualRecheck, recordRecheckRecoveryResult } = await import("@/lib/firestore/recheck-recovery");
const { RECHECK_MANUAL_LEASE_MS, RECHECK_RECOVERY_BACKOFF_MS, RECHECK_RECOVERY_MAX_ATTEMPTS } = await import("@/lib/payments/recheck-recovery-rules");

const NOW = new Date("2026-11-03T00:00:00Z");
const isSession = (v: unknown) => typeof v === "string" && /^cs_test_[A-Za-z0-9]+$/.test(v);
const path = (id: string) => `transactions/${id}`;
const tx = (over: Record<string, unknown> = {}) => ({
  paymentProvider: "stripe",
  recheckState: "PENDING",
  livemode: false,
  createdAt: new Date(NOW.getTime() - 2 * 60 * 60 * 1000),
  stripeCheckoutSessionId: "cs_test_abc",
  stripePaymentIntentId: "pi_abc",
  recheckAttempts: 3,
  paymentStatus: "REFUNDED",
  ...over,
});

beforeEach(() => {
  store.docs.clear();
  store.failTx = false;
});

describe("claimRecheckRecovery（試行の記録）", () => {
  it("対象なら自動の回収の回数・時刻を記録する（確定の処理の recheckAttempts・決済の状態は変えない）", async () => {
    store.docs.set(path("t1"), tx());
    const c = await claimRecheckRecovery("t1", NOW, "test", isSession);
    expect(c).toEqual({ claimed: true, sessionId: "cs_test_abc", paymentIntentId: "pi_abc", attempt: 1 });
    const d = store.docs.get(path("t1"))!;
    expect([d.recheckRecoveryAttempts, d.recheckRecoveryLastAt, d.recheckRecoveryLastResult, d.recheckRecoveryLastError]).toEqual([1, NOW, "started", null]);
    expect([d.recheckAttempts, d.paymentStatus, d.recheckState]).toEqual([3, "REFUNDED", "PENDING"]);
  });

  it("直後のもう一度の試行（同時の実行・重なった定期処理）は間隔待ちで試さない。20時間後は2回目", async () => {
    store.docs.set(path("t1"), tx());
    await claimRecheckRecovery("t1", NOW, "test", isSession);
    expect(await claimRecheckRecovery("t1", new Date(NOW.getTime() + 1000), "test", isSession)).toEqual({ claimed: false, reason: "backoff" });
    const later = new Date(NOW.getTime() + RECHECK_RECOVERY_BACKOFF_MS);
    expect(await claimRecheckRecovery("t1", later, "test", isSession)).toMatchObject({ claimed: true, attempt: 2 });
  });

  it("回数の上限・決済記録が無い・PENDING でなくなった・モード違いは試さない（何も書かない）", async () => {
    store.docs.set(path("max"), tx({ recheckRecoveryAttempts: RECHECK_RECOVERY_MAX_ATTEMPTS }));
    store.docs.set(path("done"), tx({ recheckState: "DONE" }));
    store.docs.set(path("live"), tx({ livemode: true }));
    expect(await claimRecheckRecovery("max", NOW, "test", isSession)).toEqual({ claimed: false, reason: "max_attempts" });
    expect(await claimRecheckRecovery("missing", NOW, "test", isSession)).toEqual({ claimed: false, reason: "missing" });
    expect(await claimRecheckRecovery("done", NOW, "test", isSession)).toEqual({ claimed: false, reason: "not_pending" });
    expect(await claimRecheckRecovery("live", NOW, "test", isSession)).toEqual({ claimed: false, reason: "mode_mismatch" });
    expect(store.docs.has(path("missing"))).toBe(false); // 決済記録を作らない
    for (const id of ["max", "done", "live"]) expect(store.docs.get(path(id))!.recheckRecoveryLastAt).toBeUndefined();
  });
});

describe("recordRecheckRecoveryResult（結果の記録）", () => {
  it("結果とエラーの名前を記録する（名前の形が不正なら Error）。決済記録が無ければ何もしない（作らない）", async () => {
    store.docs.set(path("t1"), tx());
    await recordRecheckRecoveryResult("t1", "error", "StripeConnectionError");
    expect([store.docs.get(path("t1"))!.recheckRecoveryLastResult, store.docs.get(path("t1"))!.recheckRecoveryLastError]).toEqual(["error", "StripeConnectionError"]);
    await recordRecheckRecoveryResult("t1", "rejected", "bad name with spaces!");
    expect(store.docs.get(path("t1"))!.recheckRecoveryLastError).toBe("Error");
    await recordRecheckRecoveryResult("t1", "done", null);
    expect([store.docs.get(path("t1"))!.recheckRecoveryLastResult, store.docs.get(path("t1"))!.recheckRecoveryLastError]).toEqual(["done", null]);
    await recordRecheckRecoveryResult("missing", "done", null);
    expect(store.docs.has(path("missing"))).toBe(false);
  });

  it("記録に失敗しても例外にしない（回数は試行の前に記録済み）", async () => {
    store.failTx = true;
    await expect(recordRecheckRecoveryResult("t1", "done", null)).resolves.toBeUndefined();
  });
});

describe("claimManualRecheck・finishManualRecheck（手動の再確認の印）", () => {
  it("実行中の印（期限つき）・実行者・時刻・回数を記録し、前の状態を返す。決済の状態・自動の回収の回数は変えない", async () => {
    store.docs.set(path("t1"), tx({ recheckRecoveryAttempts: RECHECK_RECOVERY_MAX_ATTEMPTS }));
    const c = await claimManualRecheck("t1", NOW, "test", isSession, "op-1");
    expect(c).toMatchObject({ claimed: true, sessionId: "cs_test_abc", paymentIntentId: "pi_abc", before: { recheckState: "PENDING", paymentStatus: "REFUNDED" } });
    const d = store.docs.get(path("t1"))!;
    expect([d.recheckManualUntil, d.recheckManualLastBy, d.recheckManualLastAt, d.recheckManualLastResult, d.recheckManualAttempts]).toEqual([new Date(NOW.getTime() + RECHECK_MANUAL_LEASE_MS), "op-1", NOW, "started", 1]);
    expect([d.paymentStatus, d.recheckRecoveryAttempts, d.recheckAttempts]).toEqual(["REFUNDED", RECHECK_RECOVERY_MAX_ATTEMPTS, 3]);
  });

  it("二重の実行の防止：手動の実行中は、もう一度の手動・自動の回収のどちらも始めない。期限の後は始められる", async () => {
    store.docs.set(path("t1"), tx());
    await claimManualRecheck("t1", NOW, "test", isSession, "op-1");
    expect(await claimManualRecheck("t1", new Date(NOW.getTime() + 1000), "test", isSession, "op-2")).toEqual({ claimed: false, reason: "manual_running" });
    expect(await claimRecheckRecovery("t1", new Date(NOW.getTime() + 1000), "test", isSession)).toEqual({ claimed: false, reason: "manual_running" });
    expect(await claimManualRecheck("t1", new Date(NOW.getTime() + RECHECK_MANUAL_LEASE_MS), "test", isSession, "op-2")).toMatchObject({ claimed: true });
  });

  it("自動の回収の試行の途中（started・30分以内）は手動を始めない", async () => {
    store.docs.set(path("t1"), tx());
    await claimRecheckRecovery("t1", NOW, "test", isSession);
    expect(await claimManualRecheck("t1", new Date(NOW.getTime() + 60_000), "test", isSession, "op-1")).toEqual({ claimed: false, reason: "auto_running" });
  });

  it("終了：自分の印のときだけ結果を記録して印を外す（期限の後に別の運営が始めた印は消さない）。決済記録が無ければ null（作らない）", async () => {
    store.docs.set(path("t1"), tx());
    const a = await claimManualRecheck("t1", NOW, "test", isSession, "op-1");
    const later = new Date(NOW.getTime() + RECHECK_MANUAL_LEASE_MS);
    const b = await claimManualRecheck("t1", later, "test", isSession, "op-2");
    if (!a.claimed || !b.claimed) throw new Error("前提");
    const snapA = await finishManualRecheck("t1", a.token, "error", "StripeConnectionError");
    expect(snapA).toMatchObject({ recheckState: "PENDING", paymentStatus: "REFUNDED" });
    let d = store.docs.get(path("t1"))!;
    expect([d.recheckManualToken, d.recheckManualLastResult, d.recheckManualLastBy]).toEqual([b.token, "started", "op-2"]); // 古い印の終了は新しい印を消さない
    await finishManualRecheck("t1", b.token, "done", null);
    d = store.docs.get(path("t1"))!;
    expect([d.recheckManualToken, d.recheckManualUntil, d.recheckManualLastResult, d.recheckManualLastError]).toEqual([null, null, "done", null]);
    expect(await finishManualRecheck("missing", "x", "done", null)).toBeNull();
    expect(store.docs.has(path("missing"))).toBe(false);
  });

  it("終了の記録に失敗しても例外にしない（印は期限で外れる）", async () => {
    store.failTx = true;
    await expect(finishManualRecheck("t1", "x", "done", null)).resolves.toBeNull();
  });
});
