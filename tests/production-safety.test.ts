import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isSalesPayment, isSettlementPayment, mockPaymentsCountable, paymentKind } from "@/lib/payments/kind";
import { salesKeys } from "@/lib/firestore/shared";
import { isPaidFlowBlocked, isProductionDeployment, isTestPaymentConfigured, isTestPaymentEnabled, productionConfigIssues } from "@/lib/env";

const PROD = { VERCEL_ENV: "production" };

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
  vi.doUnmock("@/lib/auth/session");
  vi.doUnmock("@/lib/services/maintenance");
  vi.doUnmock("@/lib/services/maintenance-status");
});

describe("決済の種類（テスト決済を売上・精算に含めない）", () => {
  it("livemode と決済会社から種類を判定する。livemode が無いものは判定不可", () => {
    expect(paymentKind("payjp", true)).toBe("live");
    expect(paymentKind("payjp", false)).toBe("test");
    expect(paymentKind("payjp", undefined)).toBe("unknown");
    expect(paymentKind("payjp", null)).toBe("unknown");
    expect(paymentKind("payjp", "true")).toBe("unknown"); // 文字列などは信用しない
    expect(paymentKind("mock", false)).toBe("mock");
    expect(paymentKind("mock", true)).toBe("mock");
  });

  it("売上に数えるのは本番環境の決済だけ。疑似決済は自動テスト環境（本番以外で PAYMENT_PROVIDER=mock）のときだけ", () => {
    const env = {};
    expect(isSalesPayment("payjp", true, env)).toBe(true);
    expect(isSalesPayment("payjp", false, env)).toBe(false);
    expect(isSalesPayment("payjp", undefined, env)).toBe(false);
    expect(isSalesPayment("mock", false, env)).toBe(false);
    expect(isSalesPayment("mock", false, { PAYMENT_PROVIDER: "mock" })).toBe(true);
    // Vercel の本番では PAYMENT_PROVIDER=mock でも疑似決済を数えない
    expect(mockPaymentsCountable({ PAYMENT_PROVIDER: "mock", ...PROD })).toBe(false);
    expect(isSalesPayment("mock", false, { PAYMENT_PROVIDER: "mock", ...PROD })).toBe(false);
    // テスト決済は自動テスト環境でも数えない
    expect(isSalesPayment("payjp", false, { PAYMENT_PROVIDER: "mock" })).toBe(false);
  });

  it("月次精算（振込）の対象は本番環境の決済だけ（疑似決済は自動テスト環境でも対象外）", () => {
    expect(isSettlementPayment("payjp", true)).toBe(true);
    for (const [p, l] of [["payjp", false], ["payjp", undefined], ["mock", true], ["mock", false]] as const) expect(isSettlementPayment(p, l)).toBe(false);
  });

  it("Firestore の集計用フィールド：テスト決済は countable=false で保存する", () => {
    vi.stubEnv("PAYMENT_PROVIDER", "");
    const at = new Date("2026-10-05T03:00:00Z");
    expect(salesKeys("s1", "payjp", "SUCCEEDED", at, true)).toMatchObject({ countable: true, cYm: "2026-10", cStore: "s1" });
    expect(salesKeys("s1", "payjp", "SUCCEEDED", at, false)).toMatchObject({ countable: false, cYm: null, cStore: null, cStoreYm: null, cDate: null });
    expect(salesKeys("s1", "payjp", "REFUNDED", at, true)).toMatchObject({ countable: false });
  });
});

describe("本番での無料テストモード・疑似決済の安全対策", () => {
  it("Vercel の本番では ENABLE_TEST_PAYMENT=true でも一般の利用者に無料テストを提供せず、有料の受付も止める", () => {
    const prodTest = { ...PROD, ENABLE_TEST_PAYMENT: "true" };
    expect(isProductionDeployment(prodTest)).toBe(true);
    expect(isTestPaymentConfigured(prodTest)).toBe(true);
    expect(isTestPaymentEnabled(prodTest)).toBe(false);
    expect(isPaidFlowBlocked(prodTest)).toBe(true);
  });

  it("開発・Preview・ローカルの next start では、これまでどおり無料テストが使える", () => {
    for (const env of [{ ENABLE_TEST_PAYMENT: "true" }, { ENABLE_TEST_PAYMENT: "true", VERCEL_ENV: "preview" }, { ENABLE_TEST_PAYMENT: "true", VERCEL_ENV: "development", NODE_ENV: "production" }]) {
      expect(isTestPaymentEnabled(env)).toBe(true);
      expect(isPaidFlowBlocked(env)).toBe(false);
    }
    expect(isTestPaymentEnabled({})).toBe(false);
    expect(isPaidFlowBlocked(PROD)).toBe(false);
  });

  it("本番の危険な設定を検出する（値そのものは返さない）。本番以外では何も返さない", () => {
    const secret = "sk_test_THIS_IS_SECRET_VALUE";
    const env = { ...PROD, ENABLE_TEST_PAYMENT: "true", PAYMENT_PROVIDER: "mock", ALLOW_MOCK_PAYMENTS_IN_PRODUCTION: "true", PAYJP_SECRET_KEY: secret, PAYJP_PUBLIC_KEY: "pk_live_PUBLICVALUE" };
    const issues = productionConfigIssues(env);
    expect(issues.filter((i) => i.level === "error").map((i) => i.key).sort()).toEqual(["ALLOW_MOCK_PAYMENTS_IN_PRODUCTION", "CRON_SECRET", "ENABLE_TEST_PAYMENT", "PAYMENT_PROVIDER"]);
    expect(issues.filter((i) => i.level === "warning").map((i) => i.key)).toEqual(["PAYJP_KEYS", "PAYJP_KEYS"]);
    expect(JSON.stringify(issues)).not.toContain("THIS_IS_SECRET_VALUE");
    expect(JSON.stringify(issues)).not.toContain("PUBLICVALUE");
    expect(productionConfigIssues({ ...env, VERCEL_ENV: "preview" })).toEqual([]);
    expect(productionConfigIssues({ ...PROD, CRON_SECRET: "x".repeat(32), PAYJP_SECRET_KEY: "sk_live_a", PAYJP_PUBLIC_KEY: "pk_live_b" })).toEqual([]);
  });

  it("本番では PAYMENT_PROVIDER=mock・ALLOW_MOCK_PAYMENTS_IN_PRODUCTION=true でも疑似決済を使わず、決済の受付を止める（本番の決済へ自動で切り替えない）", async () => {
    vi.stubEnv("SESSION_SECRET", "unit-test-session-secret-Qx7v2Lr9Tm4Kp8Zw");
    vi.stubEnv("VERCEL_ENV", "production");
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("PAYMENT_PROVIDER", "mock");
    vi.stubEnv("ALLOW_MOCK_PAYMENTS_IN_PRODUCTION", "true");
    vi.stubEnv("ENABLE_TEST_PAYMENT", "true");
    vi.stubEnv("PAYJP_PUBLIC_KEY", "pk_live_x");
    vi.stubEnv("PAYJP_SECRET_KEY", "sk_live_x");
    vi.stubEnv("PAYJP_WEBHOOK_TOKEN", "whook_x");
    vi.resetModules();
    const { env } = await import("@/lib/env");
    expect(env().PAYMENT_PROVIDER).toBeNull();
    expect(env().TEST_PAYMENT_ENABLED).toBe(false);

    // 自動テスト環境（Vercel の本番ではない）では従来どおり疑似決済を使える
    vi.stubEnv("VERCEL_ENV", "");
    vi.resetModules();
    const again = await import("@/lib/env");
    expect(again.env().PAYMENT_PROVIDER).toBe("mock");
  });

  it("本番で危険な設定が残っているときは、運営・店舗アカウントのログイン中でも無料テストを提供せず停止する", async () => {
    // ログイン中の運営アカウントがいる状態にしても結果が変わらないこと
    const user: object | null = { id: "u1", role: "OPERATOR" };
    const load = async (env: Record<string, string>) => {
      for (const k of ["ENABLE_TEST_PAYMENT", "VERCEL_ENV", "PAYMENT_PROVIDER"]) vi.stubEnv(k, env[k] ?? "");
      vi.stubEnv("SESSION_SECRET", "unit-test-session-secret-Qx7v2Lr9Tm4Kp8Zw");
      vi.resetModules();
      vi.doMock("@/lib/auth/session", () => ({ getSessionUser: async () => user }));
      return import("@/lib/services/test-store");
    };
    let m = await load({ ENABLE_TEST_PAYMENT: "true", VERCEL_ENV: "production" });
    expect(await m.testModeState()).toBe("halted");
    expect(await m.isTestModeActive()).toBe(false);
    m = await load({ VERCEL_ENV: "production", PAYMENT_PROVIDER: "mock" });
    expect(await m.testModeState()).toBe("halted");
    // ローカル・Preview では従来どおり無料テストを使える
    m = await load({ ENABLE_TEST_PAYMENT: "true", VERCEL_ENV: "preview" });
    expect(await m.testModeState()).toBe("on");
    m = await load({ ENABLE_TEST_PAYMENT: "true" });
    expect(await m.testModeState()).toBe("on");
    // 正しい本番設定では停止しない
    m = await load({ VERCEL_ENV: "production", PAYMENT_PROVIDER: "payjp" });
    expect(await m.testModeState()).toBe("off");
  });

  it("本番で PAYMENT_PROVIDER=mock のときも占いの受付（決済）を止める。正しい本番設定では止めない", () => {
    expect(isPaidFlowBlocked({ ...PROD, PAYMENT_PROVIDER: "mock" })).toBe(true);
    expect(isPaidFlowBlocked({ PAYMENT_PROVIDER: "mock" })).toBe(false);
    expect(isPaidFlowBlocked({ ...PROD, PAYMENT_PROVIDER: "payjp" })).toBe(false);
  });
});

describe("定期処理（/api/cron/maintenance）", () => {
  const SECRET = "cron-secret-value-for-test-1234567890";
  let run: ReturnType<typeof vi.fn>;
  let record: ReturnType<typeof vi.fn>;
  const load = async () => {
    vi.resetModules();
    run = vi.fn(async () => ({ expiredSessions: 1, expiredCheckouts: 0, purgedResults: 2, purgedCheckouts: 0 }));
    record = vi.fn(async () => {});
    vi.doMock("@/lib/services/maintenance", () => ({ runMaintenance: run }));
    vi.doMock("@/lib/services/maintenance-status", async (orig) => ({ ...(await orig<object>()), recordMaintenanceRun: record }));
    return (await import("@/app/api/cron/maintenance/route")).GET;
  };
  let logs: string[];
  beforeEach(() => {
    vi.stubEnv("SESSION_SECRET", "unit-test-session-secret-Qx7v2Lr9Tm4Kp8Zw");
    logs = [];
    for (const k of ["log", "warn", "error"] as const) vi.spyOn(console, k).mockImplementation((...a: unknown[]) => void logs.push(JSON.stringify(a)));
  });
  afterEach(() => vi.restoreAllMocks());

  it("CRON_SECRET が未設定なら、どんなヘッダーでも 401 で何も実行しない（認証を弱めない）", async () => {
    vi.stubEnv("CRON_SECRET", "");
    const GET = await load();
    for (const auth of [undefined, "Bearer ", "Bearer undefined", `Bearer ${SECRET}`]) {
      const res = await GET(new Request("http://localhost/api/cron/maintenance", { headers: auth === undefined ? {} : { authorization: auth } }));
      expect(res.status).toBe(401);
    }
    expect(run).not.toHaveBeenCalled();
    expect(record).not.toHaveBeenCalled();
    expect(logs.join(" ")).toContain("CRON_SECRET not configured");
  });

  it("トークンが違えば 401。正しければ実行して成功を記録する。秘密の値はログに出さない", async () => {
    vi.stubEnv("CRON_SECRET", SECRET);
    const GET = await load();
    let res = await GET(new Request("http://localhost/api/cron/maintenance", { headers: { authorization: "Bearer wrong" } }));
    expect(res.status).toBe(401);
    expect(run).not.toHaveBeenCalled();
    res = await GET(new Request("http://localhost/api/cron/maintenance", { headers: { authorization: `Bearer ${SECRET}` } }));
    expect(res.status).toBe(200);
    expect(run).toHaveBeenCalledTimes(1);
    expect(record).toHaveBeenCalledWith({ ok: true, result: expect.objectContaining({ purgedResults: 2 }) }, expect.any(Date));
    expect(logs.join(" ")).not.toContain(SECRET);
  });

  it("定期処理が失敗したら 500 を返し、失敗（エラーの識別子だけ）を記録する", async () => {
    vi.stubEnv("CRON_SECRET", SECRET);
    const GET = await load();
    run.mockRejectedValueOnce(Object.assign(new Error("deadline exceeded"), { code: 4 }));
    const res = await GET(new Request("http://localhost/api/cron/maintenance", { headers: { authorization: `Bearer ${SECRET}` } }));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ ok: false, error: "maintenance_failed" });
    expect(record).toHaveBeenCalledWith({ ok: false, errorCode: "code:4" }, expect.any(Date));
    expect(logs.join(" ")).not.toContain(SECRET);
  });
});
