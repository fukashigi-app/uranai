import { afterEach, describe, expect, it, vi } from "vitest";

// 運営画面の「占い権利を戻す」（サーバーの処理）。権限の確認・入力の確認がサーバーで行われることを確かめる（Firestore・Stripe には接続しない）
const calls = vi.hoisted(() => ({ restore: [] as unknown[][], operator: "ok" as "ok" | "redirect", outcome: "restored" as string }));
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
vi.mock("@/lib/payments/stripe-confirm", () => ({
  restoreStripeEntitlement: async (...args: unknown[]) => {
    calls.restore.push(args);
    return calls.outcome;
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

  it("運営なら、操作した運営と入力された理由をそのまま渡す（理由の確認は戻す処理の中で行う）", async () => {
    const { restoreStripeEntitlementAction } = await import("@/app/admin/actions");
    const r = await restoreStripeEntitlementAction("stripe_pi_test_1", null, fd("返金失敗のため"));
    expect(r).toMatchObject({ ok: true });
    expect(calls.restore).toEqual([["stripe_pi_test_1", { userId: "op-1", role: "OPERATOR" }, "返金失敗のため"]]);
  });

  it("戻せない結果は、その理由を運営画面に表示する（成功にしない）", async () => {
    const { restoreStripeEntitlementAction } = await import("@/app/admin/actions");
    for (const [outcome, msg] of [["dispute_open", /異議申し立て/], ["reason_required", /理由を入力/], ["stripe_unavailable", /Stripe/], ["state_changed", /状態が変わりました/]] as const) {
      calls.outcome = outcome;
      const r = await restoreStripeEntitlementAction("stripe_pi_test_1", null, fd(""));
      expect(r?.ok).toBeUndefined();
      expect(r?.message).toMatch(msg);
    }
  });
});
