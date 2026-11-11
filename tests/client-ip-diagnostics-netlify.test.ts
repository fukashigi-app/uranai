/**
 * 【一時的】送信元 IP のヘッダーの構造の診断の Netlify 用の分岐（lib/ops/client-ip-diagnostics.ts）。診断を削除するときは、このテストも削除する。
 *  - Netlify の診断用ブランチの設定がすべてそろい、リクエストの Host が設定と完全に一致するときだけ有効（それ以外は 404）
 *  - 認証は従来どおり（診断用のトークン・運営者のログイン）
 *  - Netlify 用の項目（x-nf-client-connection-ip・client-ip・x-nf-request-id・Context.ip）は構造だけ。値・秘密は返さない・ログに出さない
 *  - Cloud Run・Vercel の条件と、Netlify の設定が無いときの結果は従来どおり
 * データベース・ログインは模擬。外部には接続しない。IP はすべて文書用のアドレス（RFC 5737）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ClientIpDiagnostics } from "@/lib/ops/client-ip-diagnostics";

const auth = vi.hoisted(() => ({ role: null as null | "OPERATOR" | "STORE", calls: 0 }));
vi.mock("@/lib/auth/session", () => ({
  getSessionUser: async () => {
    auth.calls++;
    return auth.role ? { id: "u1", role: auth.role } : null;
  },
}));

const TOKEN = "diag-netlify-unit-token-Qw7Lp2Zx9Rv4Mn8K";
const HOST = "ipdiag--uranai-unit.netlify.app";
const NETLIFY = {
  CLIENT_IP_DIAGNOSTICS: "on",
  CLIENT_IP_DIAGNOSTICS_PLATFORM: "netlify",
  CLIENT_IP_DIAGNOSTICS_HOST: HOST,
  CLIENT_IP_DIAGNOSTICS_TOKEN: TOKEN,
  VERCEL_ENV: "preview",
  VERCEL_GIT_COMMIT_REF: "preview/stripe-sandbox-v2",
  FIREBASE_PROJECT_ID: "uranai-stripe-sandbox-v2",
  PRODUCTION_FIREBASE_PROJECT_ID: "uranai-b6edf",
  STRIPE_SECRET_KEY: "sk_test_x-unit-dummy",
  APP_URL: `https://${HOST}`,
};
const KEYS = [...Object.keys(NETLIFY), "K_SERVICE", "VERCEL", "STRIPE_LIVE_CHECKOUT", "CLIENT_IP_SOURCE", "CLIENT_IP_XFF_POSITION_FROM_RIGHT"];
const saved: Record<string, string | undefined> = {};
const HDR = "x-client-ip-diagnostics-token";

beforeEach(() => {
  for (const k of KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  auth.role = "OPERATOR";
  auth.calls = 0;
});
afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  delete (globalThis as { Netlify?: unknown }).Netlify;
});

async function call(headers: Record<string, string>, env: Record<string, string | undefined> = NETLIFY) {
  for (const k of KEYS) delete process.env[k];
  for (const [k, v] of Object.entries(env)) if (v !== undefined) process.env[k] = v;
  const { GET } = await import("@/app/api/ops/client-ip/route");
  const res = await GET(new Request(`https://${HOST}/api/ops/client-ip`, { headers }));
  return { res, text: await res.text() };
}
const ok = (extra: Record<string, string> = {}) => ({ host: HOST, [HDR]: TOKEN, ...extra });

describe("有効になる条件（すべてそろったときだけ）", () => {
  it("すべての条件がそろい、Host が一致し、トークンと運営者のログインがあれば 200", async () => {
    const { res, text } = await call(ok());
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = JSON.parse(text) as { clientIp: ClientIpDiagnostics };
    expect(body.clientIp.netlify).toBeDefined();
  });

  it("設定が1つでも欠ける・違う・本番の設定があれば 404（ログインの確認にも進まない）", async () => {
    const cases: Record<string, string | undefined>[] = [
      { CLIENT_IP_DIAGNOSTICS: undefined },
      { CLIENT_IP_DIAGNOSTICS: "true" },
      { CLIENT_IP_DIAGNOSTICS_PLATFORM: undefined },
      { CLIENT_IP_DIAGNOSTICS_PLATFORM: "Netlify" },
      { CLIENT_IP_DIAGNOSTICS_PLATFORM: "cloudrun" },
      { CLIENT_IP_DIAGNOSTICS_HOST: undefined },
      { CLIENT_IP_DIAGNOSTICS_HOST: "" },
      { CLIENT_IP_DIAGNOSTICS_HOST: "uranai-unit.netlify.app" }, // 本番のサイトの URL（-- が無い）
      { CLIENT_IP_DIAGNOSTICS_HOST: "uranai.example.jp" }, // 独自ドメイン
      { CLIENT_IP_DIAGNOSTICS_HOST: `${HOST}:443` },
      { CLIENT_IP_DIAGNOSTICS_HOST: `${HOST}.evil.example` },
      { CLIENT_IP_DIAGNOSTICS_HOST: "ipdiag--uranai-unit.netlify.com" },
      { CLIENT_IP_DIAGNOSTICS_HOST: "--uranai-unit.netlify.app" },
      { VERCEL_ENV: "production" },
      { VERCEL_ENV: undefined },
      { VERCEL: "1" }, // Vercel 上
      { FIREBASE_PROJECT_ID: "uranai-b6edf" }, // 本番の Firestore
      { FIREBASE_PROJECT_ID: "some-other-project" },
      { PRODUCTION_FIREBASE_PROJECT_ID: undefined },
      { PRODUCTION_FIREBASE_PROJECT_ID: "uranai-stripe-sandbox-v2" },
      { STRIPE_SECRET_KEY: "sk_live_x-unit-dummy" },
      { STRIPE_SECRET_KEY: "rk_live_x-unit-dummy" },
      { STRIPE_LIVE_CHECKOUT: "on" },
      { CLIENT_IP_DIAGNOSTICS_TOKEN: undefined },
      { CLIENT_IP_DIAGNOSTICS_TOKEN: "short-token" },
    ];
    for (const c of cases) {
      const env = { ...NETLIFY, ...c };
      const { res } = await call(ok(), env);
      expect(res.status, JSON.stringify(c)).toBe(404);
    }
    expect(auth.calls).toBe(0);
  });

  it("Host が違う・無い・ポート付き・複数・X-Forwarded-Host だけが一致：404", async () => {
    for (const h of [
      { [HDR]: TOKEN }, // Host なし
      { host: "uranai-unit.netlify.app", [HDR]: TOKEN },
      { host: "other--uranai-unit.netlify.app", [HDR]: TOKEN },
      { host: `${HOST}:443`, [HDR]: TOKEN },
      { host: `${HOST}, evil.example`, [HDR]: TOKEN },
      { host: "evil.example", "x-forwarded-host": HOST, [HDR]: TOKEN },
    ] as Record<string, string>[]) {
      const { res, text } = await call(h);
      expect(res.status, JSON.stringify(h)).toBe(404);
      expect(text).not.toContain(TOKEN);
    }
    expect(auth.calls).toBe(0);
  });

  it("Host の大文字・小文字の違いは同じ名前として扱う（DNS の名前は大文字・小文字を区別しない）", async () => {
    expect((await call(ok({ host: HOST.toUpperCase() }))).res.status).toBe(200);
  });
});

describe("認証（従来どおり）", () => {
  it("トークンが無い・違う・両方のヘッダー：401（ログインの確認に進まない）。運営者でなければ 403", async () => {
    for (const h of [{ host: HOST }, { host: HOST, [HDR]: `${TOKEN}x` }, { host: HOST, [HDR]: TOKEN, authorization: `Bearer ${TOKEN}` }] as Record<string, string>[]) {
      expect((await call(h)).res.status).toBe(401);
    }
    expect(auth.calls).toBe(0);
    for (const role of [null, "STORE"] as const) {
      auth.role = role;
      const { res, text } = await call(ok({ "x-nf-client-connection-ip": "203.0.113.10" }));
      expect(res.status).toBe(403);
      expect(text).not.toMatch(/netlify|xNfClientConnectionIp/);
    }
  });
});

describe("Netlify 用の項目（構造だけ）", () => {
  const SENSITIVE = ["203.0.113.10", "198.51.100.7", "192.0.2.55", "192.0.2.66", "SESSIONCOOKIE123", "NFREQUESTID999", TOKEN, "sk_test_"];

  it("偽装した値（文書用のアドレス）・申告した IP との一致・複数の値・x-nf-request-id の有無を、値を出さずに返す", async () => {
    const { res, text } = await call(
      ok({
        "x-diagnostics-expected-ip": "203.0.113.10",
        "x-nf-client-connection-ip": "203.0.113.10",
        "client-ip": "192.0.2.55, 198.51.100.7",
        "x-real-ip": "192.0.2.66",
        "x-forwarded-for": "198.51.100.7, 203.0.113.10",
        "x-nf-request-id": "NFREQUESTID999",
        cookie: "__Host-sid=SESSIONCOOKIE123",
      }),
    );
    expect(res.status).toBe(200);
    for (const v of SENSITIVE) expect(text, v).not.toContain(v);
    const n = (JSON.parse(text) as { clientIp: ClientIpDiagnostics }).clientIp.netlify!;
    expect(n.xNfClientConnectionIp).toEqual({ present: true, kind: "ipv4", documentationAddress: true, matchesExpected: true });
    expect(n.clientIp).toEqual({ present: true, kind: "other", documentationAddress: false, matchesExpected: false }); // 複数の値は信頼できる形ではない
    expect(n.xNfRequestIdPresent).toBe(true);
    expect(n.contextIp).toEqual({ status: "unavailable", matchesExpected: null });
  });

  it("ヘッダーが無いときは present: false", async () => {
    const n = (JSON.parse((await call(ok())).text) as { clientIp: ClientIpDiagnostics }).clientIp.netlify!;
    expect(n.xNfClientConnectionIp).toEqual({ present: false, kind: null, documentationAddress: false, matchesExpected: null });
    expect(n.clientIp.present).toBe(false);
    expect(n.xNfRequestIdPresent).toBe(false);
  });

  it("Context.ip：Netlify のグローバルが見つかっても「確認できていない」とし、値は返さない（比較だけ）", async () => {
    (globalThis as { Netlify?: unknown }).Netlify = { context: { ip: "203.0.113.10" } };
    const { text } = await call(ok({ "x-diagnostics-expected-ip": "203.0.113.10" }));
    expect(text).not.toContain("203.0.113.10");
    const n = (JSON.parse(text) as { clientIp: ClientIpDiagnostics }).clientIp.netlify!;
    expect(n.contextIp).toEqual({ status: "present_unverified", matchesExpected: true });
    (globalThis as { Netlify?: unknown }).Netlify = {
      get context() {
        throw new Error("outside handler");
      },
    };
    const n2 = (JSON.parse((await call(ok())).text) as { clientIp: ClientIpDiagnostics }).clientIp.netlify!;
    expect(n2.contextIp.status).toBe("unavailable");
  });

  it("ログを出さない（成功・拒否のどちらでも）", async () => {
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((k) => vi.spyOn(console, k).mockImplementation(() => undefined));
    await call(ok({ "x-nf-client-connection-ip": "203.0.113.10" }));
    await call({ host: "evil.example", [HDR]: TOKEN });
    await call({ host: HOST });
    for (const s of spies) {
      expect(s).not.toHaveBeenCalled();
      s.mockRestore();
    }
  });
});

describe("既存の環境は従来どおり", () => {
  const CLOUD_RUN = {
    CLIENT_IP_DIAGNOSTICS: "on",
    CLIENT_IP_DIAGNOSTICS_TOKEN: TOKEN,
    K_SERVICE: "uranai-sandbox",
    VERCEL_ENV: "preview",
    VERCEL_GIT_COMMIT_REF: "preview/stripe-sandbox-v2",
    FIREBASE_PROJECT_ID: "uranai-stripe-sandbox-v2",
    PRODUCTION_FIREBASE_PROJECT_ID: "uranai-b6edf",
    STRIPE_SECRET_KEY: "sk_test_x-unit-dummy",
    APP_URL: "https://uranai-sandbox-123456789012.asia-northeast1.run.app",
  };

  it("Cloud Run：Netlify の設定が無くても従来どおり有効（Host の一致を求めない）。結果に Netlify の項目は無い", async () => {
    const { res, text } = await call({ host: "anything.example", [HDR]: TOKEN }, CLOUD_RUN);
    expect(res.status).toBe(200);
    expect(JSON.parse(text).clientIp).not.toHaveProperty("netlify");
  });

  it("Cloud Run 上では Netlify の分岐を使わない（Cloud Run の条件を満たさなければ、Netlify の設定がそろっていても 404）", async () => {
    expect((await call(ok(), { ...NETLIFY, K_SERVICE: "uranai-sandbox", CLIENT_IP_DIAGNOSTICS_TOKEN: "short-token" })).res.status).toBe(404);
    expect((await call(ok(), { ...NETLIFY, K_SERVICE: "uranai-sandbox", FIREBASE_PROJECT_ID: "uranai-b6edf" })).res.status).toBe(404);
    // Cloud Run の条件を満たすときは、従来どおり Cloud Run の分岐で有効（Host の一致は求めない）
    const { res } = await call({ host: "anything.example", [HDR]: TOKEN }, { ...NETLIFY, K_SERVICE: "uranai-sandbox" });
    expect(res.status).toBe(200);
  });

  it("Vercel 上では、Netlify の設定がそろっていても 404", async () => {
    expect((await call(ok(), { ...NETLIFY, VERCEL: "1" })).res.status).toBe(404);
  });

  it("どちらの設定も無ければ 404（従来どおり）", async () => {
    expect((await call(ok(), {})).res.status).toBe(404);
  });

  it("送信元 IP の判定（clientKey）とレート制限には影響しない（このモジュールは CLIENT_IP_SOURCE を読むだけ）", async () => {
    const { clientIpMode } = await import("@/lib/security/client-ip");
    for (const k of KEYS) delete process.env[k];
    Object.assign(process.env, NETLIFY);
    expect(clientIpMode()).toEqual({ kind: "default" }); // Netlify の診断の設定は、判定の方式を変えない
  });
});
