import { afterEach, describe, expect, it, vi } from "vitest";

// 運営画面の「占い権利を戻す」（サーバーの処理）。権限の確認・入力の確認がサーバーで行われることを確かめる（Firestore・Stripe には接続しない）
const calls = vi.hoisted(() => ({ resolve: [] as unknown[][], resolveDone: true, restore: [] as unknown[][], dismiss: [] as unknown[][], operator: "ok" as "ok" | "redirect", outcome: "restored" as string, refundDone: true, disputeOutcome: "dismissed" as string, revalidated: [] as string[] }));
vi.mock("next/cache", () => ({ revalidatePath: (p: string) => void calls.revalidated.push(p) }));
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
vi.mock("@/lib/firestore/payment-reviews", () => ({
  resolvePaymentReview: async (...args: unknown[]) => (calls.resolve.push(["review", ...args]), calls.resolveDone),
}));
vi.mock("@/lib/firestore/payment-alerts", () => ({
  resolvePaymentAlert: async (...args: unknown[]) => (calls.resolve.push(["alert", ...args]), calls.resolveDone),
}));
vi.mock("@/lib/payments/stripe-confirm", () => ({
  restoreStripeEntitlement: async (...args: unknown[]) => {
    calls.restore.push(args);
    return calls.outcome;
  },
  dismissStripeRefundReview: async (...args: unknown[]) => {
    calls.dismiss.push(["refund", ...args]);
    return calls.refundDone;
  },
  dismissStripeDisputeReview: async (...args: unknown[]) => {
    calls.dismiss.push(["dispute", ...args]);
    return calls.disputeOutcome;
  },
}));

const fd = (reason?: string) => {
  const f = new FormData();
  if (reason !== undefined) f.set("reason", reason);
  return f;
};

describe("占い権利を戻す（運営画面のサーバーの処理）", () => {
  afterEach(() => {
    calls.restore = [];
    calls.dismiss = [];
    calls.refundDone = true;
    calls.disputeOutcome = "dismissed";
    calls.revalidated = [];
    calls.operator = "ok";
    calls.outcome = "restored";
  });

  it("運営のログインが無ければ（店舗アカウント・ログインなし）、戻す処理を呼ばない（ログイン画面へ）", async () => {
    calls.operator = "redirect";
    const { restoreStripeEntitlementAction } = await import("@/app/admin/actions");
    await expect(restoreStripeEntitlementAction("stripe_pi_test_1", null, fd("理由"))).rejects.toThrow(/NEXT_REDIRECT/);
    expect(calls.restore).toHaveLength(0);
  });

  it("決済記録の ID の形が違えば、戻す処理を呼ばない", async () => {
    const { restoreStripeEntitlementAction } = await import("@/app/admin/actions");
    await expect(restoreStripeEntitlementAction("../stripe_pi", null, fd("理由"))).rejects.toThrow("invalid id");
    expect(calls.restore).toHaveLength(0);
  });

  it("運営なら、操作した運営と入力された理由をそのまま渡す。成功したら一覧を更新してから、決済履歴の画面に移動する（通知の表示だけのクエリ）", async () => {
    const { restoreStripeEntitlementAction } = await import("@/app/admin/actions");
    await expect(restoreStripeEntitlementAction("stripe_pi_test_1", null, fd("返金失敗のため"))).rejects.toThrow("NEXT_REDIRECT /admin/transactions?notice=entitlement_restored");
    expect(calls.restore).toEqual([["stripe_pi_test_1", { userId: "op-1", role: "OPERATOR" }, "返金失敗のため"]]);
    expect(calls.revalidated).toEqual(["/admin/transactions"]);
  });

  it("戻せない結果は、その理由を運営画面に表示する（成功にしない）", async () => {
    const { restoreStripeEntitlementAction } = await import("@/app/admin/actions");
    for (const [outcome, msg] of [["dispute_open", /異議申し立て/], ["reason_required", /理由を入力/], ["stripe_unavailable", /Stripe/], ["state_changed", /状態が変わりました/]] as const) {
      calls.outcome = outcome;
      const r = await restoreStripeEntitlementAction("stripe_pi_test_1", null, fd("")); // 拒否は移動しない（例外にならない）
      expect(r?.ok).toBeUndefined();
      expect(r?.message).toMatch(msg);
    }
  });
});

describe("確認済みにする（返金・異議申し立て）のサーバーの処理", () => {
  afterEach(() => {
    calls.dismiss = [];
    calls.revalidated = [];
    calls.operator = "ok";
    calls.refundDone = true;
    calls.disputeOutcome = "dismissed";
  });

  it("運営のログインが無ければ、確認済みにする処理を呼ばない", async () => {
    calls.operator = "redirect";
    const { dismissStripeRefundReviewAction, dismissStripeDisputeReviewAction } = await import("@/app/admin/actions");
    await expect(dismissStripeRefundReviewAction("stripe_pi_test_1", null)).rejects.toThrow("NEXT_REDIRECT /admin/login");
    await expect(dismissStripeDisputeReviewAction("stripe_pi_test_1", null)).rejects.toThrow("NEXT_REDIRECT /admin/login");
    expect(calls.dismiss).toHaveLength(0);
  });

  it("完了したら一覧を更新してから、決済履歴の画面に移動する（固定の通知の表示だけのクエリ）", async () => {
    const { dismissStripeRefundReviewAction, dismissStripeDisputeReviewAction } = await import("@/app/admin/actions");
    await expect(dismissStripeRefundReviewAction("stripe_pi_test_1", null)).rejects.toThrow("NEXT_REDIRECT /admin/transactions?notice=refund_reviewed");
    await expect(dismissStripeDisputeReviewAction("stripe_pi_test_2", null)).rejects.toThrow("NEXT_REDIRECT /admin/transactions?notice=dispute_reviewed");
    expect(calls.dismiss).toEqual([
      ["refund", "stripe_pi_test_1", { userId: "op-1", role: "OPERATOR" }],
      ["dispute", "stripe_pi_test_2", { userId: "op-1", role: "OPERATOR" }],
    ]);
    expect(calls.revalidated).toEqual(["/admin/transactions", "/admin/transactions"]);
  });

  it("完了できない（対応中・確認済み）ときは移動せず、理由を返す", async () => {
    const { dismissStripeRefundReviewAction, dismissStripeDisputeReviewAction } = await import("@/app/admin/actions");
    calls.disputeOutcome = "still_open";
    expect(await dismissStripeDisputeReviewAction("stripe_pi_test_1", null)).toEqual({ message: "まだ対応中です。Stripe で結果が出るまで、精算の保留は続きます。" });
    calls.disputeOutcome = "not_found";
    expect(await dismissStripeDisputeReviewAction("stripe_pi_test_1", null)).toEqual({ message: "すでに確認済みです。" });
    calls.refundDone = false;
    expect(await dismissStripeRefundReviewAction("stripe_pi_test_1", null)).toEqual({ message: "すでに確認済みです。" });
  });
});

describe("決済履歴の画面の成功の通知", () => {
  it("決まった値だけを、固定の文言で表示する（知らない値・文言を書き換える値は表示しない）", async () => {
    const { ADMIN_TX_NOTICES, adminTxNoticeOf, adminTxNoticeUrl } = await import("@/lib/admin/transaction-notices");
    expect(ADMIN_TX_NOTICES).toEqual({ entitlement_restored: "占い権利を復旧しました（有効期限は復旧時から24時間）", refund_reviewed: "返金の確認を完了しました", dispute_reviewed: "異議申し立ての確認を完了しました" });
    for (const k of ["entitlement_restored", "refund_reviewed", "dispute_reviewed"] as const) expect(adminTxNoticeOf(k)).toBe(k);
    for (const v of [undefined, null, "", "1", "constructor", "__proto__", "toString", "<script>", "refund_reviewed ", ["refund_reviewed"]]) expect(adminTxNoticeOf(v)).toBeNull();
    expect(adminTxNoticeUrl("refund_reviewed")).toBe("/admin/transactions?notice=refund_reviewed");
    // 通知に決済ID・理由などは含めない（固定の文言だけ）
    for (const t of Object.values(ADMIN_TX_NOTICES)) expect(t).not.toMatch(/stripe_|pi_|cs_|ch_|\{|\$/);
  });
});

describe("決済要確認・決済監視の「確認済みにする」", () => {
  afterEach(() => {
    calls.resolve = [];
    calls.revalidated = [];
    calls.operator = "ok";
    calls.resolveDone = true;
  });

  it("移動先の URL：絞り込みは決まった値だけ引き継ぎ、通知は固定のキー", async () => {
    const { paymentReviewsUrl, paymentMonitorUrl, REVIEW_RESOLVED_NOTICE, ALERT_RESOLVED_NOTICE } = await import("@/lib/admin/list-notices");
    expect(paymentReviewsUrl({ status: null }, true)).toBe("/admin/payment-reviews?notice=review_resolved");
    expect(paymentReviewsUrl({ status: "all" }, true)).toBe("/admin/payment-reviews?status=all&notice=review_resolved");
    expect(paymentReviewsUrl({ status: "RESOLVED" }, false)).toBe("/admin/payment-reviews?status=RESOLVED");
    expect(paymentMonitorUrl({ status: "OPEN", mode: "test" }, true)).toBe("/admin/payment-monitor?status=OPEN&mode=test&notice=alert_resolved");
    expect(paymentMonitorUrl({ status: "all", mode: null }, true)).toBe("/admin/payment-monitor?status=all&notice=alert_resolved");
    // 決まっていない値・外部の URL・入れ子の値は引き継がない（既定の絞り込みにする）
    for (const f of [undefined, null, "x", { status: "https://evil.example" }, { status: "OPEN&notice=x" }, { status: ["all"] }, { mode: "LIVE" }]) {
      expect(paymentReviewsUrl(f, true)).toBe("/admin/payment-reviews?notice=review_resolved");
      expect(paymentMonitorUrl(f, true)).toBe("/admin/payment-monitor?notice=alert_resolved");
    }
    for (const t of [REVIEW_RESOLVED_NOTICE, ALERT_RESOLVED_NOTICE]) expect(t).not.toMatch(/stripe_|pi_|cs_|ch_|Error|\{/);
  });

  it("運営のログインが無ければ、確認済みにする処理を呼ばない", async () => {
    calls.operator = "redirect";
    const { resolvePaymentReviewAction, resolvePaymentAlertAction } = await import("@/app/admin/actions");
    await expect(resolvePaymentReviewAction("review_1", {}, null)).rejects.toThrow("NEXT_REDIRECT /admin/login");
    await expect(resolvePaymentAlertAction("alert_1", {}, null)).rejects.toThrow("NEXT_REDIRECT /admin/login");
    expect(calls.resolve).toHaveLength(0);
  });

  it("完了したら一覧を更新してから、元の画面（絞り込みはそのまま）に移動する。完了できなければ移動せず理由を返す", async () => {
    const { resolvePaymentReviewAction, resolvePaymentAlertAction } = await import("@/app/admin/actions");
    await expect(resolvePaymentReviewAction("review_1", { status: "all" }, null)).rejects.toThrow("NEXT_REDIRECT /admin/payment-reviews?status=all&notice=review_resolved");
    await expect(resolvePaymentAlertAction("alert_1", { status: "OPEN", mode: "live" }, null)).rejects.toThrow("NEXT_REDIRECT /admin/payment-monitor?status=OPEN&mode=live&notice=alert_resolved");
    expect(calls.resolve).toEqual([
      ["review", "review_1", { userId: "op-1", role: "OPERATOR" }],
      ["alert", "alert_1", { userId: "op-1", role: "OPERATOR" }],
    ]);
    expect(calls.revalidated).toEqual(["/admin/payment-reviews", "/admin/payment-monitor"]);
    calls.resolveDone = false;
    expect(await resolvePaymentReviewAction("review_1", {}, null)).toEqual({ message: "すでに確認済みです。" });
    expect(await resolvePaymentAlertAction("alert_1", {}, null)).toEqual({ message: "すでに確認済みです。" });
  });
});
