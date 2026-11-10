/**
 * Firestore の接続の認証（lib/firestore/admin.ts）。
 *  - 既定（FIREBASE_CREDENTIALS 未設定）：従来どおり秘密鍵（cert）で接続する。Vercel の動作は変えない
 *  - FIREBASE_CREDENTIALS=application-default：秘密鍵を使わず、実行環境のサービスアカウント（ADC）で接続する（Cloud Run 用）
 *  - 接続先の確認（assertFirestoreTarget）は、どちらの方式でも初期化の前に行う
 * firebase-admin は模擬（実際の接続・認証はしない）。鍵はテスト用の文字列で、本物ではない。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sdk = vi.hoisted(() => ({
  init: [] as { options: Record<string, unknown>; name?: string }[],
  cert: [] as unknown[],
  adc: 0,
}));

vi.mock("firebase-admin/app", () => ({
  getApps: () => [],
  initializeApp: (options: Record<string, unknown>, name?: string) => {
    sdk.init.push({ options, name });
    return { name, options };
  },
  cert: (sa: unknown) => {
    sdk.cert.push(sa);
    return { kind: "cert" };
  },
  applicationDefault: () => {
    sdk.adc++;
    return { kind: "adc" };
  },
}));
vi.mock("@/lib/auth/session", () => ({ getSessionUser: async () => ({ role: "OPERATOR" }) }));
vi.mock("firebase-admin/firestore", () => ({
  getFirestore: () => ({ settings: () => undefined }),
  Timestamp: class {},
}));

const KEYS = [
  "FIREBASE_CREDENTIALS",
  "FIREBASE_PROJECT_ID",
  "FIREBASE_CLIENT_EMAIL",
  "FIREBASE_PRIVATE_KEY",
  "PRODUCTION_FIREBASE_PROJECT_ID",
  "FIRESTORE_EMULATOR_HOST",
  "VERCEL_ENV",
  "VERCEL_GIT_COMMIT_REF",
  "GCLOUD_PROJECT",
] as const;
const saved: Record<string, string | undefined> = {};
const FAKE_KEY = "-----BEGIN PRIVATE KEY-----\\nTEST-ONLY-NOT-A-REAL-KEY\\n-----END PRIVATE KEY-----\\n";

async function connect(env: Partial<Record<(typeof KEYS)[number], string>>) {
  for (const k of KEYS) delete process.env[k];
  Object.assign(process.env, env);
  const g = globalThis as Record<string, unknown>;
  delete g.__uranaiFsApp;
  delete g.__uranaiFs;
  vi.resetModules();
  const { fsdb } = await import("@/lib/firestore/admin");
  return () => fsdb();
}

beforeEach(() => {
  for (const k of KEYS) saved[k] = process.env[k];
  sdk.init.length = 0;
  sdk.cert.length = 0;
  sdk.adc = 0;
});
afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  const g = globalThis as Record<string, unknown>;
  delete g.__uranaiFsApp;
  delete g.__uranaiFs;
});

describe("既定（秘密鍵）：従来の動作を変えない", () => {
  it("Vercel の本番：秘密鍵（cert）で接続し、ADC は使わない", async () => {
    const run = await connect({ VERCEL_ENV: "production", FIREBASE_PROJECT_ID: "uranai-b6edf", PRODUCTION_FIREBASE_PROJECT_ID: "uranai-b6edf", FIREBASE_CLIENT_EMAIL: "app@uranai-b6edf.iam.gserviceaccount.com", FIREBASE_PRIVATE_KEY: FAKE_KEY });
    run();
    expect(sdk.adc).toBe(0);
    expect(sdk.cert).toHaveLength(1);
    const sa = sdk.cert[0] as Record<string, string>;
    expect(sa.projectId).toBe("uranai-b6edf");
    expect(sa.clientEmail).toBe("app@uranai-b6edf.iam.gserviceaccount.com");
    expect(sa.privateKey.startsWith("-----BEGIN PRIVATE KEY-----\n")).toBe(true); // 表記ゆれの変換も従来どおり
    expect(sdk.init).toEqual([{ options: { credential: { kind: "cert" }, projectId: "uranai-b6edf" }, name: "uranai" }]);
  });

  it("空の FIREBASE_CREDENTIALS は未設定と同じ（秘密鍵）", async () => {
    const run = await connect({ FIREBASE_CREDENTIALS: " ", FIREBASE_PROJECT_ID: "demo-x-project", FIREBASE_CLIENT_EMAIL: "a@demo-x-project.iam.gserviceaccount.com", FIREBASE_PRIVATE_KEY: FAKE_KEY });
    run();
    expect([sdk.cert.length, sdk.adc]).toEqual([1, 0]);
  });

  it("秘密鍵が無ければ、ADC に切り替えず従来どおり停止する（エラー文も従来どおり）", async () => {
    const run = await connect({ VERCEL_ENV: "production", FIREBASE_PROJECT_ID: "uranai-b6edf" });
    expect(run).toThrow("Firebase is not configured: FIREBASE_PROJECT_ID / FIREBASE_CLIENT_EMAIL / FIREBASE_PRIVATE_KEY are required");
    expect([sdk.init.length, sdk.adc]).toEqual([0, 0]);
  });

  it("Emulator：従来どおり認証情報なしで接続する（ADC も秘密鍵も使わない）", async () => {
    const run = await connect({ FIRESTORE_EMULATOR_HOST: "127.0.0.1:8080", FIREBASE_PROJECT_ID: "demo-uranai" });
    run();
    expect(sdk.init).toEqual([{ options: { projectId: "demo-uranai" }, name: "uranai" }]);
    expect([sdk.cert.length, sdk.adc]).toEqual([0, 0]);
  });
});

describe("FIREBASE_CREDENTIALS=application-default（秘密鍵なし）", () => {
  it("本番：ADC で接続し、接続先のプロジェクトを FIREBASE_PROJECT_ID で明示する", async () => {
    const run = await connect({ FIREBASE_CREDENTIALS: "application-default", VERCEL_ENV: "production", FIREBASE_PROJECT_ID: "uranai-b6edf", PRODUCTION_FIREBASE_PROJECT_ID: "uranai-b6edf", GCLOUD_PROJECT: "uranai-run" });
    run();
    expect(sdk.adc).toBe(1);
    expect(sdk.cert).toHaveLength(0);
    expect(sdk.init).toEqual([{ options: { credential: { kind: "adc" }, projectId: "uranai-b6edf" }, name: "uranai" }]);
  });

  it("FIREBASE_PROJECT_ID が無ければ、実行環境のプロジェクト（GCLOUD_PROJECT）を推測で使わずに停止する", async () => {
    const run = await connect({ FIREBASE_CREDENTIALS: "application-default", GCLOUD_PROJECT: "uranai-run" });
    expect(run).toThrow(/FIREBASE_PROJECT_ID is required/);
    expect(sdk.init).toHaveLength(0);
  });

  it("秘密鍵・メールアドレスのどちらかでも登録されていれば、取り違えとして停止する", async () => {
    for (const extra of [{ FIREBASE_PRIVATE_KEY: FAKE_KEY }, { FIREBASE_CLIENT_EMAIL: "a@uranai-b6edf.iam.gserviceaccount.com" }]) {
      const run = await connect({ FIREBASE_CREDENTIALS: "application-default", VERCEL_ENV: "production", FIREBASE_PROJECT_ID: "uranai-b6edf", ...extra });
      expect(run).toThrow(/do not set FIREBASE_CLIENT_EMAIL \/ FIREBASE_PRIVATE_KEY/);
    }
    expect([sdk.init.length, sdk.adc, sdk.cert.length]).toEqual([0, 0, 0]);
  });

  it("想定外の値は、黙って秘密鍵の接続に戻さずに停止する", async () => {
    for (const v of ["adc", "Application-Default", "true", "service-account-key"]) {
      const run = await connect({ FIREBASE_CREDENTIALS: v, FIREBASE_PROJECT_ID: "demo-x-project", FIREBASE_CLIENT_EMAIL: "a@demo-x-project.iam.gserviceaccount.com", FIREBASE_PRIVATE_KEY: FAKE_KEY });
      expect(run).toThrow(/FIREBASE_CREDENTIALS must be empty or application-default/);
    }
    expect(sdk.init).toHaveLength(0);
  });

  it("接続先の確認は ADC でも先に行う：Preview 用のブランチの設定でも、メールアドレスが無いので接続しない", async () => {
    const run = await connect({ FIREBASE_CREDENTIALS: "application-default", VERCEL_ENV: "preview", VERCEL_GIT_COMMIT_REF: "preview/stripe-sandbox-v2", FIREBASE_PROJECT_ID: "uranai-stripe-sandbox-v2", PRODUCTION_FIREBASE_PROJECT_ID: "uranai-b6edf" });
    expect(run).toThrow(expect.objectContaining({ code: "firestore_target_blocked", reason: "preview_service_account_mismatch" }));
    expect(sdk.init).toHaveLength(0);
  });

  it("接続先の確認は ADC でも先に行う：本番以外の環境から本番のプロジェクトには接続しない", async () => {
    const run = await connect({ FIREBASE_CREDENTIALS: "application-default", FIREBASE_PROJECT_ID: "uranai-b6edf", PRODUCTION_FIREBASE_PROJECT_ID: "uranai-b6edf" });
    expect(run).toThrow(expect.objectContaining({ code: "firestore_target_blocked", reason: "preview_uses_production_project" }));
    expect(sdk.init).toHaveLength(0);
  });
});

describe("/api/health（運営の詳細表示）：認証の種類を表示し、値は出さない", () => {
  const health = async (env: Partial<Record<(typeof KEYS)[number], string>>) => {
    await connect({ ...env });
    process.env.DB_PROVIDER = "firestore";
    process.env.SESSION_SECRET ||= "unit-test-session-secret-0123456789abcdef";
    const { GET } = await import("@/app/api/health/route");
    const text = await (await GET()).text();
    expect(text).not.toContain("TEST-ONLY-NOT-A-REAL-KEY");
    return JSON.parse(text) as Record<string, unknown>;
  };
  const savedDb = process.env.DB_PROVIDER;
  afterEach(() => {
    if (savedDb === undefined) delete process.env.DB_PROVIDER;
    else process.env.DB_PROVIDER = savedDb;
  });

  it("既定：従来どおりの表示（set / missing）", async () => {
    const b = await health({ FIREBASE_PROJECT_ID: "demo-x-project", FIREBASE_CLIENT_EMAIL: "a@demo-x-project.iam.gserviceaccount.com", FIREBASE_PRIVATE_KEY: FAKE_KEY });
    expect([b.FIREBASE_CREDENTIALS, b.FIREBASE_CLIENT_EMAIL]).toEqual(["service-account-key", "set"]);
  });

  it("application-default：秘密鍵は not used。登録が残っていれば注意を出す", async () => {
    let b = await health({ FIREBASE_CREDENTIALS: "application-default", FIREBASE_PROJECT_ID: "demo-x-project" });
    expect([b.FIREBASE_CREDENTIALS, b.FIREBASE_CLIENT_EMAIL, b.FIREBASE_PRIVATE_KEY]).toEqual(["application-default", "not used", "not used"]);
    b = await health({ FIREBASE_CREDENTIALS: "application-default", FIREBASE_PROJECT_ID: "demo-x-project", FIREBASE_PRIVATE_KEY: FAKE_KEY });
    expect(b.FIREBASE_PRIVATE_KEY).toMatch(/登録しないでください/);
    expect(b.database).toMatch(/^error: Firebase is misconfigured/);
  });

  it("想定外の値：invalid と表示し、接続しない", async () => {
    const b = await health({ FIREBASE_CREDENTIALS: "adc", FIREBASE_PROJECT_ID: "demo-x-project" });
    expect(b.FIREBASE_CREDENTIALS).toMatch(/^invalid/);
    expect(sdk.init).toHaveLength(0);
  });
});
