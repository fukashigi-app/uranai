/**
 * /api/health（運営の詳細表示）：Cloud Run 用の設定の状態（CLIENT_IP_SOURCE・TRUSTED_ORIGIN_SOURCE）。
 *  - 表示は「未設定」「有効」「設定の誤り」の3種類だけ。位置・APP_URL・秘密情報の値は返さない
 *  - 未設定（Vercel）は正常。設定の誤りは ok=false（API が停止するため）。誤りがあっても状態は報告する
 *  - 認証なし・運営以外の応答は変えない。状態の判定のために Firestore へ接続しない
 * ログイン・Firestore・定期処理の状況は模擬。
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const st = vi.hoisted(() => ({ role: null as null | "OPERATOR" | "STORE", pings: 0, maintenance: 0 }));
vi.mock("@/lib/auth/session", () => ({ getSessionUser: async () => (st.role ? { id: "u1", role: st.role } : null) }));
vi.mock("@/lib/firestore/misc", () => ({
  ping: async () => {
    st.pings++;
    return "ok";
  },
}));
vi.mock("@/lib/services/maintenance-status", () => ({
  getMaintenanceStatus: async () => {
    st.maintenance++;
    return { tracked: true, lastSuccessAt: new Date(), stale: false, lastStatus: "success" };
  },
}));

const APP = "https://uranai-sandbox-123456789012.asia-northeast1.run.app";
const SECRET_MARKERS = {
  SESSION_SECRET: "unit-test-session-secret-SECRETMARKER-0123456789",
  CRON_SECRET: "cron-SECRETMARKER-abcdefghijklmnopqrstuvwxyz",
  CLIENT_IP_DIAGNOSTICS_TOKEN: "diag-SECRETMARKER-abcdefghijklmnopqrstuvwxyz",
  STRIPE_SECRET_KEY: "sk_test_x-SECRETMARKER", // 接頭辞だけ本物と同じ。本物のキーの形・長さにしない
};
const KEYS = [
  "CLIENT_IP_SOURCE",
  "CLIENT_IP_XFF_POSITION_FROM_RIGHT",
  "TRUSTED_ORIGIN_SOURCE",
  "APP_URL",
  "DB_PROVIDER",
  "FIREBASE_PROJECT_ID",
  "VERCEL_ENV",
  "VERCEL_PROJECT_PRODUCTION_URL",
  "VERCEL_BRANCH_URL",
  ...Object.keys(SECRET_MARKERS),
];
const saved: Record<string, string | undefined> = {};

beforeAll(() => {
  for (const k of KEYS) saved[k] = process.env[k];
});
beforeEach(() => {
  for (const k of KEYS) delete process.env[k];
  Object.assign(process.env, SECRET_MARKERS, { DB_PROVIDER: "firestore", FIREBASE_PROJECT_ID: "demo-x-project" });
  st.role = "OPERATOR";
  st.pings = 0;
  st.maintenance = 0;
});
afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

async function health(env: Record<string, string> = {}) {
  Object.assign(process.env, env);
  const { GET } = await import("@/app/api/health/route");
  const res = await GET();
  const text = await res.text();
  return { res, text, body: JSON.parse(text) as Record<string, unknown> };
}

describe("運営の詳細表示：Cloud Run 用の設定の状態", () => {
  it("両方未設定（Vercel）：未設定で、正常（ok=true・200）", async () => {
    const { res, body } = await health();
    expect([body.CLIENT_IP_SOURCE, body.TRUSTED_ORIGIN_SOURCE]).toEqual(["未設定", "未設定"]);
    expect(body.ok).toBe(true);
    expect(res.status).toBe(200);
  });

  it("正しい設定：有効（ok=true）", async () => {
    const { body } = await health({ CLIENT_IP_SOURCE: "x-forwarded-for-from-right", CLIENT_IP_XFF_POSITION_FROM_RIGHT: "2", TRUSTED_ORIGIN_SOURCE: "app-url", APP_URL: APP });
    expect([body.CLIENT_IP_SOURCE, body.TRUSTED_ORIGIN_SOURCE]).toEqual(["有効", "有効"]);
    expect(body.ok).toBe(true);
  });

  it("CLIENT_IP_SOURCE：不正な値・IP 位置の設定漏れ・範囲外・位置だけ残っている → 設定の誤り（ok=false・503。ほかの状態も報告する）", async () => {
    const cases: Record<string, string>[] = [
      { CLIENT_IP_SOURCE: "cloud-run", CLIENT_IP_XFF_POSITION_FROM_RIGHT: "2" },
      { CLIENT_IP_SOURCE: "x-forwarded-for-from-right" }, // 位置の設定漏れ
      { CLIENT_IP_SOURCE: "x-forwarded-for-from-right", CLIENT_IP_XFF_POSITION_FROM_RIGHT: "" },
      { CLIENT_IP_SOURCE: "x-forwarded-for-from-right", CLIENT_IP_XFF_POSITION_FROM_RIGHT: "0" },
      { CLIENT_IP_SOURCE: "x-forwarded-for-from-right", CLIENT_IP_XFF_POSITION_FROM_RIGHT: "6" },
      { CLIENT_IP_SOURCE: "x-forwarded-for-from-right", CLIENT_IP_XFF_POSITION_FROM_RIGHT: "two" },
      { CLIENT_IP_XFF_POSITION_FROM_RIGHT: "2" }, // 方式の設定漏れ（位置だけ残っている）
    ];
    for (const c of cases) {
      for (const k of ["CLIENT_IP_SOURCE", "CLIENT_IP_XFF_POSITION_FROM_RIGHT"]) delete process.env[k];
      const { res, body } = await health(c);
      expect(body.CLIENT_IP_SOURCE, JSON.stringify(c)).toBe("設定の誤り");
      expect(body.TRUSTED_ORIGIN_SOURCE).toBe("未設定");
      expect(body.ok).toBe(false);
      expect(res.status).toBe(503);
      expect(body.database).toBe("ok"); // 誤りがあっても、ほかの確認は続けて報告する
    }
  });

  it("TRUSTED_ORIGIN_SOURCE：不正な値・APP_URL の設定漏れ・形式の不正 → 設定の誤り（ok=false）", async () => {
    const cases: Record<string, string>[] = [
      { TRUSTED_ORIGIN_SOURCE: "true", APP_URL: APP },
      { TRUSTED_ORIGIN_SOURCE: "app-url" }, // APP_URL の設定漏れ
      { TRUSTED_ORIGIN_SOURCE: "app-url", APP_URL: "" },
      { TRUSTED_ORIGIN_SOURCE: "app-url", APP_URL: APP.replace("https://", "http://") },
      { TRUSTED_ORIGIN_SOURCE: "app-url", APP_URL: `${APP}/payment` },
      { TRUSTED_ORIGIN_SOURCE: "app-url", APP_URL: "not a url" },
      { TRUSTED_ORIGIN_SOURCE: "app-url", APP_URL: "https://user:pass@uranai.example.jp" },
    ];
    for (const c of cases) {
      for (const k of ["TRUSTED_ORIGIN_SOURCE", "APP_URL"]) delete process.env[k];
      const { body } = await health(c);
      expect(body.TRUSTED_ORIGIN_SOURCE, JSON.stringify(c)).toBe("設定の誤り");
      expect(body.CLIENT_IP_SOURCE).toBe("未設定");
      expect(body.ok).toBe(false);
    }
  });

  it("状態は3種類だけで、IP の位置・APP_URL・秘密情報の値を返さない", async () => {
    for (const env of [
      { CLIENT_IP_SOURCE: "x-forwarded-for-from-right", CLIENT_IP_XFF_POSITION_FROM_RIGHT: "3", TRUSTED_ORIGIN_SOURCE: "app-url", APP_URL: APP },
      { CLIENT_IP_SOURCE: "x-forwarded-for-from-right", CLIENT_IP_XFF_POSITION_FROM_RIGHT: "7", TRUSTED_ORIGIN_SOURCE: "app-url", APP_URL: "http://wrong-host.example/path" },
    ]) {
      for (const k of ["CLIENT_IP_SOURCE", "CLIENT_IP_XFF_POSITION_FROM_RIGHT", "TRUSTED_ORIGIN_SOURCE", "APP_URL"]) delete process.env[k];
      const { text, body } = await health(env);
      expect(["未設定", "有効", "設定の誤り"]).toContain(body.CLIENT_IP_SOURCE);
      expect(["未設定", "有効", "設定の誤り"]).toContain(body.TRUSTED_ORIGIN_SOURCE);
      expect(text).not.toContain("SECRETMARKER");
      expect(text).not.toContain("run.app");
      expect(text).not.toContain("wrong-host");
      expect(text).not.toContain("x-forwarded-for-from-right");
      expect(text).not.toMatch(/"CLIENT_IP_XFF_POSITION_FROM_RIGHT"|"position"/);
    }
  });

  it("状態の判定のために Firestore へ余計に接続しない（接続確認・定期処理の状況の各1回は従来どおり）", async () => {
    await health();
    expect([st.pings, st.maintenance]).toEqual([1, 1]);
    st.pings = 0;
    st.maintenance = 0;
    await health({ CLIENT_IP_SOURCE: "x-forwarded-for-from-right", CLIENT_IP_XFF_POSITION_FROM_RIGHT: "2", TRUSTED_ORIGIN_SOURCE: "app-url" });
    expect([st.pings, st.maintenance]).toEqual([1, 1]);
  });
});

describe("認証なし・運営以外：応答は変えない（詳細を出さない）", () => {
  for (const role of [null, "STORE"] as const) {
    it(`${role ?? "認証なし"}：ok と案内だけ。Cloud Run の設定の誤りがあっても詳細・状態を出さず、Firestore も読まない`, async () => {
      st.role = role;
      const { res, body, text } = await health({ CLIENT_IP_SOURCE: "x-forwarded-for-from-right", TRUSTED_ORIGIN_SOURCE: "app-url" });
      expect(Object.keys(body).sort()).toEqual(["detail", "ok"]);
      expect(body.ok).toBe(true); // 判定は従来どおり（SESSION_SECRET と本番の設定だけ）
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(text).not.toMatch(/CLIENT_IP_SOURCE|TRUSTED_ORIGIN_SOURCE|設定の誤り|SECRETMARKER/);
      expect([st.pings, st.maintenance]).toEqual([0, 0]);
    });
  }
});

describe("運営者情報の不正な値：Cloud Run 上だけ ok=false（Vercel は従来どおり）", () => {
  const extra = ["K_SERVICE", "OPERATOR_EMAIL"];
  const savedOp: Record<string, string | undefined> = {};
  beforeEach(() => {
    for (const k of extra) {
      savedOp[k] = process.env[k];
      delete process.env[k];
    }
  });
  afterEach(() => {
    for (const k of extra) {
      if (savedOp[k] === undefined) delete process.env[k];
      else process.env[k] = savedOp[k];
    }
  });

  it("Cloud Run（K_SERVICE あり）で仮の値：ok=false・503。値は返さない", async () => {
    const { res, text, body } = await health({ K_SERVICE: "uranai-prod", OPERATOR_EMAIL: "info@example.com" });
    expect(String(body.operatorInfo)).toMatch(/^error: /);
    expect(body.ok).toBe(false);
    expect(res.status).toBe(503);
    expect(text).not.toContain("info@example.com");
  });

  it("Vercel（K_SERVICE なし）で同じ値：表示は error のまま、ok の判定は従来どおり（true）", async () => {
    const { body } = await health({ OPERATOR_EMAIL: "info@example.com" });
    expect(String(body.operatorInfo)).toMatch(/^error: /);
    expect(body.ok).toBe(true);
  });

  it("Cloud Run で未設定（既定の屋号・問い合わせ先・請求時開示）は ok=true（operatorDisclosure で確認する）", async () => {
    const { body } = await health({ K_SERVICE: "uranai-prod" });
    expect(body.operatorInfo).toBe("ok");
    expect(String(body.operatorDisclosure)).toMatch(/^on-request/);
    expect(body.ok).toBe(true);
  });
});
