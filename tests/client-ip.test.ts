/**
 * 送信元 IP の判定（lib/security/request.ts の clientKey・lib/security/client-ip.ts）。
 *  - CLIENT_IP_SOURCE 未設定：従来（Vercel 向け）と完全に同じキー
 *  - CLIENT_IP_SOURCE=x-forwarded-for-from-right（Cloud Run 用）：X-Real-IP と X-Forwarded-For の左側（利用者が書ける部分）を使わない
 *  - 設定の誤りは例外（レート制限を素通りさせない）。ヘッダーの異常は1つのキーにまとめる（キーを無制限に作れない）
 *  - 保護対象の API（共通ガード・ログイン・無料の占い）への影響
 * レート制限・データベースは模擬（本番・Emulator には接続しない）。IP は文書用のアドレス。
 */
import { createHash } from "node:crypto";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const rl = vi.hoisted(() => ({ counts: new Map<string, number>(), calls: [] as string[] }));
const hdr = vi.hoisted(() => ({ current: new Headers() }));

vi.mock("@/lib/security/rate-limit", () => ({
  rateLimit: async (key: string, limit: number) => {
    rl.calls.push(key);
    const n = (rl.counts.get(key) ?? 0) + 1;
    rl.counts.set(key, n);
    return n <= limit;
  },
}));
vi.mock("next/headers", () => ({
  headers: async () => hdr.current,
  cookies: async () => ({ get: () => undefined, set: () => undefined }),
}));
vi.mock("@/lib/auth/login", () => ({ authenticate: async () => ({ ok: false, reason: "invalid" }) }));
vi.mock("@/lib/auth/session", () => ({ createSession: async () => undefined }));
vi.mock("@/lib/data-provider", async (orig) => ({ ...(await orig<typeof import("@/lib/data-provider")>()), hasDatabase: () => true }));

const SECRET = "unit-test-session-secret-0123456789abcdef";
const ENV_KEYS = ["CLIENT_IP_SOURCE", "CLIENT_IP_XFF_POSITION_FROM_RIGHT", "SESSION_SECRET", "APP_URL"] as const;
const saved: Record<string, string | undefined> = {};

beforeAll(() => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
});
beforeEach(() => {
  for (const k of ENV_KEYS) delete process.env[k];
  process.env.SESSION_SECRET = SECRET;
  rl.counts.clear();
  rl.calls.length = 0;
  hdr.current = new Headers();
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

const cloudRun = (position = "2") => {
  process.env.CLIENT_IP_SOURCE = "x-forwarded-for-from-right";
  process.env.CLIENT_IP_XFF_POSITION_FROM_RIGHT = position;
};
const H = (h: Record<string, string>) => new Headers(h);

/** 変更前の clientKey（比較用にそのまま写したもの） */
function legacyClientKey(headers: Headers): string {
  const ip = headers.get("x-real-ip") ?? headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
  return createHash("sha256").update(`${SECRET}:${ip}`).digest("hex").slice(0, 32);
}

describe("未設定（Vercel）：従来の動作をそのまま維持する", () => {
  it("どのヘッダーの組み合わせでも、変更前と同じキー", async () => {
    const { clientKey } = await import("@/lib/security/request");
    const cases: Record<string, string>[] = [
      {},
      { "x-real-ip": "203.0.113.5" },
      { "x-forwarded-for": "203.0.113.6" },
      { "x-forwarded-for": " 203.0.113.7 , 198.51.100.1" },
      { "x-real-ip": "203.0.113.8", "x-forwarded-for": "198.51.100.2" },
      { "x-forwarded-for": "" },
      { "x-real-ip": "not-an-ip" },
    ];
    for (const c of cases) expect(clientKey(H(c)), JSON.stringify(c)).toBe(legacyClientKey(H(c)));
  });

  it("空の CLIENT_IP_SOURCE も未設定と同じ（位置の設定は見ない）", async () => {
    const { clientKey } = await import("@/lib/security/request");
    process.env.CLIENT_IP_SOURCE = "  ";
    process.env.CLIENT_IP_XFF_POSITION_FROM_RIGHT = "abc";
    expect(clientKey(H({ "x-real-ip": "203.0.113.5" }))).toBe(legacyClientKey(H({ "x-real-ip": "203.0.113.5" })));
  });
});

describe("設定の値", () => {
  it("正常な設定：位置 1〜5", async () => {
    const { clientIpMode } = await import("@/lib/security/client-ip");
    for (const p of ["1", "2", "3", "4", "5", " 2 "]) {
      expect(clientIpMode({ CLIENT_IP_SOURCE: "x-forwarded-for-from-right", CLIENT_IP_XFF_POSITION_FROM_RIGHT: p })).toEqual({ kind: "xff-from-right", position: Number(p.trim()) });
    }
  });

  it("不正な設定は例外（従来の方式に黙って戻さない）。メッセージに設定値を含めない", async () => {
    const { clientIpMode, ClientIpConfigError } = await import("@/lib/security/client-ip");
    const bad: Record<string, string | undefined>[] = [
      { CLIENT_IP_SOURCE: "cloud-run", CLIENT_IP_XFF_POSITION_FROM_RIGHT: "2" },
      { CLIENT_IP_SOURCE: "X-Forwarded-For-From-Right", CLIENT_IP_XFF_POSITION_FROM_RIGHT: "2" },
      { CLIENT_IP_SOURCE: "x-forwarded-for-from-right" },
      ...["", "0", "6", "9", "10", "-1", "1.5", "2a", "0x2", "１"].map((p) => ({ CLIENT_IP_SOURCE: "x-forwarded-for-from-right", CLIENT_IP_XFF_POSITION_FROM_RIGHT: p })),
    ];
    for (const e of bad) {
      let err: unknown;
      try {
        clientIpMode(e);
      } catch (x) {
        err = x;
      }
      expect(err, JSON.stringify(e)).toBeInstanceOf(ClientIpConfigError);
      expect((err as Error).message).not.toMatch(/cloud-run|X-Forwarded-For-From-Right|\b(0|6|9|10)\b/);
    }
  });
});

describe("Cloud Run 用（右から2番目を信頼する設定の例）", () => {
  it("正常：右から2番目の IP で数える", async () => {
    const { resolveFromForwardedFor } = await import("@/lib/security/client-ip");
    expect(resolveFromForwardedFor(H({ "x-forwarded-for": "203.0.113.10, 198.51.100.200" }), 2)).toEqual({ status: "resolved", ip: "203.0.113.10" });
    expect(resolveFromForwardedFor(H({ "x-forwarded-for": "203.0.113.10" }), 1)).toEqual({ status: "resolved", ip: "203.0.113.10" });
    expect(resolveFromForwardedFor(H({ "x-forwarded-for": "2001:DB8::1, 198.51.100.200" }), 2)).toEqual({ status: "resolved", ip: "2001:db8::1" });
  });

  it("偽装した X-Real-IP は使わない", async () => {
    cloudRun();
    const { clientKey } = await import("@/lib/security/request");
    const base = clientKey(H({ "x-forwarded-for": "203.0.113.10, 198.51.100.200" }));
    for (const fake of ["192.0.2.1", "192.0.2.2", "garbage"]) {
      expect(clientKey(H({ "x-real-ip": fake, "x-forwarded-for": "203.0.113.10, 198.51.100.200" }))).toBe(base);
    }
  });

  it("偽装した X-Forwarded-For の先頭値（利用者が付けた部分）は使わない", async () => {
    cloudRun();
    const { clientKey } = await import("@/lib/security/request");
    const base = clientKey(H({ "x-forwarded-for": "203.0.113.10, 198.51.100.200" }));
    for (const spoof of ["192.0.2.1", "192.0.2.1, 192.0.2.2", "garbage", ", ,", "2001:db8::9"]) {
      expect(clientKey(H({ "x-forwarded-for": `${spoof}, 203.0.113.10, 198.51.100.200` })), spoof).toBe(base);
    }
  });

  it("ヘッダーの欠落・形式の異常は、すべて同じ1つのキー（判定できない利用者の共用の枠）", async () => {
    cloudRun();
    const { clientKey } = await import("@/lib/security/request");
    const { resolveFromForwardedFor } = await import("@/lib/security/client-ip");
    const anomalies: [Record<string, string>, string][] = [
      [{}, "xff_missing"],
      [{ "x-real-ip": "203.0.113.10" }, "xff_missing"],
      [{ "x-forwarded-for": "" }, "xff_missing"],
      [{ "x-forwarded-for": "   " }, "xff_missing"],
      [{ "x-forwarded-for": "198.51.100.200" }, "xff_too_few_entries"],
      [{ "x-forwarded-for": "garbage, 198.51.100.200" }, "xff_not_an_ip"],
      [{ "x-forwarded-for": "203.0.113.10:4431, 198.51.100.200" }, "xff_not_an_ip"],
      [{ "x-forwarded-for": "[2001:db8::1], 198.51.100.200" }, "xff_not_an_ip"],
      [{ "x-forwarded-for": " , 198.51.100.200" }, "xff_not_an_ip"],
      [{ "x-forwarded-for": `${"192.0.2.1,".repeat(40)}203.0.113.10, 198.51.100.200` }, "xff_too_many_entries"],
    ];
    const keys = new Set<string>();
    for (const [h, reason] of anomalies) {
      expect(resolveFromForwardedFor(H(h), 2), JSON.stringify(h).slice(0, 60)).toEqual({ status: "unresolved", reason });
      keys.add(clientKey(H(h)));
    }
    expect(keys.size).toBe(1);
    expect(keys.has(clientKey(H({ "x-forwarded-for": "203.0.113.10, 198.51.100.200" })))).toBe(false);
  });

  it("不正なヘッダーを大量に変えても、新しいキーは増えない（1つだけ）", async () => {
    cloudRun();
    const { clientKey } = await import("@/lib/security/request");
    const keys = new Set<string>();
    for (let i = 0; i < 500; i++) {
      const junk = `${"x".repeat(i % 50)}${i}`;
      keys.add(clientKey(H({ "x-real-ip": junk, "x-forwarded-for": `${junk}, not-ip-${i}` })));
      keys.add(clientKey(H({ "x-forwarded-for": `${junk}` })));
    }
    expect(keys.size).toBe(1);
  });

  it("同じ利用者が X-Real-IP・X-Forwarded-For の左側を毎回変えても、レート制限を回避できない", async () => {
    cloudRun();
    const { guardPost } = await import("@/lib/api");
    const results: number[] = [];
    for (let i = 0; i < 25; i++) {
      const req = new Request("http://localhost:3000/api/checkout", {
        method: "POST",
        headers: { origin: "http://localhost:3000", "x-real-ip": `192.0.2.${i}`, "x-forwarded-for": `192.0.2.${i}, 198.51.100.${i}, 203.0.113.10, 198.51.100.200` },
      });
      results.push((await guardPost(req, "checkout", 20, 60))?.status ?? 200);
    }
    expect(results.filter((s) => s === 200)).toHaveLength(20);
    expect(results.slice(20)).toEqual([429, 429, 429, 429, 429]);
    expect(new Set(rl.calls).size).toBe(1);
  });

  it("判定できない利用者は共用の枠に入るだけで、判定できる利用者の上限には影響しない", async () => {
    cloudRun();
    const { guardPost } = await import("@/lib/api");
    const post = (xff?: string) =>
      guardPost(new Request("http://localhost:3000/api/checkout", { method: "POST", headers: { origin: "http://localhost:3000", ...(xff ? { "x-forwarded-for": xff } : {}) } }), "checkout", 3, 60);
    for (let i = 0; i < 3; i++) expect(await post()).toBeNull();
    expect((await post("garbage, 198.51.100.200"))?.status).toBe(429); // 異常なヘッダーも同じ共用の枠
    expect(await post("203.0.113.10, 198.51.100.200")).toBeNull(); // 正常な利用者は別の枠
  });
});

describe("設定の誤りのとき、保護対象の API は処理を進めない（レート制限を素通りさせない）", () => {
  beforeEach(() => {
    process.env.CLIENT_IP_SOURCE = "x-forwarded-for-from-right";
    process.env.CLIENT_IP_XFF_POSITION_FROM_RIGHT = "0";
  });

  it("注文・決済の共通ガード（guardPost）：例外で止まり、許可を返さない", async () => {
    const { guardPost } = await import("@/lib/api");
    const req = new Request("http://localhost:3000/api/checkout/stripe-session", { method: "POST", headers: { origin: "http://localhost:3000", "x-forwarded-for": "203.0.113.10, 198.51.100.200" } });
    await expect(guardPost(req, "stripe-session", 10, 60)).rejects.toMatchObject({ code: "client_ip_config_invalid" });
    expect(rl.calls).toHaveLength(0);
  });

  it("ログイン：例外で止まり、認証の処理に進まない", async () => {
    hdr.current = H({ "x-forwarded-for": "203.0.113.10, 198.51.100.200" });
    const { performLogin } = await import("@/lib/auth/login-action");
    const fd = new FormData();
    fd.set("email", "operator@example.com");
    fd.set("password", "password-1234");
    await expect(performLogin(fd, "OPERATOR")).rejects.toMatchObject({ code: "client_ip_config_invalid" });
    expect(rl.calls).toHaveLength(0);
  });

  it("無料の占い（limitFreeFortune）：503 で止まる（従来の障害時と同じ応答）", async () => {
    const { limitFreeFortune } = await import("@/lib/services/test-store");
    const res = await limitFreeFortune(new Request("http://localhost:3000/api/fortune", { method: "POST" }), "fortune-test", 20, 60);
    expect(res?.status).toBe(503);
    expect(rl.calls).toHaveLength(0);
  });
});
