import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { isSalesPayment, isSettlementPayment, paymentKind } from "@/lib/payments/kind";
import { entitledStoreShare } from "@/lib/payments/settlement-rules";

/** PAY.JP の廃止：決済の経路・接続先・カード入力フォームが残っていないこと。過去の記録は読めること */
const ROOT = path.resolve(__dirname, "..");
const SECRET = "unit-Xq7#mP2$vL9@wR4!nT6&kB8*hJ3%";

function filesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = path.join(dir, f);
    return statSync(p).isDirectory() ? filesUnder(p) : [p];
  });
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("PAY.JP の決済の経路を削除した", () => {
  it("PAY.JP のクライアント・Webhook・カード入力フォームのファイルが無い", () => {
    for (const f of ["src/lib/payments/payjp.ts", "src/app/api/webhooks/payjp/route.ts", "src/components/public/payment-form.tsx"]) {
      expect(existsSync(path.join(ROOT, f)), f).toBe(false);
    }
  });

  it("アプリのコードに PAY.JP の接続先・スクリプトが無い（api.pay.jp・js.pay.jp）。CSP も許可しない", () => {
    const src = filesUnder(path.join(ROOT, "src")).filter((f) => /\.(ts|tsx)$/.test(f));
    for (const f of src) expect(readFileSync(f, "utf8"), f).not.toMatch(/api\.pay\.jp|js\.pay\.jp|https:\/\/[^"'\s]*pay\.jp/);
    const config = readFileSync(path.join(ROOT, "next.config.ts"), "utf8");
    expect(config).not.toMatch(/pay\.jp/);
    expect(config).toContain("frame-src 'none'");
    expect(config).toContain("connect-src 'self'");
  });

  it("PAYMENT_PROVIDER=payjp・PAYJP_* が残っていても起動は止めず、PAY.JP にも疑似決済にも流れない", async () => {
    vi.stubEnv("SESSION_SECRET", SECRET);
    vi.stubEnv("PAYMENT_PROVIDER", "payjp");
    vi.stubEnv("PAYJP_PUBLIC_KEY", "pk_live_unit");
    vi.stubEnv("PAYJP_SECRET_KEY", "sk_live_unit");
    vi.stubEnv("PAYJP_WEBHOOK_TOKEN", "whook_unit");
    const { env } = await import("@/lib/env");
    expect(env().PAYMENT_PROVIDER).toBeNull();
    expect(Object.keys(env())).not.toContain("PAYJP_SECRET_KEY");
    const payments = await import("@/lib/payments");
    expect(() => payments.activeProvider()).toThrow(payments.PaymentUnavailableError);
    expect(() => payments.getProvider("payjp" as never)).toThrow(payments.PaymentUnavailableError);
    expect(payments.isProviderId("payjp")).toBe(false);
  });

  it("疑似決済の支払いの API（/api/checkout/pay）は PAYMENT_PROVIDER=mock 以外では 404（PAY.JP のカード決済の受付は無い）", async () => {
    const post = async (e: Record<string, string | undefined>) => {
      vi.unstubAllEnvs();
      vi.resetModules();
      vi.stubEnv("SESSION_SECRET", SECRET);
      for (const [k, v] of Object.entries(e)) vi.stubEnv(k, v);
      const { POST } = await import("@/app/api/checkout/pay/route");
      const res = await POST(new Request("http://localhost/api/checkout/pay", { method: "POST", headers: { origin: "http://localhost", "content-type": "application/json" }, body: JSON.stringify({ cardToken: "tok_x" }) }));
      return res.status;
    };
    expect(await post({ PAYMENT_PROVIDER: "payjp", PAYJP_SECRET_KEY: "sk_live_unit", PAYJP_PUBLIC_KEY: "pk_live_unit", PAYJP_WEBHOOK_TOKEN: "whook_unit" })).toBe(404);
    expect(await post({ PAYMENT_PROVIDER: "stripe" })).toBe(404);
    expect(await post({ PAYMENT_PROVIDER: undefined })).toBe(404); // 未設定
    // 疑似決済は本番では使えない（ALLOW_MOCK_PAYMENTS_IN_PRODUCTION=true でも）
    expect(await post({ PAYMENT_PROVIDER: "mock", VERCEL_ENV: "production", NODE_ENV: "production", ALLOW_MOCK_PAYMENTS_IN_PRODUCTION: "true" })).toBe(404);
  });

  it("疑似決済の Webhook も PAYMENT_PROVIDER=mock 以外・本番では 404", async () => {
    for (const e of [{ PAYMENT_PROVIDER: "payjp" }, { PAYMENT_PROVIDER: "stripe" }, { PAYMENT_PROVIDER: "mock", VERCEL_ENV: "production", NODE_ENV: "production", ALLOW_MOCK_PAYMENTS_IN_PRODUCTION: "true" }]) {
      vi.unstubAllEnvs();
      vi.resetModules();
      vi.stubEnv("SESSION_SECRET", SECRET);
      for (const [k, v] of Object.entries(e)) vi.stubEnv(k, v);
      const { POST } = await import("@/app/api/webhooks/mock/route");
      const res = await POST(new Request("http://localhost/api/webhooks/mock", { method: "POST", body: "{}" }));
      expect(res.status, JSON.stringify(e)).toBe(404);
    }
  });
});

describe("過去の PAY.JP の記録は読める（削除・変更しない）", () => {
  it("種類・売上・精算の判定は paymentProvider と livemode から（外部に問い合わせない）", () => {
    expect(paymentKind("payjp", true)).toBe("live");
    expect(paymentKind("payjp", false)).toBe("test");
    expect(isSalesPayment("payjp", true, {})).toBe(true);
    expect(isSettlementPayment("payjp", false)).toBe(false);
    // 精算の取り分の判定も同じ規則で読める（記録時の取り分のまま）
    const rec = { paymentProvider: "payjp", livemode: true, paymentStatus: "SUCCEEDED", amount: 100, storeShare: 30, storeShareBps: 3000 };
    expect(entitledStoreShare(rec)).toBe(30);
    expect(entitledStoreShare({ ...rec, paymentStatus: "REFUNDED" })).toBe(0);
  });
});
