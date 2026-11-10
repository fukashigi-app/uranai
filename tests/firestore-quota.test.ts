/**
 * B-2：Firestore の無料枠（Spark）の消費の削減。
 *  - /api/health：認証なし（ログインのセッションの Cookie なし）では Firestore を読み書きしない
 *  - /api/checkout/status：注文の Cookie が無い・形式が正しくないときは Firestore を読み書きしない（従来と同じ応答）
 *  - レート制限：上限に達した後は書き込まずに拒否する。上限・時間枠・期限・同時アクセスの扱いは変えない
 * Firestore は模擬（読み取り・書き込みの回数を数える）。本番・Emulator には接続しない。
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

type Doc = Record<string, unknown>;
const fs = vi.hoisted(() => ({
  docs: new Map<string, { data: Doc; version: number }>(),
  reads: 0,
  writes: 0,
  retries: 0,
  /** 次のトランザクションのコミットの直前に、別の書き込みを割り込ませる（競合による再試行の確認用） */
  interleave: null as null | (() => void),
}));
const jar = vi.hoisted(() => new Map<string, string>());

vi.mock("next/headers", () => ({
  cookies: async () => ({ get: (k: string) => (jar.has(k) ? { name: k, value: jar.get(k)! } : undefined), set: () => undefined }),
  headers: async () => new Headers(),
}));

vi.mock("@/lib/firestore/admin", async (orig) => {
  const actual = await orig<typeof import("@/lib/firestore/admin")>();
  const docRef = (path: string) => ({
    path,
    id: path.split("/").pop(),
    get: async () => {
      fs.reads++;
      const d = fs.docs.get(path);
      return { exists: !!d, get: (k: string) => d?.data[k], data: () => d?.data };
    },
  });
  const query = (c: string) => {
    const q = {
      where: () => q,
      orderBy: () => q,
      limit: () => q,
      get: async () => {
        fs.reads++; // 結果が0件でも、問い合わせ1回は読み取り1回
        const docs = [...fs.docs.entries()].filter(([p]) => p.startsWith(`${c}/`)).map(([p, d]) => ({ id: p.split("/").pop(), data: () => d.data }));
        return { empty: docs.length === 0, docs, size: docs.length };
      },
    };
    return q;
  };
  const fake = {
    collection: (c: string) => ({ ...query(c), doc: (id: string) => docRef(`${c}/${id}`) }),
    /** 楽観的な同時実行制御：読んだドキュメントがコミットまでに変わっていたら、最初からやり直す（Firestore と同じ考え方） */
    runTransaction: async <T,>(fn: (tx: unknown) => Promise<T>): Promise<T> => {
      for (let attempt = 0; attempt < 10; attempt++) {
        const seen = new Map<string, number>();
        const pending: [string, Doc][] = [];
        const tx = {
          get: async (r: { path: string }) => {
            fs.reads++;
            await Promise.resolve(); // ほかのトランザクションが割り込める
            const d = fs.docs.get(r.path);
            seen.set(r.path, d?.version ?? 0);
            return { exists: !!d, get: (k: string) => d?.data[k] };
          },
          set: (r: { path: string }, data: Doc) => void pending.push([r.path, data]),
        };
        const out = await fn(tx);
        if (fs.interleave) {
          const f = fs.interleave;
          fs.interleave = null;
          f();
        }
        if ([...seen].some(([p, v]) => (fs.docs.get(p)?.version ?? 0) !== v)) {
          fs.retries++;
          continue;
        }
        for (const [p, data] of pending) {
          fs.writes++;
          fs.docs.set(p, { data, version: (fs.docs.get(p)?.version ?? 0) + 1 });
        }
        return out;
      }
      throw new Error("transaction aborted");
    },
  };
  return { ...actual, fsdb: () => fake };
});

beforeAll(() => {
  process.env.DB_PROVIDER = "firestore";
  process.env.SESSION_SECRET ||= "unit-test-session-secret-0123456789abcdef";
});
beforeEach(() => {
  fs.docs.clear();
  fs.reads = 0;
  fs.writes = 0;
  fs.retries = 0;
  fs.interleave = null;
  jar.clear();
});
afterEach(() => vi.useRealTimers());

const ops = () => fs.reads + fs.writes;

describe("GET /api/health（認証なし）", () => {
  it("ログインのセッションの Cookie が無い：Firestore の読み書きは0回。簡易の稼働確認だけを返し、環境の詳細は返さない", async () => {
    const { GET } = await import("@/app/api/health/route");
    const res = await GET();
    const body = (await res.json()) as Record<string, unknown>;
    expect(ops()).toBe(0);
    expect(Object.keys(body).sort()).toEqual(["detail", "ok"]);
    expect(body.detail).toMatch(/運営アカウントでログイン/);
    expect(res.headers.get("cache-control")).toBe("no-store");
    for (const k of ["database", "dataProvider", "SESSION_SECRET", "environment", "maintenance", "stripeConnection", "FIREBASE_PROJECT_ID"]) expect(body).not.toHaveProperty(k);
  });

  it("形式の正しくない（長すぎる）セッションの Cookie でも、Firestore を読まない", async () => {
    jar.set("sid", "x".repeat(101));
    jar.set("__Host-sid", "x".repeat(101));
    const { GET } = await import("@/app/api/health/route");
    await GET();
    expect(ops()).toBe(0);
  });
});

describe("GET /api/checkout/status（注文の Cookie の確認を先に）", () => {
  const req = () => new Request("http://localhost/api/checkout/status", { headers: { "x-real-ip": "203.0.113.9" } });

  it("注文の Cookie が無い・形式が正しくない：Firestore の読み書きは0回。応答は従来と同じ（200・期限切れ）", async () => {
    const { GET } = await import("@/app/api/checkout/status/route");
    for (const v of [null, "short", "bad token with spaces!!!!!!!", "x".repeat(101)]) {
      jar.clear();
      if (v !== null) jar.set("fx_access", v);
      const res = await GET(req());
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ status: "expired" });
    }
    expect(ops()).toBe(0);
  });

  it("形式の正しい Cookie：従来どおりレート制限を通ってから注文を探す（見つからなければ期限切れ）", async () => {
    jar.set("fx_access", "a".repeat(43));
    const { GET } = await import("@/app/api/checkout/status/route");
    const res = await GET(req());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "expired" });
    // レート制限（読み取り1・書き込み1）＋ 注文の問い合わせ（読み取り1）
    expect([fs.reads, fs.writes]).toEqual([2, 1]);
  });
});

describe("Firestore のレート制限（上限の後は書き込まない）", () => {
  it("上限までは許可して1回ずつ書き込み、超えたら書き込まずに拒否する（境界：上限ちょうどは許可、上限+1から拒否）", async () => {
    const { rateLimit } = await import("@/lib/firestore/misc");
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-10T03:00:10Z"));
    const results: boolean[] = [];
    for (let i = 0; i < 5; i++) results.push(await rateLimit("login:OPERATOR:abc", 3, 60));
    expect(results).toEqual([true, true, true, false, false]);
    expect(fs.writes).toBe(3); // 超えた2回は書き込まない
    expect(fs.reads).toBe(5);
    const [doc] = [...fs.docs.values()];
    expect(doc.data.count).toBe(3); // 回数は上限のまま
    expect(doc.data.windowStart).toEqual(new Date("2026-11-10T03:00:00Z"));
    expect(doc.data.expireAt).toEqual(new Date(Date.parse("2026-11-10T03:01:00Z") + 86_400_000));
  });

  it("時間枠が変われば、従来どおり新しい枠で数え直す（前の枠の記録・期限は変えない）", async () => {
    const { rateLimit } = await import("@/lib/firestore/misc");
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-10T03:00:59Z"));
    for (let i = 0; i < 4; i++) await rateLimit("checkout:k", 2, 60);
    const before = [...fs.docs.entries()].map(([p, d]) => [p, d.data.count, d.data.expireAt]);
    vi.setSystemTime(new Date("2026-11-10T03:01:00Z"));
    expect(await rateLimit("checkout:k", 2, 60)).toBe(true);
    expect(fs.docs.size).toBe(2);
    expect([...fs.docs.entries()].filter(([p]) => before.some(([bp]) => bp === p)).map(([p, d]) => [p, d.data.count, d.data.expireAt])).toEqual(before);
  });

  it("キーごとに独立して数える（別の利用者・別の API の上限に影響しない）", async () => {
    const { rateLimit } = await import("@/lib/firestore/misc");
    for (let i = 0; i < 3; i++) await rateLimit("fortune:a", 2, 60);
    expect(await rateLimit("fortune:b", 2, 60)).toBe(true);
    expect(await rateLimit("checkout:a", 2, 60)).toBe(true);
  });

  it("同時アクセス：上限の数だけ許可し、書き込みも上限の回数だけ（競合した分は再試行で正しく数える）", async () => {
    const { rateLimit } = await import("@/lib/firestore/misc");
    const results = await Promise.all(Array.from({ length: 12 }, () => rateLimit("stripe-session:k", 5, 60)));
    expect(results.filter(Boolean)).toHaveLength(5);
    expect(fs.writes).toBe(5);
    expect([...fs.docs.values()][0].data.count).toBe(5);
    expect(fs.retries).toBeGreaterThan(0); // 模擬でも競合と再試行が起きている
  });

  it("上限に達した直後に別の処理が割り込んでも、読み取りだけのトランザクションは何も書かずに拒否する", async () => {
    const { rateLimit } = await import("@/lib/firestore/misc");
    for (let i = 0; i < 2; i++) await rateLimit("status:k", 2, 60);
    const writes = fs.writes;
    fs.interleave = () => {
      const [p, d] = [...fs.docs.entries()][0];
      fs.docs.set(p, { data: { ...d.data }, version: d.version + 1 });
    };
    expect(await rateLimit("status:k", 2, 60)).toBe(false);
    expect(fs.writes).toBe(writes);
  });
});
