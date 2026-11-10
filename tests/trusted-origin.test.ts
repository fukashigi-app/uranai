/**
 * 自サイトのオリジンの基準（TRUSTED_ORIGIN_SOURCE。lib/security/trusted-origin.ts）。
 *  - 未設定（Vercel）：isSameOrigin・isSameHostRequest・共有URLは変更前と同じ結果
 *  - app-url（Cloud Run 用）：APP_URL のオリジンだけを自サイトとし、Host・X-Forwarded-Host・X-Forwarded-Proto を信頼しない
 *  - 設定・APP_URL の誤りは例外（黙って従来の方式に戻さない）。保護対象の API は処理を進めない
 * レート制限・データベースは模擬。外部には接続しない。
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const rl = vi.hoisted(() => ({ calls: [] as string[] }));
vi.mock("@/lib/security/rate-limit", () => ({
  rateLimit: async (key: string) => {
    rl.calls.push(key);
    return true;
  },
}));

const APP = "https://uranai-sandbox-123456789012.asia-northeast1.run.app";
const APP_HOST = new URL(APP).host;
const KEYS = ["TRUSTED_ORIGIN_SOURCE", "APP_URL", "SESSION_SECRET", "VERCEL_ENV", "VERCEL_PROJECT_PRODUCTION_URL", "VERCEL_URL", "VERCEL_BRANCH_URL"] as const;
const saved: Record<string, string | undefined> = {};

beforeAll(() => {
  for (const k of KEYS) saved[k] = process.env[k];
});
beforeEach(() => {
  for (const k of KEYS) delete process.env[k];
  process.env.SESSION_SECRET = "unit-test-session-secret-0123456789abcdef";
  rl.calls.length = 0;
});
afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

const appUrlMode = (url: string = APP) => {
  process.env.TRUSTED_ORIGIN_SOURCE = "app-url";
  process.env.APP_URL = url;
};
const post = (headers: Record<string, string>, url = `${APP}/api/checkout`) => new Request(url, { method: "POST", headers });

describe("設定の値（trustedOriginMode）", () => {
  it("未設定・空は従来の方式", async () => {
    const { trustedOriginMode } = await import("@/lib/security/trusted-origin");
    expect(trustedOriginMode({})).toEqual({ kind: "default" });
    expect(trustedOriginMode({ TRUSTED_ORIGIN_SOURCE: "  ", APP_URL: "not a url" })).toEqual({ kind: "default" });
  });

  it("app-url：https の絶対 URL（末尾の / は可）", async () => {
    const { trustedOriginMode } = await import("@/lib/security/trusted-origin");
    for (const u of [APP, `${APP}/`, ` ${APP} `]) {
      expect(trustedOriginMode({ TRUSTED_ORIGIN_SOURCE: "app-url", APP_URL: u })).toEqual({ kind: "app-url", origin: APP, host: APP_HOST });
    }
    expect(trustedOriginMode({ TRUSTED_ORIGIN_SOURCE: "app-url", APP_URL: "https://uranai.example.jp:8443" })).toEqual({ kind: "app-url", origin: "https://uranai.example.jp:8443", host: "uranai.example.jp:8443" });
  });

  it("想定外の値・APP_URL の未設定・不正・https 以外は例外（メッセージに値を含めない）", async () => {
    const { trustedOriginMode, TrustedOriginConfigError } = await import("@/lib/security/trusted-origin");
    const bad: Record<string, string | undefined>[] = [
      { TRUSTED_ORIGIN_SOURCE: "APP-URL", APP_URL: APP },
      { TRUSTED_ORIGIN_SOURCE: "appurl", APP_URL: APP },
      { TRUSTED_ORIGIN_SOURCE: "true", APP_URL: APP },
      ...[
        undefined,
        "",
        "   ",
        "http://uranai-sandbox.example.run.app",
        "ftp://uranai.example.jp",
        "uranai.example.jp",
        "/relative",
        "https://",
        "https://user:pass@uranai.example.jp",
        "https://uranai.example.jp/app",
        "https://uranai.example.jp/?x=1",
        "https://uranai.example.jp/#x",
        "https://uranai.example.jp?",
        "https://uranai .example.jp",
        "javascript:alert(1)",
      ].map((u) => ({ TRUSTED_ORIGIN_SOURCE: "app-url", APP_URL: u })),
    ];
    for (const e of bad) {
      let err: unknown;
      try {
        trustedOriginMode(e);
      } catch (x) {
        err = x;
      }
      expect(err, JSON.stringify(e)).toBeInstanceOf(TrustedOriginConfigError);
      expect((err as Error).message).not.toMatch(/uranai|APP-URL|appurl|pass/);
    }
  });

  it("アプリが実際に使う公開 URL（QR・Stripe の戻り先）と食い違う設定は例外", async () => {
    const { trustedOriginMode } = await import("@/lib/security/trusted-origin");
    // Preview では、本番のドメインを指す APP_URL をアプリが使わない（env.ts の appUrlFromEnv）→ 基準が食い違うので停止
    expect(() => trustedOriginMode({ TRUSTED_ORIGIN_SOURCE: "app-url", APP_URL: "https://uranai.example.jp", VERCEL_ENV: "preview", VERCEL_PROJECT_PRODUCTION_URL: "uranai.example.jp", VERCEL_BRANCH_URL: "uranai-git-x.vercel.app" })).toThrow(
      /Trusted origin is misconfigured/,
    );
  });
});

describe("未設定（Vercel）：変更前と同じ結果", () => {
  /** 変更前の isSameOrigin・isSameHostRequest・共有URL（比較用にそのまま写したもの） */
  const legacySameOrigin = (req: Request, appUrl: string) => {
    const allowed = new Set<string>([new URL(appUrl).origin]);
    const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host");
    const proto = req.headers.get("x-forwarded-proto") ?? new URL(req.url).protocol.replace(":", "");
    if (host) allowed.add(`${proto.split(",")[0].trim()}://${host.split(",")[0].trim()}`);
    const origin = req.headers.get("origin");
    if (origin) return allowed.has(origin);
    const referer = req.headers.get("referer");
    if (referer) {
      try {
        return allowed.has(new URL(referer).origin);
      } catch {
        return false;
      }
    }
    return false;
  };
  const legacySameHost = (req: Request) => {
    const host = (req.headers.get("x-forwarded-host") ?? req.headers.get("host") ?? "").split(",")[0].trim();
    const src = req.headers.get("origin") ?? req.headers.get("referer");
    if (!host || !src) return false;
    try {
      return new URL(src).host === host;
    } catch {
      return false;
    }
  };
  const legacyShare = (h: Headers) => {
    const host = (h.get("x-forwarded-host") ?? h.get("host") ?? "localhost:3000").split(",")[0].trim();
    const proto = (h.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https")).split(",")[0].trim();
    return `${proto}://${host}`;
  };
  const CASES: Record<string, string>[] = [
    {},
    { origin: "http://localhost:3000" },
    { origin: "https://evil.example" },
    { origin: "https://evil.example", "x-forwarded-host": "evil.example", "x-forwarded-proto": "https" },
    { origin: "https://uranai.vercel.app", host: "uranai.vercel.app", "x-forwarded-proto": "https" },
    { referer: "https://uranai.vercel.app/payment", "x-forwarded-host": "uranai.vercel.app", "x-forwarded-proto": "https" },
    { referer: "not a url", host: "uranai.vercel.app" },
    { origin: "null", host: "uranai.vercel.app" },
    { host: "uranai.vercel.app" },
    { "x-forwarded-host": "a.example, b.example", "x-forwarded-proto": "https, http", origin: "https://a.example" },
  ];

  it("isSameOrigin・isSameHostRequest・共有URL", async () => {
    const { isSameOrigin } = await import("@/lib/security/request");
    const { isSameHostRequest } = await import("@/lib/services/test-store");
    const { shareSiteOrigin } = await import("@/lib/security/trusted-origin");
    const { env } = await import("@/lib/env");
    for (const c of CASES) {
      const req = post(c, "http://localhost:3000/api/checkout");
      expect(isSameOrigin(req), JSON.stringify(c)).toBe(legacySameOrigin(req, env().APP_URL));
      expect(isSameHostRequest(req), JSON.stringify(c)).toBe(legacySameHost(req));
      expect(shareSiteOrigin(new Headers(c)), JSON.stringify(c)).toBe(legacyShare(new Headers(c)));
    }
  });
});

describe("app-url（Cloud Run 用）：APP_URL のオリジンだけを自サイトとする", () => {
  const ATTACKS: [string, Record<string, string>][] = [
    ["偽装した X-Forwarded-Host（Origin も同じ偽のホスト）", { origin: "https://evil.example", "x-forwarded-host": "evil.example", "x-forwarded-proto": "https" }],
    ["偽装した Host（Origin も同じ偽のホスト）", { origin: "https://evil.example", host: "evil.example" }],
    ["偽装した Origin（自サイトに似せた別のホスト）", { origin: `https://${APP_HOST}.evil.example`, host: APP_HOST }],
    ["http の Origin", { origin: APP.replace("https://", "http://"), host: APP_HOST, "x-forwarded-proto": "http" }],
    ["別のポートの Origin", { origin: `${APP}:8443`, host: APP_HOST }],
    ["サブドメインの Origin", { origin: `https://x.${APP_HOST}`, host: APP_HOST }],
    ["Origin: null（サンドボックス化した iframe など）", { origin: "null", host: APP_HOST }],
    ["Origin も Referer も無い", { host: APP_HOST, "x-forwarded-host": APP_HOST }],
    ["Origin が無く、Referer が別のサイト", { referer: "https://evil.example/page", host: APP_HOST }],
    ["Origin が無く、Referer が解析できない", { referer: "not a url", host: APP_HOST }],
    ["Origin が別のサイトで、Referer だけ自サイト（Origin を優先）", { origin: "https://evil.example", referer: `${APP}/payment`, host: APP_HOST }],
    ["Cookie 付きの別のサイトからの POST", { origin: "https://evil.example", cookie: "__Host-sid=SESSIONVALUE; fx_access=ACCESSVALUE", host: APP_HOST }],
    ["X-Forwarded-Host に自サイトとカンマ区切りの偽のホスト", { origin: "https://evil.example", "x-forwarded-host": `evil.example, ${APP_HOST}` }],
  ];
  const ALLOWED: [string, Record<string, string>][] = [
    ["Origin が APP_URL", { origin: APP }],
    ["Origin が APP_URL（Host・X-Forwarded-Host が偽でも、基準は APP_URL）", { origin: APP, host: "evil.example", "x-forwarded-host": "evil.example", "x-forwarded-proto": "http" }],
    ["Origin が無く、Referer が自サイト", { referer: `${APP}/payment?x=1` }],
  ];

  it("攻撃のパターンはすべて拒否（isSameOrigin・isSameHostRequest）", async () => {
    appUrlMode();
    const { isSameOrigin } = await import("@/lib/security/request");
    const { isSameHostRequest } = await import("@/lib/services/test-store");
    for (const [name, h] of ATTACKS) {
      expect(isSameOrigin(post(h)), name).toBe(false);
      expect(isSameHostRequest(post(h)), name).toBe(false);
    }
  });

  it("正当なリクエストは許可", async () => {
    appUrlMode();
    const { isSameOrigin } = await import("@/lib/security/request");
    const { isSameHostRequest } = await import("@/lib/services/test-store");
    for (const [name, h] of ALLOWED) {
      expect(isSameOrigin(post(h)), name).toBe(true);
      expect(isSameHostRequest(post(h)), name).toBe(true);
    }
  });

  it("注文・決済の共通ガード：偽装した X-Forwarded-Host では 403（レート制限にも進まない）。自サイトは通る", async () => {
    appUrlMode();
    const { guardPost } = await import("@/lib/api");
    expect((await guardPost(post({ origin: "https://evil.example", "x-forwarded-host": "evil.example", "x-forwarded-proto": "https" }), "checkout", 20, 60))?.status).toBe(403);
    expect((await guardPost(post({ host: APP_HOST }), "checkout", 20, 60))?.status).toBe(403); // Origin 欠落
    expect(rl.calls).toHaveLength(0);
    expect(await guardPost(post({ origin: APP }), "checkout", 20, 60)).toBeNull();
  });

  it("共有URL：APP_URL だけを使い、不正なホスト名を混ぜない", async () => {
    appUrlMode(`${APP}/`);
    const { shareSiteOrigin } = await import("@/lib/security/trusted-origin");
    const injected: Record<string, string>[] = [
      { "x-forwarded-host": "evil.example" },
      { host: "evil.example", "x-forwarded-proto": "http" },
      { "x-forwarded-host": "evil.example/phish?x=", "x-forwarded-proto": "javascript" },
      { "x-forwarded-host": '"><script>alert(1)</script>' },
      {},
    ];
    for (const h of injected) {
      expect(shareSiteOrigin(new Headers(h))).toBe(APP);
    }
  });
});

describe("設定の誤り（app-url で APP_URL が不正）：安全側に停止", () => {
  it("isSameOrigin・isSameHostRequest・共有URLは例外。注文・決済の共通ガードは処理を進めない", async () => {
    appUrlMode("http://uranai-sandbox.example");
    const { isSameOrigin } = await import("@/lib/security/request");
    const { isSameHostRequest } = await import("@/lib/services/test-store");
    const { shareSiteOrigin } = await import("@/lib/security/trusted-origin");
    const { guardPost } = await import("@/lib/api");
    const req = post({ origin: "http://uranai-sandbox.example" });
    expect(() => isSameOrigin(req)).toThrow(/Trusted origin is misconfigured/);
    expect(() => isSameHostRequest(req)).toThrow(/Trusted origin is misconfigured/);
    expect(() => shareSiteOrigin(new Headers())).toThrow(/Trusted origin is misconfigured/);
    await expect(guardPost(req, "checkout", 20, 60)).rejects.toMatchObject({ code: "trusted_origin_config_invalid" });
    expect(rl.calls).toHaveLength(0);
  });
});

describe("ブラウザ以外から呼ばれる正当な API は、オリジンの確認の対象外のまま", () => {
  it("Stripe の Webhook・疑似決済の Webhook・定期処理は、オリジンの確認を使わない（署名・トークンで認証）", () => {
    for (const f of ["src/app/api/webhooks/stripe/route.ts", "src/app/api/webhooks/mock/route.ts", "src/app/api/cron/maintenance/route.ts"]) {
      const src = readFileSync(path.resolve(__dirname, "..", f), "utf8");
      expect(src, f).not.toMatch(/isSameOrigin|isSameHostRequest|guardPost|trustedOriginMode|requestSourceOrigin/);
    }
  });
});
