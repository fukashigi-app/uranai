import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Stripe from "stripe";

const state = vi.hoisted(() => ({
  user: null as null | { id: string; email: string; name: string; role: "OPERATOR" | "STORE" },
  sameOrigin: true,
  retrieve: (async () => ({ id: "" })) as () => Promise<unknown>,
  runtimeCalls: 0,
}));

vi.mock("@/lib/auth/session", () => ({ getSessionUser: async () => state.user }));
vi.mock("@/lib/security/request", () => ({ isSameOrigin: () => state.sameOrigin }));
vi.mock("@/lib/payments/stripe-checkout", () => ({
  stripeRuntime: () => {
    state.runtimeCalls++;
    return { client: { accounts: { retrieveCurrent: () => state.retrieve() } } };
  },
}));

import {
  classifyStripeError,
  DiagnosticsRateLimiter,
  isSandboxV2Environment,
  runStripeAccountDiagnostics,
} from "@/lib/ops/stripe-account-diagnostics";

const SECRET = ["sk", "test", "51DiagUnitSecretKeyMaterialZx8Lq2Vm7Rt4Np9Kw3"].join("_");
const WHSEC = ["whsec", "DiagUnitWebhookSecretMaterial9Kw3Hy6"].join("_");
const ACCOUNT = "acct_1DiagUnitAcctAb12";
const OTHER_ACCOUNT = "acct_1OldSandboxAcctZz99";
const PRIVATE_KEY = "-----BEGIN PRIVATE KEY-----\nSECRETKEYMATERIAL\n-----END PRIVATE KEY-----\n";

const V2 = {
  VERCEL_ENV: "preview",
  VERCEL_GIT_COMMIT_REF: "preview/stripe-sandbox-v2",
  FIREBASE_PROJECT_ID: "uranai-stripe-sandbox-v2",
  PRODUCTION_FIREBASE_PROJECT_ID: "uranai-b6edf",
  FIREBASE_CLIENT_EMAIL: "firebase-adminsdk-ab12c@uranai-stripe-sandbox-v2.iam.gserviceaccount.com",
  FIREBASE_PRIVATE_KEY: PRIVATE_KEY,
  STRIPE_TEST_FIREBASE_PROJECT_ID: "uranai-stripe-sandbox-v2",
  STRIPE_TEST_CHECKOUT: "on",
  STRIPE_SECRET_KEY: SECRET,
  STRIPE_WEBHOOK_SECRET: WHSEC,
  STRIPE_ACCOUNT_ID: ACCOUNT,
  SITE_STATUS: "development",
  PAYMENT_PROVIDER: "stripe",
};
const OLD_PREVIEW = {
  ...V2,
  VERCEL_GIT_COMMIT_REF: "preview/stripe-verification",
  FIREBASE_PROJECT_ID: "uranai-preview",
  STRIPE_TEST_FIREBASE_PROJECT_ID: "uranai-preview",
  FIREBASE_CLIENT_EMAIL: "firebase-adminsdk-ab12c@uranai-preview.iam.gserviceaccount.com",
};
const PRODUCTION = {
  VERCEL_ENV: "production",
  VERCEL_GIT_COMMIT_REF: "main",
  FIREBASE_PROJECT_ID: "uranai-b6edf",
  PRODUCTION_FIREBASE_PROJECT_ID: "uranai-b6edf",
  FIREBASE_CLIENT_EMAIL: "firebase-adminsdk-ab12c@uranai-b6edf.iam.gserviceaccount.com",
  STRIPE_SECRET_KEY: ["sk", "live", "DiagUnitLiveKey"].join("_"),
  STRIPE_WEBHOOK_SECRET: WHSEC,
  STRIPE_ACCOUNT_ID: ACCOUNT,
};
const SECRETS = [SECRET, WHSEC, ACCOUNT, OTHER_ACCOUNT, PRIVATE_KEY, "SECRETKEYMATERIAL", SECRET.slice(-4), SECRET.slice(-8)];
const ok = (id: string) => async () => ({ id, object: "account" });

describe("実行環境の判定（Sandbox v2 だけ）", () => {
  it("Sandbox v2 の Preview なら true", () => {
    expect(isSandboxV2Environment(V2)).toBe(true);
  });

  it("本番・旧 Preview・ローカル・Development では false", () => {
    expect(isSandboxV2Environment(PRODUCTION)).toBe(false);
    expect(isSandboxV2Environment(OLD_PREVIEW)).toBe(false);
    expect(isSandboxV2Environment({ ...V2, VERCEL_ENV: undefined })).toBe(false);
    expect(isSandboxV2Environment({ ...V2, VERCEL_ENV: "development" })).toBe(false);
    expect(isSandboxV2Environment({ ...V2, VERCEL_ENV: "production" })).toBe(false);
  });

  it("ブランチが preview/stripe-sandbox-v2 そのものでなければ false（別ブランチ・未設定・空・空白）", () => {
    for (const ref of ["preview/stripe-verification", "main", "preview/stripe-sandbox-v2 ", "", undefined]) {
      expect(isSandboxV2Environment({ ...V2, VERCEL_GIT_COMMIT_REF: ref }), String(ref)).toBe(false);
    }
  });

  it("Firebase の接続先が Sandbox v2 でない・本番・サービスアカウントが別のプロジェクトなら false", () => {
    expect(isSandboxV2Environment({ ...V2, FIREBASE_PROJECT_ID: "uranai-b6edf" })).toBe(false);
    expect(isSandboxV2Environment({ ...V2, FIREBASE_PROJECT_ID: "uranai-preview" })).toBe(false);
    expect(isSandboxV2Environment({ ...V2, FIREBASE_CLIENT_EMAIL: OLD_PREVIEW.FIREBASE_CLIENT_EMAIL })).toBe(false);
    expect(isSandboxV2Environment({ ...V2, PRODUCTION_FIREBASE_PROJECT_ID: "" })).toBe(false);
  });
});

describe("診断の本体", () => {
  const now = () => new Date("2026-11-04T01:11:00.000Z");

  it("一致：認証は成功・照合は一致。秘密の値は含まない", async () => {
    const r = await runStripeAccountDiagnostics(ok(ACCOUNT), V2, now);
    expect(r).toEqual({
      environment: "sandbox_v2",
      secretKeySet: true,
      secretKeyIsTest: true,
      accountIdSet: true,
      webhookSecretSet: true,
      accountIdHasSurroundingWhitespace: false,
      apiAuth: "success",
      accountMatch: "match",
      mismatchHint: null,
      error: null,
      checkedAt: "2026-11-04T01:11:00.000Z",
    });
    const json = JSON.stringify(r);
    for (const s of SECRETS) expect(json).not.toContain(s);
  });

  it("不一致：末尾4文字だけを返す（ID の全体・キーは返さない）", async () => {
    const r = await runStripeAccountDiagnostics(ok(OTHER_ACCOUNT), V2, now);
    expect(r.apiAuth).toBe("success");
    expect(r.accountMatch).toBe("mismatch");
    expect(r.mismatchHint).toEqual({ returnedLast4: "Zz99", configuredLast4: "Ab12", differsOnlyByCase: false });
    const json = JSON.stringify(r);
    for (const s of SECRETS) expect(json).not.toContain(s);
  });

  it("不一致：大文字と小文字だけの違いを見分ける", async () => {
    const r = await runStripeAccountDiagnostics(ok(ACCOUNT.toLowerCase()), V2, now);
    expect(r.accountMatch).toBe("mismatch");
    expect(r.mismatchHint?.differsOnlyByCase).toBe(true);
  });

  it("STRIPE_ACCOUNT_ID の前後の空白は、アプリと同じく取り除いて比べ、空白があったことだけを返す", async () => {
    const r = await runStripeAccountDiagnostics(ok(ACCOUNT), { ...V2, STRIPE_ACCOUNT_ID: ` ${ACCOUNT}\n` }, now);
    expect(r.accountMatch).toBe("match");
    expect(r.accountIdHasSurroundingWhitespace).toBe(true);
  });

  it("Stripe API の認証の失敗：分類だけを返す（Stripe のエラーの文言・キーの末尾は返さない）", async () => {
    const err = new Stripe.errors.StripeAuthenticationError({ message: `Invalid API Key provided: sk_test_****${SECRET.slice(-4)}`, type: "invalid_request_error" });
    const retrieve = vi.fn(async () => {
      throw err;
    });
    const r = await runStripeAccountDiagnostics(retrieve, V2, now);
    expect(retrieve).toHaveBeenCalledTimes(1);
    expect(r.apiAuth).toBe("failure");
    expect(r.accountMatch).toBe("not_run");
    expect(r.error).toBe("stripe_authentication");
    const json = JSON.stringify(r);
    for (const s of SECRETS) expect(json).not.toContain(s);
    expect(json).not.toContain("Invalid API Key");
  });

  it("Stripe の例外の分類", () => {
    expect(classifyStripeError(new Stripe.errors.StripePermissionError({ message: "x" }))).toBe("stripe_permission");
    expect(classifyStripeError(new Stripe.errors.StripeConnectionError({ message: "x" }))).toBe("stripe_connection");
    expect(classifyStripeError(new Stripe.errors.StripeRateLimitError({ message: "x" }))).toBe("stripe_rate_limit");
    expect(classifyStripeError(new Stripe.errors.StripeAPIError({ message: "x" }))).toBe("stripe_api");
    expect(classifyStripeError(new Stripe.errors.StripeInvalidRequestError({ message: "x" }))).toBe("stripe_invalid_request");
    expect(classifyStripeError(new Error(SECRET))).toBe("unknown");
    expect(classifyStripeError(null)).toBe("unknown");
  });

  it("応答に ID が無ければ invalid_response", async () => {
    const r = await runStripeAccountDiagnostics(async () => ({ object: "account" }), V2, now);
    expect(r).toMatchObject({ apiAuth: "success", accountMatch: "not_run", error: "invalid_response" });
  });

  it("設定が不足していれば Stripe に問い合わせない（キー・アカウントの ID・Webhook の秘密・テスト用でないキー・本番のスイッチ）", async () => {
    const cases: [Record<string, string | undefined>, string, Partial<Record<string, boolean>>][] = [
      [{ STRIPE_SECRET_KEY: undefined }, "config_secret_key_missing", { secretKeySet: false, secretKeyIsTest: false }],
      [{ STRIPE_SECRET_KEY: ["sk", "live", "DiagUnitLiveKey"].join("_") }, "config_secret_key_not_test", { secretKeySet: true, secretKeyIsTest: false }],
      [{ STRIPE_ACCOUNT_ID: undefined }, "config_test_account_id_missing", { accountIdSet: false }],
      [{ STRIPE_ACCOUNT_ID: "acct_bad!" }, "config_test_account_id_missing", { accountIdSet: true }],
      [{ STRIPE_WEBHOOK_SECRET: undefined }, "config_webhook_secret_missing", { webhookSecretSet: false }],
      [{ STRIPE_TEST_CHECKOUT: undefined }, "config_not_enabled", {}],
      [{ STRIPE_LIVE_CHECKOUT: "on" }, "config_live_flag_in_test", {}],
    ];
    for (const [patch, error, flags] of cases) {
      const retrieve = vi.fn(ok(ACCOUNT));
      const r = await runStripeAccountDiagnostics(retrieve, { ...V2, ...patch }, now);
      expect(retrieve, error).not.toHaveBeenCalled();
      expect(r, error).toMatchObject({ apiAuth: "not_run", accountMatch: "not_run", error, ...flags });
      const json = JSON.stringify(r);
      for (const s of SECRETS) expect(json).not.toContain(s);
    }
  });
});

describe("レート制限（メモリだけ）", () => {
  it("同時に1件・運営ごとに1分3回・全体で1分10回", () => {
    let t = 0;
    const l = new DiagnosticsRateLimiter(3, 10, 60_000, () => t);
    const r1 = l.acquire("u1");
    expect(r1).not.toBeNull();
    expect(l.acquire("u2")).toBeNull(); // 実行中
    r1!();
    for (let i = 0; i < 2; i++) l.acquire("u1")!();
    expect(l.acquire("u1")).toBeNull(); // 運営ごとの上限
    for (let i = 0; i < 7; i++) l.acquire(`v${i}`)!();
    expect(l.acquire("u9")).toBeNull(); // 全体の上限
    t = 60_000;
    expect(l.acquire("u1")).not.toBeNull(); // 時間が過ぎれば戻る
  });
});

describe("POST /api/admin/stripe-account-diagnostics", () => {
  const OPERATOR = { id: "op-1", email: "op@example.com", name: "運営", role: "OPERATOR" as const };
  let logs: string[];

  beforeEach(() => {
    vi.resetModules();
    state.user = OPERATOR;
    state.sameOrigin = true;
    state.retrieve = ok(ACCOUNT);
    state.runtimeCalls = 0;
    logs = [];
    for (const m of ["log", "info", "warn", "error"] as const) {
      vi.spyOn(console, m).mockImplementation((...a: unknown[]) => void logs.push(a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" ")));
    }
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  const stub = (e: Record<string, string | undefined>) => {
    for (const k of new Set([...Object.keys(V2), ...Object.keys(PRODUCTION), "STRIPE_LIVE_CHECKOUT", "STRIPE_LIVE_OPERATOR_TEST", "STRIPE_API_BASE", "FIRESTORE_EMULATOR_HOST"])) vi.stubEnv(k, e[k] as string);
  };
  const call = async () => {
    const { POST } = await import("@/app/api/admin/stripe-account-diagnostics/route");
    return POST(new Request("https://sandbox.example.test/api/admin/stripe-account-diagnostics", { method: "POST" }));
  };
  const noSecrets = async (res: Response) => {
    const body = await res.clone().text();
    for (const s of SECRETS) {
      expect(body).not.toContain(s);
      for (const line of logs) expect(line).not.toContain(s);
    }
    expect(res.headers.get("cache-control")).toContain("no-store");
  };

  it("GET は用意していない（POST だけ）", async () => {
    const mod = await import("@/app/api/admin/stripe-account-diagnostics/route");
    expect("GET" in mod).toBe(false);
    expect(typeof mod.POST).toBe("function");
  });

  it("Sandbox v2・運営：一致を返す", async () => {
    stub(V2);
    const res = await call();
    await noSecrets(res);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ environment: "sandbox_v2", apiAuth: "success", accountMatch: "match", error: null });
    expect(state.runtimeCalls).toBe(1);
  });

  it("Sandbox v2・運営：不一致を返す（末尾4文字だけ）", async () => {
    stub(V2);
    state.retrieve = ok(OTHER_ACCOUNT);
    const res = await call();
    await noSecrets(res);
    expect(await res.json()).toMatchObject({ accountMatch: "mismatch", mismatchHint: { returnedLast4: "Zz99", configuredLast4: "Ab12" } });
  });

  it("Stripe API のエラー：分類だけを返し、文言はレスポンス・ログに出さない", async () => {
    stub(V2);
    state.retrieve = async () => {
      throw new Stripe.errors.StripeAuthenticationError({ message: `Invalid API Key provided: ${SECRET}` });
    };
    const res = await call();
    await noSecrets(res);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ apiAuth: "failure", error: "stripe_authentication" });
    for (const line of logs) expect(line).not.toContain("Invalid API Key");
  });

  it("ログインしていない・店舗アカウントは 404（Stripe に問い合わせない）", async () => {
    stub(V2);
    for (const u of [null, { ...OPERATOR, role: "STORE" as const }]) {
      state.user = u;
      const res = await call();
      expect(res.status).toBe(404);
      await noSecrets(res);
    }
    expect(state.runtimeCalls).toBe(0);
  });

  it("別のサイトからの送信は 403", async () => {
    stub(V2);
    state.sameOrigin = false;
    const res = await call();
    expect(res.status).toBe(403);
    expect(state.runtimeCalls).toBe(0);
  });

  it("本番・旧 Preview・ローカルでは拒否（404。Stripe に問い合わせない）", async () => {
    for (const e of [PRODUCTION, OLD_PREVIEW, { ...V2, VERCEL_ENV: undefined }, { ...V2, VERCEL_GIT_COMMIT_REF: "preview/stripe-verification" }]) {
      stub(e);
      const res = await call();
      await noSecrets(res);
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: "environment_not_allowed", environment: "other" });
    }
    expect(state.runtimeCalls).toBe(0);
  });

  it("レート制限：運営ごとに1分3回まで（4回目は 429）", async () => {
    stub(V2);
    const { POST } = await import("@/app/api/admin/stripe-account-diagnostics/route");
    const req = () => new Request("https://sandbox.example.test/api/admin/stripe-account-diagnostics", { method: "POST" });
    for (let i = 0; i < 3; i++) expect((await POST(req())).status).toBe(200);
    const res = await POST(req());
    expect(res.status).toBe(429);
    expect(state.runtimeCalls).toBe(3);
  });
});
