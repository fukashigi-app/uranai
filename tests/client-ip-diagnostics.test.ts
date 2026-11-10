/**
 * 【一時的・Cloud Run の Sandbox 専用】送信元 IP のヘッダーの構造の診断（lib/ops/client-ip-diagnostics.ts・app/api/ops/client-ip/route.ts）。
 * 診断を削除するときは、このテストも削除する。
 *  - Sandbox 以外（本番・Vercel・ローカル・本番の Stripe の設定あり）では無効（404）
 *  - 診断用のトークン＋運営アカウントのログインの両方が必要
 *  - IP・ヘッダーの値・Cookie・トークン・Stripe の秘密情報を返さない。ログを出さない。Cache-Control: no-store
 * データベース・ログインは模擬。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ClientIpDiagnostics } from "@/lib/ops/client-ip-diagnostics";

const auth = vi.hoisted(() => ({ role: null as null | "OPERATOR" | "STORE", calls: 0, throws: false }));
vi.mock("@/lib/auth/session", () => ({
  getSessionUser: async () => {
    auth.calls++;
    if (auth.throws) throw new Error("db down");
    return auth.role ? { id: "u1", role: auth.role } : null;
  },
}));

const TOKEN = "diag-ip-unit-token-Qw7Lp2Zx9Rv4Mn8Kt3Hy6Bc1";
const SANDBOX = {
  CLIENT_IP_DIAGNOSTICS: "on",
  CLIENT_IP_DIAGNOSTICS_TOKEN: TOKEN,
  K_SERVICE: "uranai-sandbox",
  VERCEL_ENV: "preview",
  VERCEL_GIT_COMMIT_REF: "preview/stripe-sandbox-v2",
  FIREBASE_PROJECT_ID: "uranai-stripe-sandbox-v2",
  PRODUCTION_FIREBASE_PROJECT_ID: "uranai-b6edf",
  STRIPE_SECRET_KEY: "sk_test_x-unit-dummy", // 接頭辞だけ本物と同じ（判定は接頭辞だけ）。本物のキーの形・長さにしない
  APP_URL: "https://uranai-sandbox-123456789012.asia-northeast1.run.app",
};
const KEYS = [...Object.keys(SANDBOX), "VERCEL", "STRIPE_LIVE_CHECKOUT", "CLIENT_IP_SOURCE", "CLIENT_IP_XFF_POSITION_FROM_RIGHT"];
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  auth.role = null;
  auth.calls = 0;
  auth.throws = false;
});
afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe("有効になる環境（Cloud Run の Sandbox だけ）", () => {
  it("Sandbox の設定がすべてそろったときだけ有効", async () => {
    const { clientIpDiagnosticsEnabled } = await import("@/lib/ops/client-ip-diagnostics");
    expect(clientIpDiagnosticsEnabled(SANDBOX)).toBe(true);
  });

  it("1つでも欠ける・本番に関わる設定があれば無効", async () => {
    const { clientIpDiagnosticsEnabled } = await import("@/lib/ops/client-ip-diagnostics");
    const off: Record<string, string | undefined>[] = [
      { CLIENT_IP_DIAGNOSTICS: undefined },
      { CLIENT_IP_DIAGNOSTICS: "true" },
      { CLIENT_IP_DIAGNOSTICS: "ON" },
      { VERCEL_ENV: "production" }, // 本番
      { VERCEL_ENV: undefined }, // ローカル・判定できない
      { VERCEL_ENV: "development" },
      { VERCEL: "1" }, // Vercel 上
      { K_SERVICE: undefined }, // Cloud Run ではない
      { FIREBASE_PROJECT_ID: "uranai-b6edf" }, // 本番の Firestore
      { FIREBASE_PROJECT_ID: "some-other-project" }, // 一覧にないプロジェクト
      { PRODUCTION_FIREBASE_PROJECT_ID: undefined },
      { PRODUCTION_FIREBASE_PROJECT_ID: "uranai-stripe-sandbox-v2" },
      { STRIPE_SECRET_KEY: "sk_live_x-unit-dummy" }, // 本番の Stripe のキー（接頭辞だけ。本物の形にしない）
      { STRIPE_SECRET_KEY: "rk_live_x-unit-dummy" },
      { STRIPE_LIVE_CHECKOUT: "on" },
      { CLIENT_IP_DIAGNOSTICS_TOKEN: undefined },
      { CLIENT_IP_DIAGNOSTICS_TOKEN: "short-token" },
      { CLIENT_IP_DIAGNOSTICS_TOKEN: " ".repeat(40) },
    ];
    for (const o of off) expect(clientIpDiagnosticsEnabled({ ...SANDBOX, ...o }), JSON.stringify(o)).toBe(false);
  });
});

async function call(headers: Record<string, string>) {
  const { GET } = await import("@/app/api/ops/client-ip/route");
  const res = await GET(new Request("https://uranai-sandbox-123456789012.asia-northeast1.run.app/api/ops/client-ip", { headers }));
  return { res, text: await res.text() };
}

describe("ルートの認証（無効 → 404、トークン → 401、ログイン → 403）", () => {
  it("無効なら 404。ログインの確認（データベース）にも進まない", async () => {
    Object.assign(process.env, SANDBOX, { VERCEL_ENV: "production" });
    auth.role = "OPERATOR";
    const { res } = await call({ authorization: `Bearer ${TOKEN}` });
    expect(res.status).toBe(404);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(auth.calls).toBe(0);
  });

  it("トークンが無い・違う：401。ログインの確認に進まない", async () => {
    Object.assign(process.env, SANDBOX);
    auth.role = "OPERATOR";
    for (const a of [undefined, `Bearer ${TOKEN}x`, `bearer ${TOKEN}`, TOKEN, `Bearer  ${TOKEN}`]) {
      const { res, text } = await call(a ? { authorization: a } : {});
      expect(res.status, String(a)).toBe(401);
      expect(text).not.toContain(TOKEN);
    }
    expect(auth.calls).toBe(0);
  });

  it("トークンが正しくても、運営アカウントでなければ 403（未ログイン・店舗・確認の失敗）", async () => {
    Object.assign(process.env, SANDBOX);
    for (const [role, throws] of [[null, false], ["STORE", false], ["OPERATOR", true]] as const) {
      auth.role = role;
      auth.throws = throws;
      const { res } = await call({ authorization: `Bearer ${TOKEN}` });
      expect(res.status).toBe(403);
    }
  });
});

describe("診断の内容（構造だけ。値は返さない）", () => {
  const SECRET_COOKIE = "__Host-sid=SESSIONCOOKIEVALUE123; fx_access=ACCESSCOOKIEVALUE456";
  const run = async (extra: Record<string, string> = {}) => {
    Object.assign(process.env, SANDBOX);
    auth.role = "OPERATOR";
    const { res, text } = await call({
      authorization: `Bearer ${TOKEN}`,
      cookie: SECRET_COOKIE,
      "stripe-signature": "t=1,v1=STRIPESIGNATUREVALUE",
      host: "uranai-sandbox-123456789012.asia-northeast1.run.app",
      "x-forwarded-proto": "https",
      ...extra,
    });
    return { res, text, body: JSON.parse(text) as { clientIp: ClientIpDiagnostics } };
  };

  it("位置ごとの種類・件数・申告した自分の IP との一致だけを返し、IP・Cookie・トークン・Stripe の値は返さない", async () => {
    const { res, text, body } = await run({
      "x-forwarded-for": "198.51.100.77, 203.0.113.10, 192.0.2.200",
      "x-real-ip": "198.51.100.78",
      "x-diagnostics-expected-ip": "203.0.113.10",
      "x-forwarded-host": "evil.example",
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    for (const v of ["198.51.100.77", "203.0.113.10", "192.0.2.200", "198.51.100.78", "evil.example", "SESSIONCOOKIEVALUE123", "ACCESSCOOKIEVALUE456", "STRIPESIGNATUREVALUE", TOKEN, "sk_test_", "run.app"]) {
      expect(text, v).not.toContain(v);
    }
    const ip = body.clientIp;
    expect(ip.xForwardedFor.entryCount).toBe(3);
    expect(ip.xForwardedFor.entriesFromRight).toEqual([
      { fromRight: 1, kind: "ipv4", documentationAddress: true, matchesExpected: false },
      { fromRight: 2, kind: "ipv4", documentationAddress: true, matchesExpected: true },
      { fromRight: 3, kind: "ipv4", documentationAddress: true, matchesExpected: false },
    ]);
    expect(ip.xRealIp).toEqual({ present: true, kind: "ipv4", matchesExpected: false });
    expect(ip.expectedIpProvided).toBe(true);
    expect(ip.host).toEqual({ present: true, matchesAppUrl: true });
    expect(ip.xForwardedHost).toEqual({ present: true, entryCount: 1, firstMatchesAppUrl: false });
    expect(ip.xForwardedProto).toEqual({ present: true, entryCount: 1, first: "https" });
    expect(ip.clientIpSource).toEqual({ mode: "default", position: null, resolution: "default (Vercel 向けの判定)", resolvedMatchesExpected: null });
  });

  it("Cloud Run 用の設定を入れたとき、その設定で判定できたか・申告した IP と一致したかを返す（IP は返さない）", async () => {
    process.env.CLIENT_IP_SOURCE = "x-forwarded-for-from-right";
    process.env.CLIENT_IP_XFF_POSITION_FROM_RIGHT = "2";
    let r = await run({ "x-forwarded-for": "192.0.2.1, 203.0.113.10, 198.51.100.200", "x-diagnostics-expected-ip": "203.0.113.10" });
    expect(r.body.clientIp.clientIpSource).toEqual({ mode: "x-forwarded-for-from-right", position: 2, resolution: "resolved", resolvedMatchesExpected: true });
    r = await run({ "x-forwarded-for": "198.51.100.200" });
    expect(r.body.clientIp.clientIpSource.resolution).toBe("unresolved (xff_too_few_entries)");
    process.env.CLIENT_IP_XFF_POSITION_FROM_RIGHT = "7";
    r = await run({ "x-forwarded-for": "203.0.113.10, 198.51.100.200" });
    expect(r.body.clientIp.clientIpSource).toMatchObject({ mode: "invalid", resolution: "config_error" });
  });

  it("形式の異常・ヘッダーの欠落も、種類だけで示す（値は返さない）", async () => {
    const { text, body } = await run({ "x-forwarded-for": "garbage-value, 203.0.113.10:443, , 2001:db8::5", "x-diagnostics-expected-ip": "not-an-ip" });
    expect(text).not.toContain("garbage-value");
    expect(body.clientIp.expectedIpProvided).toBe(false);
    expect(body.clientIp.xForwardedFor.entriesFromRight.map((e) => e.kind)).toEqual(["ipv6", "empty", "ip-with-port", "other"]);
    expect(body.clientIp.xRealIp).toEqual({ present: false, kind: null, matchesExpected: null });
    const none = await run({});
    expect(none.body.clientIp.xForwardedFor).toEqual({ present: false, entryCount: 0, entriesFromRight: [] });
  });

  it("ログを出さない", async () => {
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => undefined));
    await run({ "x-forwarded-for": "203.0.113.10, 198.51.100.200" });
    for (const s of spies) {
      expect(s).not.toHaveBeenCalled();
      s.mockRestore();
    }
  });
});

describe("専用ヘッダー（x-client-ip-diagnostics-token）による認証", () => {
  const HDR = "x-client-ip-diagnostics-token";
  const asOperator = () => {
    Object.assign(process.env, SANDBOX);
    auth.role = "OPERATOR";
  };

  it("専用ヘッダーで認証できる（Google 側の認証は X-Serverless-Authorization で送る想定）", async () => {
    asOperator();
    const { res, text } = await call({ [HDR]: TOKEN, "x-serverless-authorization": "Bearer google-id-token-placeholder" });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(text).not.toContain(TOKEN);
    expect(text).not.toContain("google-id-token-placeholder");
  });

  it("従来の Authorization: Bearer でも認証できる", async () => {
    asOperator();
    const { res } = await call({ authorization: `Bearer ${TOKEN}` });
    expect(res.status).toBe(200);
  });

  it("トークンの欠落・不一致・形式の誤りは 401。ログインの確認（データベース）に進まない", async () => {
    asOperator();
    for (const h of [
      {},
      { [HDR]: `${TOKEN}x` },
      { [HDR]: TOKEN.slice(0, -1) },
      { [HDR]: "" },
      { [HDR]: `${TOKEN} ${TOKEN}` },
      { [HDR]: `Bearer ${TOKEN}` },
    ] as Record<string, string>[]) {
      const { res, text } = await call(h);
      expect(res.status, JSON.stringify(Object.keys(h))).toBe(401);
      expect(text).not.toContain(TOKEN);
    }
    // 同じヘッダーが2つ（値が結合される）も拒否
    const { GET } = await import("@/app/api/ops/client-ip/route");
    const headers = new Headers();
    headers.append(HDR, TOKEN);
    headers.append(HDR, TOKEN);
    expect((await GET(new Request("https://uranai-sandbox-123456789012.asia-northeast1.run.app/api/ops/client-ip", { headers }))).status).toBe(401);
    expect(auth.calls).toBe(0);
  });

  it("両方のヘッダーがあるときは、値に関係なく 401（優先順位を作らない）", async () => {
    asOperator();
    for (const h of [
      { authorization: `Bearer ${TOKEN}`, [HDR]: TOKEN }, // 両方とも正しい
      { authorization: "Bearer google-id-token-placeholder", [HDR]: TOKEN }, // Google 側の ID トークンが Authorization に残る経路
      { authorization: `Bearer ${TOKEN}`, [HDR]: "wrong" },
      { authorization: "", [HDR]: TOKEN },
    ]) {
      const { res, text } = await call(h);
      expect(res.status).toBe(401);
      expect(text).not.toContain(TOKEN);
    }
    expect(auth.calls).toBe(0);
  });

  it("サーバーのトークンが短すぎる（32文字未満）なら、専用ヘッダーでも 404", async () => {
    Object.assign(process.env, SANDBOX, { CLIENT_IP_DIAGNOSTICS_TOKEN: "short-token-0123456789" });
    auth.role = "OPERATOR";
    expect((await call({ [HDR]: "short-token-0123456789" })).res.status).toBe(404);
    expect(auth.calls).toBe(0);
  });

  it("運営アカウントでなければ、専用ヘッダーのトークンが正しくても 403（診断の内容を返さない）", async () => {
    Object.assign(process.env, SANDBOX);
    for (const role of [null, "STORE"] as const) {
      auth.role = role;
      const { res, text } = await call({ [HDR]: TOKEN, "x-forwarded-for": "203.0.113.10, 198.51.100.200" });
      expect(res.status).toBe(403);
      expect(text).not.toMatch(/xForwardedFor|entriesFromRight|203\.0\.113\.10/);
    }
  });

  it("本番・Vercel では、専用ヘッダーでも 404", async () => {
    for (const o of [{ VERCEL_ENV: "production" }, { VERCEL: "1" }, { STRIPE_LIVE_CHECKOUT: "on" }, { FIREBASE_PROJECT_ID: "uranai-b6edf" }]) {
      for (const k of KEYS) delete process.env[k];
      Object.assign(process.env, SANDBOX, o);
      auth.role = "OPERATOR";
      const { res, text } = await call({ [HDR]: TOKEN });
      expect(res.status, JSON.stringify(o)).toBe(404);
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(text).not.toContain(TOKEN);
    }
    expect(auth.calls).toBe(0);
  });

  it("専用ヘッダーの経路でも、トークン・Cookie・IP を応答とログに出さない", async () => {
    asOperator();
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => undefined));
    const outputs: string[] = [];
    const variants: Record<string, string>[] = [{ [HDR]: TOKEN }, { [HDR]: "wrong-token" }, { [HDR]: TOKEN, authorization: `Bearer ${TOKEN}` }];
    for (const h of variants) {
      outputs.push((await call({ ...h, cookie: "__Host-sid=SESSIONCOOKIEVALUE123", "x-forwarded-for": "198.51.100.77, 203.0.113.10" })).text);
    }
    for (const t of outputs) {
      for (const v of [TOKEN, "wrong-token", "SESSIONCOOKIEVALUE123", "198.51.100.77", "203.0.113.10"]) expect(t).not.toContain(v);
    }
    for (const s of spies) {
      expect(s).not.toHaveBeenCalled();
      s.mockRestore();
    }
  });
});
