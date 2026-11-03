import { afterEach, describe, expect, it, vi } from "vitest";
import {
  checkFirestoreTarget,
  isServiceAccountOf,
  PREVIEW_FIREBASE_TARGETS,
  previewFirebaseTargetOf,
  PRODUCTION_FIREBASE_PROJECT_ID,
  SANDBOX_V2_FIREBASE_PROJECT_ID,
  validatePreviewTargets,
  type PreviewFirebaseTarget,
} from "@/lib/firestore/target-guard";
import { stripeTestConfig } from "@/lib/payments/stripe-guard";
import { firebaseTargetDiagnostics } from "@/lib/ops/firebase-target-diagnostics";
import { checkPreviewEnv } from "@/lib/ops/env-check";

/**
 * 新しい検証環境（個人事業主の Stripe の Sandbox ＋ 新しい Firebase のプロジェクト）を許可する仕組みの単体テスト。
 * 仕組みそのものは、テストの中だけの仮の一覧（uranai-sbx-unit）を関数に渡して確かめる（アプリの一覧に無いプロジェクトは、環境変数だけでは許可できないことも確かめる）。
 * 確定した検証環境（uranai-stripe-sandbox-v2）は、アプリの一覧そのもの（既定の引数）で確かめる（最後の describe）。
 * 値はすべて形だけの偽物。Firebase・Stripe には接続しない。
 */
type E = Record<string, string | undefined>;
const LEGACY = "uranai-preview";
const NEW = "uranai-sbx-unit";
const TARGETS: readonly PreviewFirebaseTarget[] = [
  { projectId: LEGACY, requireStripeAccountId: false },
  { projectId: NEW, requireStripeAccountId: true },
];
const LEGACY_ENV: E = {
  VERCEL_ENV: "preview",
  FIREBASE_PROJECT_ID: LEGACY,
  PRODUCTION_FIREBASE_PROJECT_ID: PRODUCTION_FIREBASE_PROJECT_ID,
  FIREBASE_CLIENT_EMAIL: "stripe-test@uranai-preview.iam.gserviceaccount.com",
  STRIPE_TEST_FIREBASE_PROJECT_ID: LEGACY,
  STRIPE_TEST_CHECKOUT: "on",
  STRIPE_SECRET_KEY: "sk_test_unit_old_sandbox",
  STRIPE_WEBHOOK_SECRET: "whsec_unit_old_sandbox",
};
const NEW_ENV: E = {
  ...LEGACY_ENV,
  FIREBASE_PROJECT_ID: NEW,
  FIREBASE_CLIENT_EMAIL: "sandbox-sa@uranai-sbx-unit.iam.gserviceaccount.com",
  STRIPE_TEST_FIREBASE_PROJECT_ID: NEW,
  STRIPE_SECRET_KEY: "sk_test_unit_new_sandbox",
  STRIPE_WEBHOOK_SECRET: "whsec_unit_new_sandbox",
  STRIPE_ACCOUNT_ID: "acct_unitNewSandbox1",
};

describe("Preview 用の Firebase プロジェクトの一覧（コードに固定）", () => {
  it("アプリの一覧は uranai-preview（STRIPE_ACCOUNT_ID は任意のまま）と uranai-stripe-sandbox-v2（STRIPE_ACCOUNT_ID が必須）の2件だけ", () => {
    expect(SANDBOX_V2_FIREBASE_PROJECT_ID).toBe("uranai-stripe-sandbox-v2");
    expect(PREVIEW_FIREBASE_TARGETS).toEqual([
      { projectId: LEGACY, requireStripeAccountId: false },
      { projectId: "uranai-stripe-sandbox-v2", requireStripeAccountId: true },
    ]);
    expect(Object.isFrozen(PREVIEW_FIREBASE_TARGETS)).toBe(true);
    expect(PREVIEW_FIREBASE_TARGETS.some((t) => t.projectId === PRODUCTION_FIREBASE_PROJECT_ID)).toBe(false);
    expect(validatePreviewTargets(PREVIEW_FIREBASE_TARGETS)).toBe(PREVIEW_FIREBASE_TARGETS);
  });

  it("一覧に本番のプロジェクト・形の不正な ID・重複は入れられない（読み込みのときに例外）", () => {
    expect(() => validatePreviewTargets([{ projectId: PRODUCTION_FIREBASE_PROJECT_ID, requireStripeAccountId: true }])).toThrow(/production/);
    for (const bad of ["", "Uranai-Preview", "a", "uranai_preview", "uranai-preview-", "-uranai", "x".repeat(31)]) {
      expect(() => validatePreviewTargets([{ projectId: bad, requireStripeAccountId: true }]), bad).toThrow(/invalid/);
    }
    expect(() => validatePreviewTargets([TARGETS[1], TARGETS[1]])).toThrow(/duplicate/);
    expect(validatePreviewTargets(TARGETS)).toBe(TARGETS);
  });

  it("一覧の照合は完全一致だけ（大文字・空白・本番の ID は一致しない）", () => {
    expect(previewFirebaseTargetOf(NEW, TARGETS)).toEqual(TARGETS[1]);
    for (const v of [` ${NEW}`, NEW.toUpperCase(), `${NEW}x`, PRODUCTION_FIREBASE_PROJECT_ID, undefined, ""]) expect(previewFirebaseTargetOf(v, TARGETS), String(v)).toBeNull();
  });

  it("サービスアカウントは、接続先と同じプロジェクトのものだけ", () => {
    expect(isServiceAccountOf("sandbox-sa@uranai-sbx-unit.iam.gserviceaccount.com", NEW)).toBe(true);
    for (const v of [
      "stripe-test@uranai-preview.iam.gserviceaccount.com", // 別の Preview 用のプロジェクト（上書きの漏れ）
      "sandbox-sa@uranai-sbx-unit.iam.gserviceaccount.com.evil.example",
      "sandbox-sa@uranai-sbx-unit.iam.gserviceaccount.com ",
      "sandbox-sa@uranai-b6edf.iam.gserviceaccount.com",
      "firebase-adminsdk@uranai-sbx-unit.example.com",
      undefined,
    ]) {
      expect(isServiceAccountOf(v, NEW), String(v)).toBe(false);
    }
  });
});

describe("Firestore の接続先の判定（新しい検証環境）", () => {
  it("以前からの Preview は今までどおり許可", () => {
    expect(checkFirestoreTarget(LEGACY_ENV)).toEqual({ ok: true });
    expect(checkFirestoreTarget(LEGACY_ENV, TARGETS)).toEqual({ ok: true });
  });

  it("一覧にある新しいプロジェクトと、そのサービスアカウントなら許可", () => {
    expect(checkFirestoreTarget(NEW_ENV, TARGETS)).toEqual({ ok: true });
  });

  it("環境変数だけでは新しいプロジェクトを許可できない（アプリの一覧に無ければ拒否）", () => {
    expect(checkFirestoreTarget(NEW_ENV)).toEqual({ ok: false, reason: "preview_project_not_allowed" });
  });

  it("プロジェクト・サービスアカウントの食い違い（ブランチごとの上書きの漏れ）は拒否", () => {
    expect(checkFirestoreTarget({ ...NEW_ENV, FIREBASE_CLIENT_EMAIL: LEGACY_ENV.FIREBASE_CLIENT_EMAIL }, TARGETS)).toEqual({ ok: false, reason: "preview_service_account_mismatch" });
    expect(checkFirestoreTarget({ ...LEGACY_ENV, FIREBASE_CLIENT_EMAIL: NEW_ENV.FIREBASE_CLIENT_EMAIL }, TARGETS)).toEqual({ ok: false, reason: "preview_service_account_mismatch" });
    expect(checkFirestoreTarget({ ...NEW_ENV, FIREBASE_PROJECT_ID: "uranai-sbx-other" }, TARGETS)).toEqual({ ok: false, reason: "preview_project_not_allowed" });
    expect(checkFirestoreTarget({ ...NEW_ENV, PRODUCTION_FIREBASE_PROJECT_ID: "uranai-other" }, TARGETS)).toEqual({ ok: false, reason: "preview_production_project_id_unexpected" });
    expect(checkFirestoreTarget({ ...NEW_ENV, PRODUCTION_FIREBASE_PROJECT_ID: undefined }, TARGETS)).toEqual({ ok: false, reason: "production_project_id_not_set" });
  });

  it("本番の Firebase プロジェクトは、Preview から必ず拒否（Emulator の設定があっても）", () => {
    for (const env of [
      { ...NEW_ENV, FIREBASE_PROJECT_ID: PRODUCTION_FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL: "sa-prod-01@uranai-b6edf.iam.gserviceaccount.com" },
      { ...NEW_ENV, FIREBASE_PROJECT_ID: PRODUCTION_FIREBASE_PROJECT_ID, FIRESTORE_EMULATOR_HOST: "127.0.0.1:8080" },
      { ...NEW_ENV, FIREBASE_PROJECT_ID: NEW, PRODUCTION_FIREBASE_PROJECT_ID: NEW },
    ]) {
      expect(checkFirestoreTarget(env, TARGETS).ok, JSON.stringify(env)).toBe(false);
    }
  });
});

describe("Stripe のテスト決済の判定（新しい検証環境は STRIPE_ACCOUNT_ID が必須）", () => {
  it("新しい検証環境：設定がそろえばアカウントの ID つきで使える", () => {
    expect(stripeTestConfig(NEW_ENV, TARGETS)).toMatchObject({ ok: true, mode: "preview", accountId: "acct_unitNewSandbox1" });
  });

  it("新しい検証環境：STRIPE_ACCOUNT_ID が無い・形が不正なら使えない（fail-closed）", () => {
    for (const v of [undefined, "", "acct_", "acct_short", "cus_unitNewSandbox1", " acct_unitNewSandbox1x!"]) {
      expect(stripeTestConfig({ ...NEW_ENV, STRIPE_ACCOUNT_ID: v }, TARGETS), String(v)).toEqual({ ok: false, reason: "test_account_id_missing" });
    }
  });

  it("新しい検証環境：プロジェクトの食い違い・本番の設定・本番用キーの混入は使えない", () => {
    const cases: [E, string][] = [
      [{ ...NEW_ENV, STRIPE_TEST_FIREBASE_PROJECT_ID: LEGACY }, "test_project_mismatch"],
      [{ ...NEW_ENV, STRIPE_TEST_FIREBASE_PROJECT_ID: undefined }, "test_project_not_set"],
      [{ ...NEW_ENV, FIREBASE_CLIENT_EMAIL: LEGACY_ENV.FIREBASE_CLIENT_EMAIL }, "firestore_target_blocked"],
      [{ ...NEW_ENV, STRIPE_SECRET_KEY: "sk_live_unit_fake" }, "secret_key_not_test"],
      [{ ...NEW_ENV, STRIPE_LIVE_CHECKOUT: "on" }, "live_flag_in_test"],
      [{ ...NEW_ENV, STRIPE_WEBHOOK_SECRET: undefined }, "webhook_secret_missing"],
      [{ ...NEW_ENV, STRIPE_API_BASE: "http://127.0.0.1:12111" }, "api_base_not_allowed"],
      [{ ...NEW_ENV, VERCEL_ENV: "production" }, "production"],
    ];
    for (const [env, reason] of cases) expect(stripeTestConfig(env, TARGETS), reason).toEqual({ ok: false, reason });
    // アプリの一覧に無い（ID の確定前）：新しいプロジェクトではテスト決済を受け付けない
    expect(stripeTestConfig(NEW_ENV)).toEqual({ ok: false, reason: "preview_project_mismatch" });
  });

  it("以前からの Preview は今までどおり（STRIPE_ACCOUNT_ID は任意。設定されていれば形を確かめて使う）", () => {
    expect(stripeTestConfig(LEGACY_ENV)).toEqual({ ok: true, mode: "preview", secretKey: "sk_test_unit_old_sandbox", webhookSecret: "whsec_unit_old_sandbox", apiBase: null });
    expect(stripeTestConfig({ ...LEGACY_ENV, STRIPE_ACCOUNT_ID: "acct_unitOldSandbox1" })).toMatchObject({ ok: true, accountId: "acct_unitOldSandbox1" });
    expect(stripeTestConfig({ ...LEGACY_ENV, STRIPE_ACCOUNT_ID: "bad" })).toEqual({ ok: false, reason: "test_account_id_missing" });
  });
});

describe("決済の処理の接続（環境変数から）：テストの接続もアカウントを確かめる", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });
  const stub = (e: E) => {
    for (const k of ["VERCEL_ENV", "FIREBASE_PROJECT_ID", "PRODUCTION_FIREBASE_PROJECT_ID", "FIREBASE_CLIENT_EMAIL", "STRIPE_TEST_FIREBASE_PROJECT_ID", "STRIPE_TEST_CHECKOUT", "STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET", "STRIPE_ACCOUNT_ID", "STRIPE_API_BASE", "STRIPE_LIVE_CHECKOUT", "STRIPE_LIVE_OPERATOR_TEST", "FIRESTORE_EMULATOR_HOST"]) vi.stubEnv(k, "");
    for (const [k, v] of Object.entries(e)) if (v !== undefined) vi.stubEnv(k, v);
  };

  it("以前からの Preview：アカウントの指定が無ければ確かめない（今までどおり）。指定があれば確かめる", async () => {
    stub(LEGACY_ENV);
    const { stripeRuntime } = await import("@/lib/payments/stripe-checkout");
    expect(stripeRuntime().accountId).toBeUndefined();
    stub({ ...LEGACY_ENV, STRIPE_ACCOUNT_ID: "acct_unitOldSandbox1" });
    expect(stripeRuntime().accountId).toBe("acct_unitOldSandbox1");
  });

  it("新しい検証環境の設定でも、アプリの一覧に無ければ接続を作らない（ID の確定前は使えない）", async () => {
    stub(NEW_ENV);
    const { stripeRuntime } = await import("@/lib/payments/stripe-checkout");
    expect(() => stripeRuntime()).toThrow(/Stripe checkout is not available/);
  });

  it("旧 Sandbox のキーの混入：キーのアカウントが STRIPE_ACCOUNT_ID と違えば拒否（テストの接続でも）", async () => {
    const { ensureStripeAccount, StripeAccountMismatchError } = await import("@/lib/payments/stripe-checkout");
    const oldKeyClient = { accounts: { retrieveCurrent: vi.fn(async () => ({ id: "acct_unitOldSandbox1" })) } } as unknown as import("stripe").default;
    await expect(ensureStripeAccount({ client: oldKeyClient, accountId: "acct_unitNewSandbox1" })).rejects.toBeInstanceOf(StripeAccountMismatchError);
    const newKeyClient = { accounts: { retrieveCurrent: vi.fn(async () => ({ id: "acct_unitNewSandbox1" })) } } as unknown as import("stripe").default;
    await expect(ensureStripeAccount({ client: newKeyClient, accountId: "acct_unitNewSandbox1" })).resolves.toBeUndefined();
  });
});

describe("診断・環境の確認（値は返さない）", () => {
  it("診断：新しい検証環境の正しい設定はすべて true。アカウントの ID が無ければ stripeAccountIdReady=false", () => {
    expect(firebaseTargetDiagnostics(NEW_ENV, TARGETS)).toEqual({ projectIdIsPreview: true, productionProjectIdIsExpected: true, clientEmailBelongsToPreview: true, projectIdMatchesStripeTestProject: true, stripeAccountIdReady: true });
    expect(firebaseTargetDiagnostics({ ...NEW_ENV, STRIPE_ACCOUNT_ID: undefined }, TARGETS).stripeAccountIdReady).toBe(false);
    expect(firebaseTargetDiagnostics({ ...NEW_ENV, FIREBASE_CLIENT_EMAIL: LEGACY_ENV.FIREBASE_CLIENT_EMAIL }, TARGETS).clientEmailBelongsToPreview).toBe(false);
    expect(firebaseTargetDiagnostics(NEW_ENV).projectIdIsPreview).toBe(false); // アプリの一覧に無い
    expect(firebaseTargetDiagnostics(LEGACY_ENV).stripeAccountIdReady).toBe(true); // 以前からの Preview は任意
  });

  it("環境の確認（check:env --preview）：問題を変数名と説明だけで返す（値を含まない）", () => {
    const ok = checkPreviewEnv({ ...NEW_ENV, SESSION_SECRET: "unit-Xq7#mP2$vL9@wR4!nT6&kB8*hJ3%", CRON_SECRET: "c".repeat(32) }, TARGETS);
    expect(ok.filter((r) => r.level === "error").map((r) => r.key)).toEqual(["FIREBASE_PRIVATE_KEY"]); // 鍵は未登録（テストでは入れない）
    const bad = checkPreviewEnv({ ...NEW_ENV, STRIPE_ACCOUNT_ID: undefined, FIREBASE_CLIENT_EMAIL: LEGACY_ENV.FIREBASE_CLIENT_EMAIL }, TARGETS);
    expect(bad.find((r) => r.key === "FIRESTORE_TARGET")?.level).toBe("error");
    expect(bad.find((r) => r.key === "STRIPE_TEST_CHECKOUT")?.level).toBe("error");
    expect(checkPreviewEnv({ ...NEW_ENV, FIREBASE_PROJECT_ID: PRODUCTION_FIREBASE_PROJECT_ID }, TARGETS).find((r) => r.key === "FIREBASE_PROJECT_ID")?.level).toBe("error");
    expect(checkPreviewEnv(NEW_ENV).find((r) => r.key === "FIREBASE_PROJECT_ID")?.level).toBe("error"); // アプリの一覧に無い
    expect(JSON.stringify([ok, bad])).not.toMatch(/sk_test_unit|whsec_unit|acct_unit|sandbox-sa@/);
  });
});

describe("確定した検証環境 uranai-stripe-sandbox-v2（アプリの一覧そのもので判定）", () => {
  const V2 = "uranai-stripe-sandbox-v2";
  const V2_ENV: E = {
    ...NEW_ENV,
    FIREBASE_PROJECT_ID: V2,
    FIREBASE_CLIENT_EMAIL: "sandbox-v2-sa@uranai-stripe-sandbox-v2.iam.gserviceaccount.com",
    STRIPE_TEST_FIREBASE_PROJECT_ID: V2,
  };
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("Firestore：そのプロジェクトとサービスアカウントなら許可。食い違い・本番は拒否", () => {
    expect(checkFirestoreTarget(V2_ENV)).toEqual({ ok: true });
    expect(checkFirestoreTarget({ ...V2_ENV, FIREBASE_CLIENT_EMAIL: LEGACY_ENV.FIREBASE_CLIENT_EMAIL })).toEqual({ ok: false, reason: "preview_service_account_mismatch" });
    expect(checkFirestoreTarget({ ...LEGACY_ENV, FIREBASE_CLIENT_EMAIL: V2_ENV.FIREBASE_CLIENT_EMAIL })).toEqual({ ok: false, reason: "preview_service_account_mismatch" });
    expect(checkFirestoreTarget({ ...V2_ENV, FIREBASE_PROJECT_ID: "uranai-stripe-sandbox-v3" })).toEqual({ ok: false, reason: "preview_project_not_allowed" });
    expect(checkFirestoreTarget({ ...V2_ENV, FIREBASE_PROJECT_ID: "Uranai-Stripe-Sandbox-V2" }).ok).toBe(false);
    expect(checkFirestoreTarget({ ...V2_ENV, FIREBASE_PROJECT_ID: PRODUCTION_FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL: "sa-prod-01@uranai-b6edf.iam.gserviceaccount.com" })).toEqual({ ok: false, reason: "preview_uses_production_project" });
    expect(checkFirestoreTarget({ ...V2_ENV, PRODUCTION_FIREBASE_PROJECT_ID: V2 })).toEqual({ ok: false, reason: "preview_uses_production_project" });
  });

  it("Stripe のテスト決済：STRIPE_ACCOUNT_ID が必須（無い・不正なら使えない）。旧 Preview のプロジェクトとの取り違えも使えない", () => {
    expect(stripeTestConfig(V2_ENV)).toMatchObject({ ok: true, mode: "preview", accountId: "acct_unitNewSandbox1" });
    expect(stripeTestConfig({ ...V2_ENV, STRIPE_ACCOUNT_ID: undefined })).toEqual({ ok: false, reason: "test_account_id_missing" });
    expect(stripeTestConfig({ ...V2_ENV, STRIPE_ACCOUNT_ID: "acct_x" })).toEqual({ ok: false, reason: "test_account_id_missing" });
    expect(stripeTestConfig({ ...V2_ENV, STRIPE_TEST_FIREBASE_PROJECT_ID: LEGACY })).toEqual({ ok: false, reason: "test_project_mismatch" });
    expect(stripeTestConfig({ ...V2_ENV, STRIPE_SECRET_KEY: "sk_live_unit_fake" })).toEqual({ ok: false, reason: "secret_key_not_test" });
  });

  it("決済の処理の接続（環境変数から）：テストの接続でアカウントの ID を持つ。無ければ接続を作らない（fail-closed）", async () => {
    const keys = ["VERCEL_ENV", "FIREBASE_PROJECT_ID", "PRODUCTION_FIREBASE_PROJECT_ID", "FIREBASE_CLIENT_EMAIL", "STRIPE_TEST_FIREBASE_PROJECT_ID", "STRIPE_TEST_CHECKOUT", "STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET", "STRIPE_ACCOUNT_ID", "STRIPE_API_BASE", "STRIPE_LIVE_CHECKOUT", "STRIPE_LIVE_OPERATOR_TEST", "FIRESTORE_EMULATOR_HOST"];
    const stub = (e: E) => {
      for (const k of keys) vi.stubEnv(k, "");
      for (const [k, v] of Object.entries(e)) if (v !== undefined) vi.stubEnv(k, v);
    };
    stub(V2_ENV);
    const { stripeRuntime } = await import("@/lib/payments/stripe-checkout");
    const rt = stripeRuntime();
    expect([rt.mode, rt.accountId, rt.allowHttpOrigin]).toEqual(["test", "acct_unitNewSandbox1", false]);
    stub({ ...V2_ENV, STRIPE_ACCOUNT_ID: undefined });
    expect(() => stripeRuntime()).toThrow(/Stripe checkout is not available/);
    stub({ ...V2_ENV, FIREBASE_CLIENT_EMAIL: LEGACY_ENV.FIREBASE_CLIENT_EMAIL }); // ブランチの上書き漏れ（旧 Preview のサービスアカウント）
    expect(() => stripeRuntime()).toThrow(/Stripe checkout is not available/);
    // 旧 Preview は今までどおり（アカウントの指定なし）
    stub(LEGACY_ENV);
    expect(stripeRuntime().accountId).toBeUndefined();
  });

  it("診断・環境の確認：正しい設定ならすべて問題なし（値は返さない）", () => {
    expect(firebaseTargetDiagnostics(V2_ENV)).toEqual({ projectIdIsPreview: true, productionProjectIdIsExpected: true, clientEmailBelongsToPreview: true, projectIdMatchesStripeTestProject: true, stripeAccountIdReady: true });
    expect(firebaseTargetDiagnostics({ ...V2_ENV, STRIPE_ACCOUNT_ID: undefined }).stripeAccountIdReady).toBe(false);
    const r = checkPreviewEnv({ ...V2_ENV, SESSION_SECRET: "unit-Xq7#mP2$vL9@wR4!nT6&kB8*hJ3%", CRON_SECRET: "c".repeat(32) });
    expect(r.filter((x) => x.level === "error").map((x) => x.key)).toEqual(["FIREBASE_PRIVATE_KEY"]); // 鍵はテストでは入れない
    expect(r.find((x) => x.key === "FIREBASE_PROJECT_ID")?.message).toMatch(/STRIPE_ACCOUNT_ID が必須/);
  });
});
