import { describe, expect, it } from "vitest";
import { stripeProductName } from "@/lib/payments/stripe-checkout";

describe("Stripe の決済画面に表示する商品名（決済のモードで決める）", () => {
  it("本番（live）：「テスト決済」を付けない。サービス名と占いの名前はそのまま", () => {
    expect(stripeProductName("100円占い", "星座占い", "live")).toBe("100円占い 星座占い");
    for (const label of ["星座占い", "血液型占い", "生年月日占い"]) {
      const name = stripeProductName("100円占い", label, "live");
      expect(name).not.toContain("テスト");
      expect(name).toBe(`100円占い ${label}`);
    }
  });

  it("Sandbox（test）：今までどおり「（テスト決済）」を付ける", () => {
    expect(stripeProductName("100円占い", "星座占い", "test")).toBe("100円占い 星座占い（テスト決済）");
    expect(stripeProductName("100円占い", "占い", "test")).toBe("100円占い 占い（テスト決済）");
  });
});
