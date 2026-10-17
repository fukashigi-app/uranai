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
  it("Preview：本番のプロジェクトIDと一致したら停止。別のプロジェクトなら許可（大文字小文字・前後の空白も同一視）", () => {
    expect(checkFirestoreTarget({ VERCEL_ENV: "preview", FIREBASE_PROJECT_ID: PROD_ID, PRODUCTION_FIREBASE_PROJECT_ID: PROD_ID })).toEqual({ ok: false, reason: "preview_uses_production_project" });
    expect(checkFirestoreTarget({ VERCEL_ENV: "preview", FIREBASE_PROJECT_ID: " URANAI-PROD ", PRODUCTION_FIREBASE_PROJECT_ID: PROD_ID }).ok).toBe(false);
    expect(checkFirestoreTarget({ VERCEL_ENV: "preview", FIREBASE_PROJECT_ID: PREVIEW_ID, PRODUCTION_FIREBASE_PROJECT_ID: PROD_ID })).toEqual({ ok: true });
  });

  it("Preview・Development：設定不足（判定できない）なら停止", () => {
    for (const env of ["preview", "development"]) {
      expect(checkFirestoreTarget({ VERCEL_ENV: env, FIREBASE_PROJECT_ID: PREVIEW_ID })).toEqual({ ok: false, reason: "production_project_id_not_set" });
      expect(checkFirestoreTarget({ VERCEL_ENV: env, FIREBASE_PROJECT_ID: "", PRODUCTION_FIREBASE_PROJECT_ID: PROD_ID })).toEqual({ ok: false, reason: "project_id_not_set" });
      expect(checkFirestoreTarget({ VERCEL_ENV: env, PRODUCTION_FIREBASE_PROJECT_ID: "  " , FIREBASE_PROJECT_ID: PREVIEW_ID }).ok).toBe(false);
    }
  });

  it("Production・Firestore Emulator・ローカル開発には影響しない", () => {
    expect(checkFirestoreTarget({ VERCEL_ENV: "production", FIREBASE_PROJECT_ID: PROD_ID, PRODUCTION_FIREBASE_PROJECT_ID: PROD_ID }).ok).toBe(true);
    expect(checkFirestoreTarget({ VERCEL_ENV: "production", FIREBASE_PROJECT_ID: PROD_ID }).ok).toBe(true);
    expect(checkFirestoreTarget({ FIRESTORE_EMULATOR_HOST: "127.0.0.1:8080", FIREBASE_PROJECT_ID: "demo-uranai" }).ok).toBe(true);
    expect(checkFirestoreTarget({ FIRESTORE_EMULATOR_HOST: "127.0.0.1:8080", VERCEL_ENV: "preview" }).ok).toBe(true);
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
    vi.stubEnv("SESSION_SECRET", "s".repeat(40));
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
