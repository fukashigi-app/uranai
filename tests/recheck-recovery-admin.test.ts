import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  classifyPendingRecheck,
  manualRecheckBlock,
  RECHECK_ALERT_MIN_AGE_MS,
  RECHECK_MANUAL_MIN_AGE_MS,
  RECHECK_RECOVERY_MAX_ATTEMPTS,
  RECHECK_STALLED_MS,
  recheckRecoverySkipReason,
  type RecheckRecoveryCandidate,
} from "@/lib/payments/recheck-recovery-rules";
import { manualRecheckTransaction, type ManualRecheckDeps } from "@/lib/payments/recheck-recovery";

const NOW = new Date("2026-11-03T00:00:00Z");
const ago = (ms: number) => new Date(NOW.getTime() - ms);
const isSession = (v: unknown) => typeof v === "string" && /^cs_test_[A-Za-z0-9]+$/.test(v);
const base = (over: Partial<RecheckRecoveryCandidate> = {}): RecheckRecoveryCandidate => ({
  paymentProvider: "stripe",
  recheckState: "PENDING",
  livemode: false,
  createdAt: ago(2 * 60 * 60 * 1000),
  recoveryAttempts: 0,
  recoveryLastAt: null,
  sessionId: "cs_test_abc",
  paymentIntentId: "pi_abc",
  recoveryLastResult: null,
  manualUntil: null,
  ...over,
});

describe("classifyPendingRecheck（決済監視・運営画面での区別）", () => {
  it("作成から60分未満・PENDING でないものは異常として扱わない（境界：ちょうど60分は対象）", () => {
    expect(classifyPendingRecheck(base({ createdAt: ago(RECHECK_ALERT_MIN_AGE_MS - 1) }), NOW)).toBeNull();
    expect(classifyPendingRecheck(base({ createdAt: ago(RECHECK_ALERT_MIN_AGE_MS) }), NOW)).toBe("pending");
    expect(classifyPendingRecheck(base({ recheckState: "DONE" }), NOW)).toBeNull();
    expect(classifyPendingRecheck(base({ createdAt: null }), NOW)).toBeNull();
  });
  it("7日より古い PENDING も対象（期間の制限なし）", () => {
    expect(classifyPendingRecheck(base({ createdAt: ago(30 * 86_400_000) }), NOW)).toBe("pending");
  });
  it("拒否・途中で停止・上限・自動の回収の対象を区別する（拒否 → 停止 → 上限の順）", () => {
    expect(classifyPendingRecheck(base({ recoveryLastResult: "rejected", recoveryAttempts: RECHECK_RECOVERY_MAX_ATTEMPTS }), NOW)).toBe("rejected");
    expect(classifyPendingRecheck(base({ recoveryLastResult: "started", recoveryLastAt: ago(RECHECK_STALLED_MS) }), NOW)).toBe("stalled");
    expect(classifyPendingRecheck(base({ recoveryLastResult: "started", recoveryLastAt: null }), NOW)).toBe("stalled");
    // started でも、止まったとみなす時間より前なら実行中（自動の回収の対象のまま）
    expect(classifyPendingRecheck(base({ recoveryLastResult: "started", recoveryLastAt: ago(RECHECK_STALLED_MS - 1) }), NOW)).toBe("pending");
    expect(classifyPendingRecheck(base({ recoveryAttempts: RECHECK_RECOVERY_MAX_ATTEMPTS, recoveryLastResult: "pending" }), NOW)).toBe("exhausted");
    expect(classifyPendingRecheck(base({ recoveryAttempts: 2, recoveryLastResult: "error" }), NOW)).toBe("pending");
  });
});

describe("自動の回収と手動の再確認の二重の実行の防止", () => {
  it("手動の再確認の実行中（印の期限内）は、自動の回収の対象外。期限が過ぎれば対象", () => {
    expect(recheckRecoverySkipReason(base({ manualUntil: new Date(NOW.getTime() + 1) }), NOW, "test", isSession)).toBe("manual_running");
    expect(recheckRecoverySkipReason(base({ manualUntil: NOW }), NOW, "test", isSession)).toBeNull();
  });
});

describe("manualRecheckBlock（手動の再確認を実行できるか）", () => {
  const block = (over: Partial<RecheckRecoveryCandidate>, mode: "test" | "live" = "test") => manualRecheckBlock(base(over), NOW, mode, isSession);
  it("実行できる：回数の上限・間隔待ちでも運営は実行できる。途中で止まった自動の回収も実行できる", () => {
    expect(block({})).toBeNull();
    expect(block({ recoveryAttempts: RECHECK_RECOVERY_MAX_ATTEMPTS + 2, recoveryLastAt: ago(1000), recoveryLastResult: "pending" })).toBeNull();
    expect(block({ recoveryLastResult: "started", recoveryLastAt: ago(RECHECK_STALLED_MS) })).toBeNull();
  });
  it("実行しない：PENDING でない・Stripe 以外・モード違い・ID が無い・作成の直後・手動の実行中・自動の回収の実行中", () => {
    expect(block({ recheckState: "DONE" })).toBe("not_pending");
    expect(block({ paymentProvider: "mock" })).toBe("not_stripe");
    expect(block({ livemode: true })).toBe("mode_mismatch");
    expect(block({ livemode: false }, "live")).toBe("mode_mismatch");
    expect(block({ sessionId: "cs_live_x" })).toBe("invalid_record");
    expect(block({ paymentIntentId: undefined })).toBe("invalid_record");
    expect(block({ createdAt: ago(RECHECK_MANUAL_MIN_AGE_MS - 1) })).toBe("too_new");
    expect(block({ createdAt: ago(RECHECK_MANUAL_MIN_AGE_MS) })).toBeNull();
    expect(block({ manualUntil: new Date(NOW.getTime() + 60_000) })).toBe("manual_running");
    expect(block({ recoveryLastResult: "started", recoveryLastAt: ago(60_000) })).toBe("auto_running");
  });
});

// ---- 手動の再確認の流れ（依存をメモリ上で再現） ----
function deps(over: Partial<ManualRecheckDeps> = {}) {
  const log: string[] = [];
  const audits: Parameters<ManualRecheckDeps["audit"]>[0][] = [];
  const finished: { result: string; errorName: string | null; token: string }[] = [];
  const d: ManualRecheckDeps = {
    claim: async (txId, _now, actorUserId) => {
      log.push(`claim:${txId}:${actorUserId}`);
      return { claimed: true, token: "tok", sessionId: "cs_test_abc", paymentIntentId: "pi_abc", storeId: "s1", before: { recheckState: "PENDING", paymentStatus: "REFUNDED", refundStatus: "succeeded", disputeStatus: null } };
    },
    recheck: async () => {
      log.push("recheck");
      return { status: "refunded", recheck: "done" };
    },
    finish: async (_txId, token, result, errorName) => {
      log.push("finish");
      finished.push({ result, errorName, token });
      return { recheckState: result === "done" ? "DONE" : "PENDING", paymentStatus: "REFUNDED", refundStatus: "succeeded", disputeStatus: null };
    },
    audit: async (a) => {
      log.push("audit");
      audits.push(a);
    },
    ...over,
  };
  return { d, log, audits, finished };
}
const ACTOR = { userId: "op-1", role: "OPERATOR" as const };

describe("manualRecheckTransaction（手動の再確認）", () => {
  it("完了：試行の記録 → 再確認（トランザクションの外）→ 結果の記録・印の解除 → 監査ログ（実行者・前後の状態・結果）。返金済みは返金済みのまま", async () => {
    const w = deps();
    const o = await manualRecheckTransaction("stripe_pi_abc", ACTOR, w.d, NOW);
    expect(w.log).toEqual(["claim:stripe_pi_abc:op-1", "recheck", "finish", "audit"]);
    expect(o).toEqual({ started: true, result: "done", errorName: null, after: { recheckState: "DONE", paymentStatus: "REFUNDED", refundStatus: "succeeded", disputeStatus: null } });
    expect(w.finished).toEqual([{ result: "done", errorName: null, token: "tok" }]);
    expect(w.audits[0]).toMatchObject({ actorUserId: "op-1", actorRole: "OPERATOR", txId: "stripe_pi_abc", storeId: "s1", before: { paymentStatus: "REFUNDED" }, after: { result: "done", paymentStatus: "REFUNDED", recheckState: "DONE" } });
  });

  it("実行できない（実行中・モード違いなど）：再確認・記録・監査ログを行わない", async () => {
    const w = deps({ claim: async () => ({ claimed: false, reason: "manual_running" }) });
    const o = await manualRecheckTransaction("stripe_pi_abc", ACTOR, w.d, NOW);
    expect(o).toEqual({ started: false, reason: "manual_running" });
    expect(w.log).toEqual([]);
  });

  it("Stripe の例外：結果は error で記録し、印を外し、監査ログも残す（例外を外に出さない）", async () => {
    const w = deps({
      recheck: async () => {
        throw Object.assign(new Error("timeout"), { name: "StripeConnectionError" });
      },
    });
    const o = await manualRecheckTransaction("stripe_pi_abc", ACTOR, w.d, NOW);
    expect(o).toMatchObject({ started: true, result: "error", errorName: "StripeConnectionError" });
    expect(w.finished).toEqual([{ result: "error", errorName: "StripeConnectionError", token: "tok" }]);
    expect(w.audits[0].after).toMatchObject({ result: "error", errorName: "StripeConnectionError" });
  });

  it("確定の処理の拒否（決済記録が無いなど）は rejected と理由。新しく作成された（confirmed）も異常", async () => {
    const w = deps({ recheck: async () => ({ status: "rejected", reason: "transaction_missing" }) });
    expect(await manualRecheckTransaction("stripe_pi_abc", ACTOR, w.d, NOW)).toMatchObject({ result: "rejected", errorName: "transaction_missing" });
    const w2 = deps({ recheck: async () => ({ status: "confirmed" }) });
    expect(await manualRecheckTransaction("stripe_pi_abc", ACTOR, w2.d, NOW)).toMatchObject({ result: "rejected", errorName: "confirmed" });
  });

  it("再確認が完了しなかった（pending）：結果は pending。監査ログの失敗では例外にしない", async () => {
    const w = deps({
      recheck: async () => ({ status: "duplicate", recheck: "pending" }),
      audit: async () => {
        throw new Error("audit down");
      },
    });
    await expect(manualRecheckTransaction("stripe_pi_abc", ACTOR, w.d, NOW)).resolves.toMatchObject({ started: true, result: "pending" });
  });
});

describe("組み込み（ソースの確認）", () => {
  const read = (p: string) => readFileSync(path.join(__dirname, "..", p), "utf8");
  it("手動の再確認：運営のログインを最初に確かめ、決済記録がある経路だけで確定の処理を呼ぶ", () => {
    const actions = read("src/app/admin/actions.ts");
    const fn = actions.slice(actions.indexOf("export async function recheckTransactionAction("));
    expect(fn.indexOf("await operator()")).toBeGreaterThan(-1);
    expect(fn.indexOf("await operator()")).toBeLessThan(fn.indexOf("manualRecheckTransaction("));
    expect(fn).toMatch(/\/\^stripe_pi_\[A-Za-z0-9_\]\{1,200\}\$\/\.test\(transactionId\)/);
    const rr = read("src/lib/payments/recheck-recovery.ts");
    const manual = rr.slice(rr.indexOf("export async function defaultManualRecheckDeps("));
    expect(manual).toContain("confirmStripeCheckout(sessionId, rt, { expectedPaymentIntentId: paymentIntentId, requireExistingTransaction: true })");
    expect(manual).toContain('action: "transaction.recheck"');
  });
  it("試行の記録・印の処理（Firestore）は Stripe を呼ばない。一覧はページの上限つき", () => {
    const fsr = read("src/lib/firestore/recheck-recovery.ts");
    expect(fsr).not.toMatch(/stripe-confirm|confirmStripeCheckout|retrieveStripe/);
    expect(fsr).toContain("PENDING_RECHECK_ADMIN_PAGE_MAX = 50");
    expect(fsr).toMatch(/Math\.min\(PENDING_RECHECK_ADMIN_PAGE_MAX/);
  });
  it("決済監視：PENDING を期間の制限なく読み（作成の時刻で絞らない）、recheck_pending として区別つきで記録する", () => {
    const mon = read("src/lib/payments/payment-monitor.ts");
    const step = mon.slice(mon.indexOf('await step("決済の確定の後の再確認"'), mon.indexOf("// 4. 確定済みの精算"));
    expect(step).toContain('where("recheckState", "==", "PENDING")');
    expect(step).not.toContain("since");
    expect(step).toContain('kind: "recheck_pending"');
    expect(step).toContain("recheckStatus: status");
  });
});
