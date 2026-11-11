/**
 * ログアウト（destroySession）のときの、ログインの Cookie の削除（lib/auth/session.ts）。
 *  - https（APP_URL）：__Host-sid を、設定時と同じ Path=/・Secure 付きで削除する（__Host- は Secure の無い削除をブラウザが受け付けない）
 *  - http（ローカル）：sid を従来どおり削除する（Secure なし）
 *  - サーバー側のログイン状態の削除は従来どおり
 * cookies() は Next.js の ResponseCookies（実物）で組み立て、実際に出る Set-Cookie を確かめる。データベースは模擬。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ResponseCookies } from "next/dist/compiled/@edge-runtime/cookies";

const st = vi.hoisted(() => ({
  headers: new Headers(),
  request: new Map<string, string>(),
  deleted: [] as string[],
  saved: [] as string[],
}));

vi.mock("next/headers", () => ({
  cookies: async () => {
    const rc = new ResponseCookies(st.headers);
    return {
      get: (name: string) => (st.request.has(name) ? { name, value: st.request.get(name)! } : undefined),
      set: (...args: Parameters<ResponseCookies["set"]>) => rc.set(...args),
      delete: (...args: Parameters<ResponseCookies["delete"]>) => rc.delete(...args),
    };
  },
}));
vi.mock("@/lib/data-provider", () => ({ isFirestore: () => true, hasDatabase: () => true, dataProvider: () => "firestore" }));
vi.mock("@/lib/firestore/users", () => ({
  deleteSession: async (hash: string) => {
    st.deleted.push(hash);
  },
}));
vi.mock("@/lib/auth/session-store", () => ({
  findSessionUser: async () => null,
  revokeUserSessions: async () => undefined,
  saveSessionRecord: async (hash: string) => {
    st.saved.push(hash);
  },
}));

const KEYS = ["APP_URL", "SESSION_SECRET", "VERCEL_ENV", "VERCEL_PROJECT_PRODUCTION_URL", "VERCEL_URL", "VERCEL_BRANCH_URL"] as const;
const saved: Record<string, string | undefined> = {};
const TOKEN = "unit-test-session-token-0123456789abcdefABCDEF";

beforeEach(() => {
  for (const k of KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  process.env.SESSION_SECRET = "unit-test-session-secret-0123456789abcdef";
  st.headers = new Headers();
  st.request.clear();
  st.deleted.length = 0;
  st.saved.length = 0;
  vi.resetModules(); // env() の値を毎回読み直す
});
afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

async function load(appUrl: string) {
  process.env.APP_URL = appUrl;
  return import("@/lib/auth/session");
}
const setCookies = () => st.headers.getSetCookie();
const attrs = (c: string) => c.split(";").map((p) => p.trim());

describe("https（APP_URL が https）", () => {
  it("1〜3. __Host-sid を、Path=/・Secure 付きで削除する（期限切れの日付で上書き）", async () => {
    const { destroySession, sessionCookieName } = await load("https://uranai.example.jp");
    expect(sessionCookieName()).toBe("__Host-sid");
    st.request.set("__Host-sid", TOKEN);
    await destroySession();
    const out = setCookies();
    expect(out).toHaveLength(1);
    const a = attrs(out[0]);
    expect(a[0]).toBe("__Host-sid=");
    expect(a).toContain("Path=/");
    expect(a).toContain("Secure");
    expect(a).toContain("Expires=Thu, 01 Jan 1970 00:00:00 GMT");
    expect(a.some((p) => /^Domain=/i.test(p))).toBe(false); // __Host- は Domain を付けられない
  });

  it("削除の Path・Secure は、ログイン時に設定した Cookie と一致する", async () => {
    const { createSession, destroySession } = await load("https://uranai.example.jp");
    await createSession("u1", "OPERATOR");
    const set = attrs(setCookies()[0]);
    st.headers = new Headers();
    st.request.set("__Host-sid", TOKEN);
    await destroySession();
    const del = attrs(setCookies()[0]);
    expect(set[0].startsWith("__Host-sid=")).toBe(true);
    for (const p of ["Path=/", "Secure"]) {
      expect(set, `set ${p}`).toContain(p);
      expect(del, `delete ${p}`).toContain(p);
    }
  });
});

describe("http（ローカル。APP_URL が http）", () => {
  it("4〜5. sid を Secure なしで削除する（従来どおり。Path=/）", async () => {
    const { destroySession, sessionCookieName } = await load("http://localhost:3000");
    expect(sessionCookieName()).toBe("sid");
    st.request.set("sid", TOKEN);
    await destroySession();
    const out = setCookies();
    expect(out).toHaveLength(1);
    const a = attrs(out[0]);
    expect(a[0]).toBe("sid=");
    expect(a).toContain("Path=/");
    expect(a).not.toContain("Secure");
    expect(a).toContain("Expires=Thu, 01 Jan 1970 00:00:00 GMT");
  });
});

describe("6. サーバー側のログイン状態の削除は従来どおり", () => {
  it("Cookie のトークンのハッシュで、サーバー側の記録を削除する（https・http とも）", async () => {
    const { sha256Hex } = await import("@/lib/security/crypto");
    for (const [url, name] of [
      ["https://uranai.example.jp", "__Host-sid"],
      ["http://localhost:3000", "sid"],
    ] as const) {
      vi.resetModules();
      st.deleted.length = 0;
      st.request.clear();
      st.request.set(name, TOKEN);
      const { destroySession } = await load(url);
      await destroySession();
      expect(st.deleted, url).toEqual([sha256Hex(TOKEN)]);
    }
  });

  it("Cookie が無いときは、サーバー側の削除をせず、Cookie の削除だけを送る（従来どおり）", async () => {
    const { destroySession } = await load("https://uranai.example.jp");
    await destroySession();
    expect(st.deleted).toEqual([]);
    expect(attrs(setCookies()[0])).toContain("Secure");
  });
});
