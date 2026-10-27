import { afterEach, describe, expect, it, vi } from "vitest";
import { checkFirestoreTarget } from "@/lib/firestore/target-guard";
import { appUrlFromEnv, isNonProductionVercel, productionConfigIssues, serviceStopReason, siteStatus } from "@/lib/env";

const PROD_ID = "uranai-prod";
const PREVIEW_ID = "uranai-preview";
const PROD_HOST = "uranai.example.jp";
const BRANCH_HOST = "uranai-git-develop-team.vercel.app";
const DEPLOY_HOST = "uranai-abc123-team.vercel.app";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("Firebase の接続先：Preview から本番プロジェクトに接続させない", () => {
  // Preview は uranai-preview と、そのサービスアカウントだけ。本番は uranai-b6edf（コードに固定）
  const REAL_PROD = "uranai-b6edf";
  const PREVIEW_SA = "stripe-test@uranai-preview.iam.gserviceaccount.com";
  const OK_PREVIEW = { VERCEL_ENV: "preview", FIREBASE_PROJECT_ID: PREVIEW_ID, PRODUCTION_FIREBASE_PROJECT_ID: REAL_PROD, FIREBASE_CLIENT_EMAIL: PREVIEW_SA };

  it("Preview：正しい設定（uranai-preview・本番のID・uranai-preview のサービスアカウント）なら接続できる", () => {
    expect(checkFirestoreTarget(OK_PREVIEW)).toEqual({ ok: true });
  });

  it("Preview：接続先が本番のプロジェクトなら、PRODUCTION_FIREBASE_PROJECT_ID の値に関係なく必ず拒否", () => {
    for (const production of [REAL_PROD, "uranai-b6edff", "uranai-preview", "uranai-prod", " URANAI-B6EDF "]) {
      expect(checkFirestoreTarget({ ...OK_PREVIEW, FIREBASE_PROJECT_ID: REAL_PROD, PRODUCTION_FIREBASE_PROJECT_ID: production }).ok).toBe(false);
    }
    expect(checkFirestoreTarget({ ...OK_PREVIEW, FIREBASE_PROJECT_ID: REAL_PROD, PRODUCTION_FIREBASE_PROJECT_ID: "uranai-b6edff" })).toEqual({ ok: false, reason: "preview_uses_production_project" });
    expect(checkFirestoreTarget({ ...OK_PREVIEW, FIREBASE_PROJECT_ID: " URANAI-B6EDF " }).ok).toBe(false); // 大文字小文字・前後の空白も同一視
  });

  it("Preview：PRODUCTION_FIREBASE_PROJECT_ID が本番のIDと完全に一致しなければ拒否（誤記・入れ違い）", () => {
    for (const production of ["uranai-b6edff", "uranai-prod", "uranai-staging", " uranai-b6edf", "URANAI-B6EDF"]) {
      expect(checkFirestoreTarget({ ...OK_PREVIEW, PRODUCTION_FIREBASE_PROJECT_ID: production })).toEqual({ ok: false, reason: "preview_production_project_id_unexpected" });
    }
    // 入れ違い（本番のIDの欄に Preview のID）は、接続先と同じなので最初に止まる
    expect(checkFirestoreTarget({ ...OK_PREVIEW, PRODUCTION_FIREBASE_PROJECT_ID: PREVIEW_ID }).ok).toBe(false);
  });

  it("Preview：別の Firebase プロジェクトは拒否（uranai-preview と完全に一致するものだけ）", () => {
    for (const target of ["uranai-staging", "uranai-preview2", "Uranai-Preview", " uranai-preview", "uranai-preview ", "demo-uranai"]) {
      expect(checkFirestoreTarget({ ...OK_PREVIEW, FIREBASE_PROJECT_ID: target })).toEqual({ ok: false, reason: "preview_project_not_allowed" });
    }
  });

  it("Preview：FIREBASE_CLIENT_EMAIL が uranai-preview のサービスアカウントでなければ拒否（本番用・別のプロジェクト・未設定）", () => {
    for (const email of [
      "firebase-adminsdk-abc12@uranai-b6edf.iam.gserviceaccount.com",
      "stripe-test@uranai-staging.iam.gserviceaccount.com",
      "stripe-test@uranai-preview.iam.gserviceaccount.com.evil.example",
      "stripe-test@uranai-preview.iam.gserviceaccount.com ",
      "someone@example.com",
      "",
      undefined,
    ]) {
      expect(checkFirestoreTarget({ ...OK_PREVIEW, FIREBASE_CLIENT_EMAIL: email })).toEqual({ ok: false, reason: "preview_service_account_mismatch" });
    }
  });

  it("Preview：必須の変数が未設定なら拒否", () => {
    expect(checkFirestoreTarget({ ...OK_PREVIEW, PRODUCTION_FIREBASE_PROJECT_ID: undefined })).toEqual({ ok: false, reason: "production_project_id_not_set" });
    expect(checkFirestoreTarget({ ...OK_PREVIEW, PRODUCTION_FIREBASE_PROJECT_ID: "  " })).toEqual({ ok: false, reason: "production_project_id_not_set" });
    expect(checkFirestoreTarget({ ...OK_PREVIEW, FIREBASE_PROJECT_ID: undefined })).toEqual({ ok: false, reason: "project_id_not_set" });
    expect(checkFirestoreTarget({ ...OK_PREVIEW, FIREBASE_PROJECT_ID: "" })).toEqual({ ok: false, reason: "project_id_not_set" });
    expect(checkFirestoreTarget({ VERCEL_ENV: "preview" }).ok).toBe(false);
  });

  it("Preview：Firestore Emulator の設定があっても判定を省略しない", () => {
    expect(checkFirestoreTarget({ FIRESTORE_EMULATOR_HOST: "127.0.0.1:8080", VERCEL_ENV: "preview" }).ok).toBe(false);
    expect(checkFirestoreTarget({ ...OK_PREVIEW, FIRESTORE_EMULATOR_HOST: "127.0.0.1:8080", FIREBASE_PROJECT_ID: REAL_PROD }).ok).toBe(false);
  });

  it("Development：以前どおり（本番のIDの指定が必須。接続先と一致したら停止）", () => {
    expect(checkFirestoreTarget({ VERCEL_ENV: "development", FIREBASE_PROJECT_ID: PROD_ID, PRODUCTION_FIREBASE_PROJECT_ID: PROD_ID })).toEqual({ ok: false, reason: "preview_uses_production_project" });
    expect(checkFirestoreTarget({ VERCEL_ENV: "development", FIREBASE_PROJECT_ID: " URANAI-PROD ", PRODUCTION_FIREBASE_PROJECT_ID: PROD_ID }).ok).toBe(false);
    expect(checkFirestoreTarget({ VERCEL_ENV: "development", FIREBASE_PROJECT_ID: PREVIEW_ID, PRODUCTION_FIREBASE_PROJECT_ID: PROD_ID })).toEqual({ ok: true });
    expect(checkFirestoreTarget({ VERCEL_ENV: "development", FIREBASE_PROJECT_ID: PREVIEW_ID })).toEqual({ ok: false, reason: "production_project_id_not_set" });
    expect(checkFirestoreTarget({ VERCEL_ENV: "development", FIREBASE_PROJECT_ID: "", PRODUCTION_FIREBASE_PROJECT_ID: PROD_ID })).toEqual({ ok: false, reason: "project_id_not_set" });
    expect(checkFirestoreTarget({ VERCEL_ENV: "development", PRODUCTION_FIREBASE_PROJECT_ID: "  ", FIREBASE_PROJECT_ID: PREVIEW_ID }).ok).toBe(false);
  });

  it("Production・Firestore Emulator・ローカル開発には影響しない", () => {
    expect(checkFirestoreTarget({ VERCEL_ENV: "production", FIREBASE_PROJECT_ID: PROD_ID, PRODUCTION_FIREBASE_PROJECT_ID: PROD_ID }).ok).toBe(true);
    expect(checkFirestoreTarget({ VERCEL_ENV: "production", FIREBASE_PROJECT_ID: PROD_ID }).ok).toBe(true);
    expect(checkFirestoreTarget({ VERCEL_ENV: "production", FIREBASE_PROJECT_ID: REAL_PROD, PRODUCTION_FIREBASE_PROJECT_ID: REAL_PROD, FIREBASE_CLIENT_EMAIL: "firebase-adminsdk-abc12@uranai-b6edf.iam.gserviceaccount.com" }).ok).toBe(true);
    expect(checkFirestoreTarget({ FIRESTORE_EMULATOR_HOST: "127.0.0.1:8080", FIREBASE_PROJECT_ID: "demo-uranai" }).ok).toBe(true);
    expect(checkFirestoreTarget({ FIREBASE_PROJECT_ID: PREVIEW_ID }).ok).toBe(true); // ローカルで本番IDの指定なし
    // ローカルでも、本番のプロジェクトIDを指定していて一致した場合は止める
    expect(checkFirestoreTarget({ FIREBASE_PROJECT_ID: PROD_ID, PRODUCTION_FIREBASE_PROJECT_ID: PROD_ID }).ok).toBe(false);
  });

  it("停止すべきときは、Firebase に接続する前（秘密鍵を読む前）にデータベースへのアクセスを止める", async () => {
    vi.stubEnv("FIRESTORE_EMULATOR_HOST", "");
    vi.stubEnv("VERCEL_ENV", "preview");
    vi.stubEnv("FIREBASE_PROJECT_ID", PROD_ID);
    vi.stubEnv("PRODUCTION_FIREBASE_PROJECT_ID", PROD_ID);
    vi.stubEnv("FIREBASE_CLIENT_EMAIL", "sa@example.iam.gserviceaccount.com");
    vi.stubEnv("FIREBASE_PRIVATE_KEY", "-----BEGIN PRIVATE KEY-----\nNOT_A_REAL_KEY\n-----END PRIVATE KEY-----");
    const initializeApp = vi.fn();
    vi.doMock("firebase-admin/app", () => ({ cert: vi.fn(), getApps: () => [], initializeApp }));
    const { fsdb } = await import("@/lib/firestore/admin");
    expect(() => fsdb()).toThrowError(expect.objectContaining({ name: "FirestoreTargetBlockedError", code: "firestore_target_blocked" }));
    expect(initializeApp).not.toHaveBeenCalled();
    let message = "";
    try {
      fsdb();
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).not.toContain(PROD_ID); // プロジェクトIDはメッセージに出さない
    expect(message).not.toContain("NOT_A_REAL_KEY");
    vi.doUnmock("firebase-admin/app");
  });
});

describe("Preview の接続の拒否は、Firebase Admin SDK の初期化の前に行う（新しい判定）", () => {
  const cases: [string, Record<string, string>][] = [
    ["本番のIDで、PRODUCTION_FIREBASE_PROJECT_ID が誤記", { FIREBASE_PROJECT_ID: "uranai-b6edf", PRODUCTION_FIREBASE_PROJECT_ID: "uranai-b6edff", FIREBASE_CLIENT_EMAIL: "firebase-adminsdk-abc12@uranai-b6edf.iam.gserviceaccount.com" }],
    ["本番のIDで、PRODUCTION_FIREBASE_PROJECT_ID が Preview のID（入れ違い）", { FIREBASE_PROJECT_ID: "uranai-b6edf", PRODUCTION_FIREBASE_PROJECT_ID: "uranai-preview", FIREBASE_CLIENT_EMAIL: "stripe-test@uranai-preview.iam.gserviceaccount.com" }],
    ["別のプロジェクト", { FIREBASE_PROJECT_ID: "uranai-staging", PRODUCTION_FIREBASE_PROJECT_ID: "uranai-b6edf", FIREBASE_CLIENT_EMAIL: "stripe-test@uranai-preview.iam.gserviceaccount.com" }],
    ["本番用のサービスアカウント", { FIREBASE_PROJECT_ID: "uranai-preview", PRODUCTION_FIREBASE_PROJECT_ID: "uranai-b6edf", FIREBASE_CLIENT_EMAIL: "firebase-adminsdk-abc12@uranai-b6edf.iam.gserviceaccount.com" }],
  ];
  it.each(cases)("%s：初期化せずに停止し、値をメッセージに出さない", async (_label, vars) => {
    vi.resetModules();
    vi.stubEnv("FIRESTORE_EMULATOR_HOST", "");
    vi.stubEnv("VERCEL_ENV", "preview");
    for (const [k, v] of Object.entries(vars)) vi.stubEnv(k, v);
    vi.stubEnv("FIREBASE_PRIVATE_KEY", "-----BEGIN PRIVATE KEY-----\nNOT_A_REAL_KEY\n-----END PRIVATE KEY-----");
    const initializeApp = vi.fn();
    const cert = vi.fn();
    vi.doMock("firebase-admin/app", () => ({ cert, getApps: () => [], initializeApp }));
    const { fsdb } = await import("@/lib/firestore/admin");
    let err: unknown = null;
    try {
      fsdb();
    } catch (e) {
      err = e;
    }
    expect(err).toEqual(expect.objectContaining({ name: "FirestoreTargetBlockedError", code: "firestore_target_blocked" }));
    expect(initializeApp).not.toHaveBeenCalled();
    expect(cert).not.toHaveBeenCalled(); // 秘密鍵を読む前に止める
    const message = (err as Error).message;
    for (const v of [...Object.values(vars), "NOT_A_REAL_KEY"]) expect(message).not.toContain(v);
    vi.doUnmock("firebase-admin/app");
  });
});

describe("公開URL（QRコード）：Preview で本番URLを使わない", () => {
  const vercel = { VERCEL_PROJECT_PRODUCTION_URL: PROD_HOST, VERCEL_BRANCH_URL: BRANCH_HOST, VERCEL_URL: DEPLOY_HOST };

  it("Preview で APP_URL が未設定なら、ブランチの固定URL → デプロイURL の順。本番ドメインは使わない", () => {
    expect(appUrlFromEnv({ ...vercel, VERCEL_ENV: "preview" })).toBe(`https://${BRANCH_HOST}`);
    expect(appUrlFromEnv({ VERCEL_PROJECT_PRODUCTION_URL: PROD_HOST, VERCEL_URL: DEPLOY_HOST, VERCEL_ENV: "preview" })).toBe(`https://${DEPLOY_HOST}`);
    expect(appUrlFromEnv({ VERCEL_PROJECT_PRODUCTION_URL: PROD_HOST, VERCEL_ENV: "preview" })).not.toContain(PROD_HOST);
  });

  it("Preview で APP_URL が本番ドメインを指していたら使わない（全環境に登録した APP_URL 対策）。Preview 用の APP_URL は使う", () => {
    expect(appUrlFromEnv({ ...vercel, VERCEL_ENV: "preview", APP_URL: `https://${PROD_HOST}` })).toBe(`https://${BRANCH_HOST}`);
    expect(appUrlFromEnv({ ...vercel, VERCEL_ENV: "preview", APP_URL: `https://${PROD_HOST.toUpperCase()}/` })).toBe(`https://${BRANCH_HOST}`);
    expect(appUrlFromEnv({ ...vercel, VERCEL_ENV: "preview", APP_URL: `https://${BRANCH_HOST}/` })).toBe(`https://${BRANCH_HOST}`);
  });

  it("Production・ローカルは従来どおり", () => {
    expect(appUrlFromEnv({ ...vercel, VERCEL_ENV: "production" })).toBe(`https://${PROD_HOST}`);
    expect(appUrlFromEnv({ ...vercel, VERCEL_ENV: "production", APP_URL: "https://uranai.jp/" })).toBe("https://uranai.jp");
    expect(appUrlFromEnv({})).toBe("http://localhost:3000");
    expect(appUrlFromEnv({ APP_URL: "http://localhost:3000" })).toBe("http://localhost:3000");
  });

  it("Preview で発行した QR コードのURLは本番を指さない", async () => {
    vi.stubEnv("SESSION_SECRET", "unit-test-session-secret-Qx7v2Lr9Tm4Kp8Zw");
    vi.stubEnv("VERCEL_ENV", "preview");
    vi.stubEnv("VERCEL_PROJECT_PRODUCTION_URL", PROD_HOST);
    vi.stubEnv("VERCEL_BRANCH_URL", BRANCH_HOST);
    vi.stubEnv("VERCEL_URL", DEPLOY_HOST);
    vi.stubEnv("APP_URL", `https://${PROD_HOST}`); // 誤って全環境に登録されていた場合
    vi.resetModules();
    const { storeUrl } = await import("@/lib/services/qr");
    const url = storeUrl("abcd1234efgh");
    expect(url).toBe(`https://${BRANCH_HOST}/s/abcd1234efgh`);
    expect(url).not.toContain(PROD_HOST);
  });

  it("開発・テスト環境の表示は Vercel の Preview / Development だけ", () => {
    expect(isNonProductionVercel({ VERCEL_ENV: "preview" })).toBe(true);
    expect(isNonProductionVercel({ VERCEL_ENV: "development" })).toBe(true);
    expect(isNonProductionVercel({ VERCEL_ENV: "production" })).toBe(false);
    expect(isNonProductionVercel({})).toBe(false);
  });
});

describe("準備中モード（SITE_STATUS=coming_soon）", () => {
  it("open・未設定は公開、coming_soon は準備中。それ以外の値は安全側（準備中）", () => {
    expect(siteStatus({})).toEqual({ status: "open", unknown: false });
    expect(siteStatus({ SITE_STATUS: "open" })).toEqual({ status: "open", unknown: false });
    expect(siteStatus({ SITE_STATUS: " Coming_Soon " })).toEqual({ status: "coming_soon", unknown: false });
    expect(siteStatus({ SITE_STATUS: "coming-soon" })).toEqual({ status: "coming_soon", unknown: true });
  });

  it("停止の理由：危険な本番設定が最優先。準備中は別の理由として区別する", () => {
    expect(serviceStopReason({ VERCEL_ENV: "production", SITE_STATUS: "coming_soon" })).toBe("coming_soon");
    expect(serviceStopReason({ VERCEL_ENV: "production", SITE_STATUS: "coming_soon", ENABLE_TEST_PAYMENT: "true" })).toBe("dangerous_config");
    expect(serviceStopReason({ VERCEL_ENV: "production", PAYMENT_PROVIDER: "mock" })).toBe("dangerous_config");
    expect(serviceStopReason({ VERCEL_ENV: "production" })).toBeNull();
    expect(serviceStopReason({ VERCEL_ENV: "preview", SITE_STATUS: "coming_soon", ENABLE_TEST_PAYMENT: "true" })).toBe("coming_soon");
    expect(serviceStopReason({ VERCEL_ENV: "preview", ENABLE_TEST_PAYMENT: "true" })).toBeNull();
  });

  it("本番のヘルスチェック用の判定：準備中は危険な設定（error）として扱わない", () => {
    const base = { VERCEL_ENV: "production", CRON_SECRET: "x".repeat(32) };
    expect(productionConfigIssues({ ...base, SITE_STATUS: "coming_soon" })).toEqual([]);
    expect(productionConfigIssues({ ...base, SITE_STATUS: "comingsoon" }).map((i) => [i.level, i.key])).toEqual([["warning", "SITE_STATUS"]]);
    expect(productionConfigIssues({ ...base, SITE_STATUS: "coming_soon", ENABLE_TEST_PAYMENT: "true" }).filter((i) => i.level === "error").map((i) => i.key)).toEqual(["ENABLE_TEST_PAYMENT"]);
  });

  it("準備中のときは無料テストも提供しない（Preview でテストモードが ON でも）。公開に戻せば無料テストに戻る", async () => {
    const load = async (env: Record<string, string>) => {
      for (const k of ["ENABLE_TEST_PAYMENT", "VERCEL_ENV", "PAYMENT_PROVIDER", "SITE_STATUS"]) vi.stubEnv(k, env[k] ?? "");
      vi.stubEnv("SESSION_SECRET", "unit-test-session-secret-Qx7v2Lr9Tm4Kp8Zw");
      vi.resetModules();
      return import("@/lib/services/test-store");
    };
    let m = await load({ VERCEL_ENV: "production", SITE_STATUS: "coming_soon", PAYMENT_PROVIDER: "payjp" });
    expect(await m.testModeState()).toBe("coming_soon");
    expect(await m.isTestModeActive()).toBe(false);
    m = await load({ VERCEL_ENV: "preview", SITE_STATUS: "coming_soon", ENABLE_TEST_PAYMENT: "true" });
    expect(await m.testModeState()).toBe("coming_soon");
    m = await load({ VERCEL_ENV: "preview", SITE_STATUS: "open", ENABLE_TEST_PAYMENT: "true" });
    expect(await m.testModeState()).toBe("on");
    m = await load({ VERCEL_ENV: "production", PAYMENT_PROVIDER: "payjp" });
    expect(await m.testModeState()).toBe("off");
  });
});
