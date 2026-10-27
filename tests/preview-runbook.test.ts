import { readFileSync } from "node:fs";
import path from "node:path";
import Stripe from "stripe";
import { afterEach, describe, expect, it, vi } from "vitest";
import { stripeTestConfig } from "@/lib/payments/stripe-guard";
import { checkFirestoreTarget } from "@/lib/firestore/target-guard";
import { appUrlFromEnv } from "@/lib/env";
import { MONITOR_LIMITS } from "@/lib/payments/payment-monitor";
import { MONITOR_LOCK_TTL_MS } from "@/lib/payments/monitor-rules";

// docs/preview-verification.md（段階7の検証の手順書）に書いた安全の条件を、環境変数の組み合わせだけで確かめる
// （Stripe・Firebase には接続しない。キーはすべて形だけの偽物）
type E = Record<string, string | undefined>;
const PREVIEW: E = {
  VERCEL_ENV: "preview",
  VERCEL_BRANCH_URL: "uranai-git-feature-stripe-checkout-team.vercel.app",
  VERCEL_URL: "uranai-abc123-team.vercel.app",
  VERCEL_PROJECT_PRODUCTION_URL: "uranai.example.jp",
  STRIPE_TEST_CHECKOUT: "on",
  STRIPE_SECRET_KEY: "sk_test_runbook",
  STRIPE_WEBHOOK_SECRET: "whsec_runbook",
  FIREBASE_PROJECT_ID: "uranai-preview",
  STRIPE_TEST_FIREBASE_PROJECT_ID: "uranai-preview",
  PRODUCTION_FIREBASE_PROJECT_ID: "uranai-b6edf",
  FIREBASE_CLIENT_EMAIL: "stripe-test@uranai-preview.iam.gserviceaccount.com",
};

describe("手順書 §1.1・§1.2：Preview の環境変数の取り違えでは、テスト決済・データベースを使わない", () => {
  it("正しい Preview の設定ならテスト決済を使える（Sandbox だけ・接続先の差し替えなし）", () => {
    expect(stripeTestConfig(PREVIEW)).toMatchObject({ ok: true, mode: "preview", apiBase: null });
    expect(checkFirestoreTarget(PREVIEW)).toEqual({ ok: true });
  });

  it.each([
    ["PRODUCTION_FIREBASE_PROJECT_ID が未設定", { PRODUCTION_FIREBASE_PROJECT_ID: undefined }, "firestore_target_blocked"],
    ["本番の Firebase に接続する設定", { FIREBASE_PROJECT_ID: "uranai-b6edf", STRIPE_TEST_FIREBASE_PROJECT_ID: "uranai-b6edf" }, "production_project"],
    ["STRIPE_TEST_FIREBASE_PROJECT_ID が未設定", { STRIPE_TEST_FIREBASE_PROJECT_ID: undefined }, "test_project_not_set"],
    ["テスト用プロジェクトと接続先が違う", { STRIPE_TEST_FIREBASE_PROJECT_ID: "uranai-other" }, "test_project_mismatch"],
    ["uranai-preview 以外のプロジェクト", { FIREBASE_PROJECT_ID: "uranai-staging", STRIPE_TEST_FIREBASE_PROJECT_ID: "uranai-staging" }, "preview_project_mismatch"],
    ["Firestore Emulator の設定", { FIRESTORE_EMULATOR_HOST: "127.0.0.1:8080" }, "unsupported_environment"],
    ["STRIPE_API_BASE（ローカルの自動テスト専用）", { STRIPE_API_BASE: "http://127.0.0.1:12111" }, "api_base_not_allowed"],
    ["本番決済のスイッチ", { STRIPE_LIVE_CHECKOUT: "on" }, "live_flag_in_test"],
    ["運営だけの本番決済のスイッチ", { STRIPE_LIVE_OPERATOR_TEST: "on" }, "live_flag_in_test"],
    ["本番用の秘密鍵", { STRIPE_SECRET_KEY: "sk_live_x" }, "secret_key_not_test"],
    ["制限付きキー（rk_test_ は今のコードでは使えない）", { STRIPE_SECRET_KEY: "rk_test_x" }, "secret_key_not_test"],
    ["本番用の公開鍵がほかの変数にある", { STRIPE_PUBLISHABLE_KEY: "pk_live_x" }, "live_key_present"],
    ["Webhook の署名の値が無い", { STRIPE_WEBHOOK_SECRET: undefined }, "webhook_secret_missing"],
    ["疑似決済の設定が残っている", { PAYMENT_PROVIDER: "mock" }, "dangerous_config"],
    ["テスト決済のスイッチが無い", { STRIPE_TEST_CHECKOUT: undefined }, "not_enabled"],
  ])("%s → 使わない", (_label, patch, reason) => {
    expect(stripeTestConfig({ ...PREVIEW, ...patch })).toEqual({ ok: false, reason });
  });

  it("Preview で PRODUCTION_FIREBASE_PROJECT_ID が未設定・接続先と同じなら、データベースへのアクセス自体を止める", () => {
    expect(checkFirestoreTarget({ ...PREVIEW, PRODUCTION_FIREBASE_PROJECT_ID: undefined })).toEqual({ ok: false, reason: "production_project_id_not_set" });
    expect(checkFirestoreTarget({ ...PREVIEW, FIREBASE_PROJECT_ID: "uranai-b6edf" })).toEqual({ ok: false, reason: "preview_uses_production_project" });
  });

  it("APP_URL を設定しなくても、Preview はブランチの固定 URL を使う。本番のドメインを指す APP_URL は使わない", () => {
    expect(appUrlFromEnv(PREVIEW)).toBe("https://uranai-git-feature-stripe-checkout-team.vercel.app");
    expect(appUrlFromEnv({ ...PREVIEW, APP_URL: "https://uranai.example.jp" })).toBe("https://uranai-git-feature-stripe-checkout-team.vercel.app");
  });
});

// Webhook の受け口：保護の回避の値を URL のクエリに付けても、署名の確認は本文と Stripe-Signature ヘッダーだけで行う（URL は読まない・記録しない）
const calls = vi.hoisted(() => ({ list: [] as unknown[][] }));
vi.mock("@/lib/payments/stripe-checkout", () => ({ stripeRuntime: () => ({ mode: "test", webhookSecret: "whsec_runbook_route", client: new Stripe("sk_test_runbook") }) }));
vi.mock("@/lib/payments/stripe-webhook", () => ({
  handleStripeWebhook: async (...args: unknown[]) => {
    calls.list.push(args);
    return { status: 400, body: "Invalid signature" };
  },
}));

describe("手順書 §1.6：Deployment Protection の回避の値を URL に付けても、署名の確認は変わらない", () => {
  afterEach(() => {
    calls.list = [];
    vi.restoreAllMocks();
  });

  it("受け口は本文と署名のヘッダーだけを渡す（URL・クエリ・ほかのヘッダーは渡さない）", async () => {
    const logs: unknown[][] = [];
    for (const m of ["log", "info", "warn", "error"] as const) vi.spyOn(console, m).mockImplementation((...a: unknown[]) => void logs.push(a));
    const { POST } = await import("@/app/api/webhooks/stripe/route");
    const bypass = "BYPASS_SECRET_VALUE_FOR_UNIT_TEST_0123456789";
    const body = JSON.stringify({ id: "evt_runbook", type: "checkout.session.completed" });
    const res = await POST(
      new Request(`https://uranai-git-feature-stripe-checkout-team.vercel.app/api/webhooks/stripe?x-vercel-protection-bypass=${bypass}`, {
        method: "POST",
        headers: { "stripe-signature": "t=1,v1=bad", "x-vercel-protection-bypass": bypass, "content-type": "application/json" },
        body,
      }),
    );
    expect(res.status).toBe(400);
    expect(calls.list).toHaveLength(1);
    const [rawBody, signature, rt] = calls.list[0] as [string, string, { mode: string }];
    expect(rawBody).toBe(body);
    expect(signature).toBe("t=1,v1=bad");
    expect(rt.mode).toBe("test");
    expect(JSON.stringify(calls.list.map((c) => c.slice(0, 2)))).not.toContain(bypass); // 回避の値は処理に渡さない（3つ目は Stripe との接続）
    expect(calls.list[0]).toHaveLength(3);
    expect(JSON.stringify(logs)).not.toContain(bypass); // ログにも出さない
    expect(await res.text()).not.toContain(bypass); // 応答にも出さない
  });

  it("受け口のコードは URL・クエリを読まない（回避の値を記録・表示する経路が無い）", () => {
    const src = readFileSync(path.join(process.cwd(), "src/app/api/webhooks/stripe/route.ts"), "utf8");
    expect(src).not.toMatch(/req\.url|nextUrl|searchParams|new URL\(/);
    expect(src).toMatch(/req\.text\(\)/); // 署名の確認は生の本文で
  });
});

describe("手順書 §9・§11：点検の時間の上限と、関数の実行時間・ロックの期限が矛盾しない", () => {
  // Vercel で時間がかかる処理のファイル。maxDuration を追加したときは、点検の時間の上限より10秒以上長くすること
  const FILES = ["src/app/api/webhooks/stripe/route.ts", "src/app/payment/return/page.tsx", "src/app/api/checkout/stripe-session/route.ts", "src/app/admin/(console)/payment-monitor/page.tsx"];
  const maxDurationOf = (f: string) => {
    const m = /export const maxDuration\s*=\s*(\d+)/.exec(readFileSync(path.join(process.cwd(), f), "utf8"));
    return m ? Number(m[1]) : null;
  };

  it("点検の時間の上限は、ロックの期限より1分以上短い（期限切れの後に点検が続いて次と重ならない）", () => {
    expect(MONITOR_LIMITS.deadlineMs + 60_000).toBeLessThanOrEqual(MONITOR_LOCK_TTL_MS);
  });

  it.each(FILES)("%s：maxDuration を設定するなら、点検の上限＋10秒以上", (f) => {
    const s = maxDurationOf(f);
    if (s === null) return; // 未設定（Vercel の既定の上限。プランの確認の後に設定する。docs/preview-verification.md §11）
    expect(s * 1000).toBeGreaterThanOrEqual(MONITOR_LIMITS.deadlineMs + 10_000);
  });
});
