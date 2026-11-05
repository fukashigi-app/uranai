import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  RECHECK_RECOVERY_BACKOFF_MS,
  RECHECK_RECOVERY_MAX_ATTEMPTS,
  RECHECK_RECOVERY_MIN_AGE_MS,
  recheckRecoveryResultOf,
  recheckRecoverySkipReason,
  type RecheckRecoveryCandidate,
  type RecheckRecoveryResult,
} from "@/lib/payments/recheck-recovery-rules";
import { runPendingRecheckRecovery, type RecheckRecoveryDeps } from "@/lib/payments/recheck-recovery";
import type { PendingRecheckDoc, RecheckRecoveryRunRecord } from "@/lib/firestore/recheck-recovery";

const NOW = new Date("2026-11-03T00:00:00Z");
const isSession = (v: unknown) => typeof v === "string" && /^cs_test_[A-Za-z0-9]+$/.test(v);
const base = (over: Partial<RecheckRecoveryCandidate> = {}): RecheckRecoveryCandidate => ({
  paymentProvider: "stripe",
  recheckState: "PENDING",
  livemode: false,
  createdAt: new Date(NOW.getTime() - 2 * 60 * 60 * 1000),
  recoveryAttempts: undefined,
  recoveryLastAt: null,
  sessionId: "cs_test_abc",
  paymentIntentId: "pi_abc",
  ...over,
});
const reason = (over: Partial<RecheckRecoveryCandidate>, mode: "test" | "live" = "test", now = NOW) => recheckRecoverySkipReason(base(over), now, mode, isSession);

describe("recheckRecoverySkipReason（自動の回収の対象）", () => {
  it("対象：PENDING・Stripe・モード一致・作成から30分以上・回数6未満・前回から20時間以上・ID がそろっている", () => {
    expect(reason({})).toBeNull();
    expect(reason({ recoveryAttempts: RECHECK_RECOVERY_MAX_ATTEMPTS - 1, recoveryLastAt: new Date(NOW.getTime() - RECHECK_RECOVERY_BACKOFF_MS) })).toBeNull();
    expect(reason({ livemode: true }, "live")).toBeNull();
  });
  it("PENDING そのもの以外（DONE・値なし・想定外の値）は対象外", () => {
    for (const v of ["DONE", undefined, null, "pending", "UNKNOWN", 1]) expect(reason({ recheckState: v })).toBe("not_pending");
  });
  it("Stripe 以外・モード違い（テストの接続で本番の決済、その逆、値なし）は対象外", () => {
    expect(reason({ paymentProvider: "mock" })).toBe("not_stripe");
    expect(reason({ livemode: true })).toBe("mode_mismatch");
    expect(reason({ livemode: false }, "live")).toBe("mode_mismatch");
    expect(reason({ livemode: undefined })).toBe("mode_mismatch");
    expect(reason({ livemode: "false" })).toBe("mode_mismatch");
  });
  it("回収できない記録（作成の時刻・Session・PaymentIntent が無い・形が違う）は対象外（確定を試みない）", () => {
    expect(reason({ createdAt: null })).toBe("invalid_record");
    expect(reason({ sessionId: null })).toBe("invalid_record");
    expect(reason({ sessionId: "cs_live_abc" })).toBe("invalid_record");
    expect(reason({ paymentIntentId: null })).toBe("invalid_record");
    expect(reason({ paymentIntentId: "ch_abc" })).toBe("invalid_record");
  });
  it("作成から30分未満は対象外（境界：ちょうど30分は対象）", () => {
    expect(reason({ createdAt: new Date(NOW.getTime() - RECHECK_RECOVERY_MIN_AGE_MS + 1) })).toBe("too_new");
    expect(reason({ createdAt: new Date(NOW.getTime() - RECHECK_RECOVERY_MIN_AGE_MS) })).toBeNull();
  });
  it("前回の自動の回収から20時間未満は対象外（境界：ちょうど20時間は対象）", () => {
    expect(reason({ recoveryAttempts: 1, recoveryLastAt: new Date(NOW.getTime() - RECHECK_RECOVERY_BACKOFF_MS + 1) })).toBe("backoff");
    expect(reason({ recoveryAttempts: 1, recoveryLastAt: new Date(NOW.getTime() - RECHECK_RECOVERY_BACKOFF_MS) })).toBeNull();
  });
  it("自動の回収は6回まで（確定の処理の recheckAttempts とは別の回数）", () => {
    expect(reason({ recoveryAttempts: RECHECK_RECOVERY_MAX_ATTEMPTS })).toBe("max_attempts");
    expect(reason({ recoveryAttempts: RECHECK_RECOVERY_MAX_ATTEMPTS + 3 })).toBe("max_attempts");
    // 形の不正な回数は0回として扱う
    expect(reason({ recoveryAttempts: "9" })).toBeNull();
  });
});

describe("recheckRecoveryResultOf（確定の処理の結果 → 回収の結果）", () => {
  it("決済記録がある経路（duplicate・refunded）だけが回収。再確認の完了・未完了で分ける", () => {
    expect(recheckRecoveryResultOf({ status: "duplicate", recheck: "done" })).toBe("done");
    expect(recheckRecoveryResultOf({ status: "refunded", recheck: "done" })).toBe("done");
    expect(recheckRecoveryResultOf({ status: "duplicate", recheck: "not_pending" })).toBe("done");
    expect(recheckRecoveryResultOf({ status: "duplicate" })).toBe("done");
    expect(recheckRecoveryResultOf({ status: "duplicate", recheck: "pending" })).toBe("pending");
    expect(recheckRecoveryResultOf({ status: "refunded", recheck: "pending" })).toBe("pending");
  });
  it("新しい作成（confirmed）・拒否・支払いの確定待ちは異常（rejected）", () => {
    for (const status of ["confirmed", "rejected", "not_paid"]) expect(recheckRecoveryResultOf({ status })).toBe("rejected");
  });
});

// ---- 回収の実行（依存をメモリ上で再現） ----
type Rec = { id: string; c: RecheckRecoveryCandidate };
function world(records: Rec[], opts: { recheck?: (id: string) => Promise<{ status: string; reason?: string; recheck?: "done" | "pending" | "not_pending" }> } = {}) {
  const docs = new Map(records.map((r) => [r.id, { ...r.c }]));
  const log: string[] = [];
  let cursor: string | null = null;
  const runs: RecheckRecoveryRunRecord[] = [];
  const results: { id: string; result: RecheckRecoveryResult; errorName: string | null }[] = [];
  const deps: RecheckRecoveryDeps = {
    readCursor: async () => cursor,
    listPage: async (afterId, pageSize) => {
      log.push(`list:${afterId ?? "-"}`);
      const ids = [...docs.keys()].filter((id) => docs.get(id)!.recheckState === "PENDING").sort();
      const from = afterId ? ids.filter((id) => id > afterId) : ids;
      return from.slice(0, pageSize).map((id): PendingRecheckDoc => ({ id, candidate: { ...docs.get(id)! } }));
    },
    claim: async (id, now) => {
      log.push(`claim:${id}`);
      const c = docs.get(id);
      if (!c) return { claimed: false, reason: "missing" };
      const r = recheckRecoverySkipReason(c, now, "test", isSession);
      if (r) return { claimed: false, reason: r };
      c.recoveryAttempts = (typeof c.recoveryAttempts === "number" ? c.recoveryAttempts : 0) + 1;
      c.recoveryLastAt = now;
      return { claimed: true, sessionId: String(c.sessionId), paymentIntentId: String(c.paymentIntentId), attempt: Number(c.recoveryAttempts) };
    },
    recheck: async ({ txId }) => {
      log.push(`recheck:${txId}`);
      if (opts.recheck) return opts.recheck(txId);
      docs.get(txId)!.recheckState = "DONE";
      return { status: "duplicate", recheck: "done" };
    },
    recordResult: async (id, result, errorName) => void results.push({ id, result, errorName }),
    recordRun: async (run) => {
      runs.push(run);
      cursor = run.nextCursor;
    },
  };
  return { docs, deps, log, runs, results, getCursor: () => cursor, setCursor: (c: string | null) => void (cursor = c) };
}
const ids = (n: number, from = 0) => Array.from({ length: n }, (_, i) => `tx_${String(i + from).padStart(3, "0")}`);
const run = (w: ReturnType<typeof world>, o: Partial<Parameters<typeof runPendingRecheckRecovery>[2]> = {}) =>
  runPendingRecheckRecovery({ mode: "test" }, w.deps, { now: () => NOW, isSessionId: isSession, pageSize: 10, maxPages: 10, ...o });

describe("runPendingRecheckRecovery（回収の実行）", () => {
  it("対象外の記録が先頭に多くても、続きを読み進めて後ろの対象を回収する（取り残さない）", async () => {
    const w = world([...ids(20).map((id) => ({ id, c: base({ createdAt: new Date(NOW.getTime() - 60_000) }) })), ...ids(5, 20).map((id) => ({ id, c: base() }))]);
    const s = await run(w);
    expect(s.attempted).toBe(5);
    expect(s.results.done).toBe(5);
    expect(s.skipped.too_new).toBe(20);
    expect([s.status, s.deferred, s.nextCursor]).toEqual(["completed", false, null]);
  });

  it("1回は最大10件。次の実行は続きから読み、一周して戻った記録（間隔待ち）は試さない。同じ記録は1回の実行で1回だけ", async () => {
    const w = world(ids(15).map((id) => ({ id, c: base() })), { recheck: async () => ({ status: "duplicate", recheck: "pending" }) });
    const s1 = await run(w);
    expect([s1.attempted, s1.deferred, s1.status, s1.nextCursor]).toEqual([10, true, "partial", "tx_009"]);
    const s2 = await run(w);
    expect(s2.attempted).toBe(5); // tx_010〜014
    expect(s2.skipped.backoff).toBe(10); // 最初に戻った tx_000〜009 は前回の試行から20時間たっていない
    expect([s2.deferred, s2.nextCursor]).toEqual([false, null]);
    const claims = w.log.filter((l) => l.startsWith("recheck:"));
    expect(new Set(claims).size).toBe(15); // 15件すべてを1回ずつ試した（同じ記録の重複なし）
  });

  it("前回の続きの位置から読み、最後まで読んだら最初に戻る（途中の位置からでも全体を一周）", async () => {
    const w = world(ids(6).map((id) => ({ id, c: base() })));
    w.setCursor("tx_002");
    const s = await run(w, { pageSize: 2 });
    expect(s.attempted).toBe(6);
    expect(w.log.filter((l) => l.startsWith("recheck:"))).toEqual(["recheck:tx_003", "recheck:tx_004", "recheck:tx_005", "recheck:tx_000", "recheck:tx_001", "recheck:tx_002"]);
    expect(s.nextCursor).toBeNull();
  });

  it("開始から60秒（または notAfter）を過ぎたら新しい回収を始めない。次回はまだ見ていない記録から", async () => {
    let t = NOW.getTime();
    const w = world(ids(5).map((id) => ({ id, c: base() })), {
      recheck: async () => {
        t += 25_000; // 1件25秒かかる
        return { status: "duplicate", recheck: "done" };
      },
    });
    const s = await run(w, { now: () => new Date(t) });
    // 0秒・25秒・50秒に開始（3件）、75秒の時点では始めない
    expect([s.attempted, s.deferred, s.nextCursor]).toEqual([3, true, "tx_002"]);
    t = NOW.getTime();
    const w2 = world(ids(3).map((id) => ({ id, c: base() })));
    const s2 = await run(w2, { notAfter: new Date(NOW.getTime() - 1) });
    expect([s2.attempted, s2.deferred]).toEqual([0, true]);
  });

  it("Stripe API の例外：試行の回数は先に記録済み（claim の後に例外）・結果は error・PENDING のまま・実行は partial", async () => {
    const w = world([{ id: "tx_a", c: base() }], {
      recheck: async () => {
        throw Object.assign(new Error("timeout"), { name: "StripeConnectionError" });
      },
    });
    const s = await run(w);
    expect(w.log).toEqual(["list:-", "claim:tx_a", "recheck:tx_a"]);
    expect(w.docs.get("tx_a")!.recoveryAttempts).toBe(1);
    expect(w.docs.get("tx_a")!.recheckState).toBe("PENDING");
    expect(w.results).toEqual([{ id: "tx_a", result: "error", errorName: "StripeConnectionError" }]);
    expect([s.results.error, s.status]).toEqual([1, "partial"]);
  });

  it("決済記録が無い・Session と決済が一致しないなどの拒否は rejected（理由を記録）。作成された（confirmed）も異常", async () => {
    const w = world([{ id: "tx_a", c: base() }, { id: "tx_b", c: base() }], {
      recheck: async (id) => (id === "tx_a" ? { status: "rejected", reason: "transaction_missing" } : { status: "confirmed" }),
    });
    const s = await run(w);
    expect(s.results.rejected).toBe(2);
    expect(w.results).toEqual([
      { id: "tx_a", result: "rejected", errorName: "transaction_missing" },
      { id: "tx_b", result: "rejected", errorName: "confirmed" },
    ]);
  });

  it("同時の実行が先に試した（claim で対象でなくなっていた）記録は試さない", async () => {
    const w = world([{ id: "tx_a", c: base() }]);
    const real = w.deps.claim;
    w.deps.claim = async (id, now) => {
      w.docs.get(id)!.recoveryLastAt = now; // 別の実行が直前に試した
      return real(id, now);
    };
    const s = await run(w);
    expect([s.attempted, s.skipped.claim_backoff]).toEqual([0, 1]);
    expect(w.log.some((l) => l.startsWith("recheck:"))).toBe(false);
  });

  it("対象外の記録では確定の処理を呼ばない。PENDING が無ければ何もしない", async () => {
    const w = world([{ id: "tx_a", c: base({ livemode: true }) }, { id: "tx_b", c: base({ recoveryAttempts: 6 }) }]);
    const s = await run(w);
    expect([s.attempted, s.skipped.mode_mismatch, s.skipped.max_attempts]).toEqual([0, 1, 1]);
    expect(w.log.filter((l) => !l.startsWith("list:"))).toEqual([]);
    const empty = world([]);
    const s0 = await run(empty);
    expect([s0.scanned, s0.status, s0.nextCursor]).toEqual([0, "completed", null]);
    expect(empty.runs).toHaveLength(1);
  });

  it("読み込みの失敗：failed で終わり、実行の記録は残す（続きの位置は進めない）", async () => {
    const w = world([{ id: "tx_a", c: base() }]);
    w.setCursor("tx_x");
    w.deps.listPage = async () => {
      throw Object.assign(new Error("unavailable"), { name: "FirebaseError" });
    };
    const s = await run(w);
    expect([s.status, s.errorName, s.nextCursor]).toEqual(["failed", "FirebaseError", "tx_x"]);
    expect(w.runs[0].status).toBe("failed");
  });
});

describe("組み込み（ソースの確認）", () => {
  const read = (p: string) => readFileSync(path.join(__dirname, "..", p), "utf8");
  it("回収は決済記録がある経路だけで確定の処理を呼ぶ（作成しない・通知の対象の PaymentIntent と照合）", () => {
    const src = read("src/lib/payments/recheck-recovery.ts");
    expect(src).toContain("confirmStripeCheckout(sessionId, rt, { expectedPaymentIntentId: paymentIntentId, requireExistingTransaction: true })");
  });
  it("確定の処理：requireExistingTransaction のときは、決済記録が無ければ作成の前に rejected（transaction_missing）", () => {
    const src = read("src/lib/payments/stripe-confirm.ts");
    const at = src.indexOf('if (opts.requireExistingTransaction) return { status: "rejected", reason: "transaction_missing" } as const;');
    expect(at).toBeGreaterThan(-1);
    expect(src.indexOf("tx.create(txRef,", at)).toBeGreaterThan(at);
    expect(src.lastIndexOf("if (existing.exists) {", at)).toBeGreaterThan(-1);
  });
  it("試行の記録（claim）はトランザクションで Stripe を呼ばない。定期処理は最後に、時間の区切りを渡して呼ぶ", () => {
    const fsr = read("src/lib/firestore/recheck-recovery.ts");
    expect(fsr).not.toMatch(/stripe-confirm|confirmStripeCheckout|retrieveStripe/);
    const cron = read("src/app/api/cron/maintenance/route.ts");
    // 段階の順序：メンテナンス → Webhook の復旧 → 再確認の回収（最後）
    expect(cron.indexOf('name: "webhookRecovery"')).toBeGreaterThan(cron.indexOf('name: "maintenance"'));
    expect(cron.indexOf('name: "recheckRecovery"')).toBeGreaterThan(cron.indexOf('name: "webhookRecovery"'));
    expect(cron).toContain("runCronRecheckRecovery(new Date(startedAt.getTime() + RECHECK_RECOVERY_NOT_AFTER_MS), signal)");
  });
});
