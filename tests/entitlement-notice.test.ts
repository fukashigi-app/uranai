import { describe, expect, it } from "vitest";
import { entitlementNoticeFor, EXISTING_ENTITLEMENT_PATH, isExistingEntitlementHint, PAYMENT_NOTICE_WINDOW_MS } from "@/lib/fortune/entitlement-notice";

const now = new Date("2026-11-06T12:00:00Z");
const ago = (ms: number) => new Date(now.getTime() - ms);

describe("占いの入力画面の案内（支払い完了か、購入済みの権利か）", () => {
  it("決済の確定の直後（サーバーの記録の時刻から10分以内）だけ「お支払いが完了しました」", () => {
    expect(entitlementNoticeFor({ paidAt: ago(5_000), restored: false, reuseHint: false, now })).toBe("payment_completed");
    expect(entitlementNoticeFor({ paidAt: ago(PAYMENT_NOTICE_WINDOW_MS), restored: false, reuseHint: false, now })).toBe("payment_completed");
    expect(entitlementNoticeFor({ paidAt: ago(-30_000), restored: false, reuseHint: false, now })).toBe("payment_completed"); // 時計の小さなずれ
  });

  it("時間がたってから開いた（直接のアクセス・再読み込み・戻る）なら「購入済みの占い権利があります」", () => {
    expect(entitlementNoticeFor({ paidAt: ago(PAYMENT_NOTICE_WINDOW_MS + 1), restored: false, reuseHint: false, now })).toBe("existing_entitlement");
    expect(entitlementNoticeFor({ paidAt: ago(23 * 3600_000), restored: false, reuseHint: false, now })).toBe("existing_entitlement");
    expect(entitlementNoticeFor({ paidAt: ago(-10 * 60_000), restored: false, reuseHint: false, now })).toBe("existing_entitlement"); // 大きく未来の時刻は信用しない
  });

  it("既存の権利の再利用の導線・運営が戻した権利・作成時刻が不明なら、直後でも支払い完了とは表示しない", () => {
    expect(entitlementNoticeFor({ paidAt: ago(1_000), restored: false, reuseHint: true, now })).toBe("existing_entitlement");
    expect(entitlementNoticeFor({ paidAt: ago(1_000), restored: true, reuseHint: false, now })).toBe("existing_entitlement");
    expect(entitlementNoticeFor({ paidAt: null, restored: false, reuseHint: false, now })).toBe("existing_entitlement");
  });

  it("URL の値は「再利用」のときだけ認める（支払い完了に上げる値は無い）", () => {
    expect(EXISTING_ENTITLEMENT_PATH).toBe("/fortune/input?entitlement=existing");
    expect(isExistingEntitlementHint("existing")).toBe(true);
    expect(isExistingEntitlementHint(["existing", "paid"])).toBe(true);
    for (const v of [undefined, "", "paid", "completed", "EXISTING", ["paid"], 1]) expect(isExistingEntitlementHint(v)).toBe(false);
  });
});
