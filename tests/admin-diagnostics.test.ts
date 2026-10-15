import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * 一時的な診断API（/api/admin/diagnostics/aggregation）の安全性チェック。
 * - 運営ログイン時だけ実行（未ログイン・店舗アカウントは 404）
 * - Firestore の読み取りだけ（作成・更新・削除のメソッドを呼ばない）
 * - 返すのは処理名・成功/失敗・エラーコードだけ（金額・件数・エラー本文を返さない）
 * - 連続実行の制限・期限切れで 404
 */

const session = vi.hoisted(() => ({ user: null as null | { id: string; role: "OPERATOR" | "STORE"; email: string; name: string } }));
const calls = vi.hoisted(() => ({ list: [] as string[], failAggregate: false }));

vi.mock("@/lib/auth/session", () => ({ getSessionUser: async () => session.user }));
vi.mock("@/lib/data-provider", () => ({ isFirestore: () => true }));
vi.mock("@/lib/firestore/admin", () => {
  // 読み取り系のメソッドだけを持つ偽物（set/update/delete/add などは存在しないので、呼べば必ず失敗する）
  const query = (): Record<string, unknown> => ({
    where: (...a: unknown[]) => (calls.list.push(`where:${String(a[0])}`), query()),
    select: () => (calls.list.push("select"), query()),
    get: async () => (calls.list.push("get"), { size: 3, docs: [] }),
    count: () => ({ get: async () => (calls.list.push("count"), aggregateResult()) }),
    aggregate: () => ({ get: async () => (calls.list.push("aggregate"), aggregateResult()) }),
  });
  const aggregateResult = () => {
    if (calls.failAggregate) throw Object.assign(new Error("9 FAILED_PRECONDITION: secret-looking detail 12345"), { code: 9 });
    return { data: () => ({ count: 3, v: 300 }) };
  };
  return { C: { transactions: "transactions" }, fsdb: () => ({ collection: (name: string) => (calls.list.push(`collection:${name}`), query()) }) };
});

async function call() {
  const { GET } = await import("@/app/api/admin/diagnostics/aggregation/route");
  return GET();
}

beforeEach(() => {
  vi.resetModules(); // 回数制限（メモリ上）をテストごとに初期化
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-20T12:00:00+09:00"));
  calls.list = [];
  calls.failAggregate = false;
  session.user = null;
});
afterEach(() => vi.useRealTimers());

const operator = { id: "op1", role: "OPERATOR" as const, email: "op@example.test", name: "運営" };

describe("診断API：権限", () => {
  it("未ログインは 404（Firestore に触れない）", async () => {
    const res = await call();
    expect(res.status).toBe(404);
    expect(calls.list).toEqual([]);
  });

  it("店舗アカウントは 404（Firestore に触れない）", async () => {
    session.user = { id: "st1", role: "STORE", email: "st@example.test", name: "店舗" };
    const res = await call();
    expect(res.status).toBe(404);
    expect(calls.list).toEqual([]);
  });

  it("運営アカウントは実行でき、Cache-Control: no-store", async () => {
    session.user = operator;
    const res = await call();
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
  });
});

describe("診断API：読み取りだけ・返す内容", () => {
  it("transactions の読み取り系メソッドだけを使う", async () => {
    session.user = operator;
    await call();
    const used = new Set(calls.list.map((c) => c.split(":")[0]));
    for (const m of used) expect(["collection", "where", "select", "get", "count", "aggregate"]).toContain(m);
    expect(calls.list.filter((c) => c.startsWith("collection:")).every((c) => c === "collection:transactions")).toBe(true);
  });

  it("成功時は処理名と成功だけを返す（件数・金額は返さない）", async () => {
    session.user = operator;
    const body = await (await call()).json();
    expect(body.ok).toBe(true);
    expect(body.steps.length).toBe(9);
    for (const s of body.steps) expect(Object.keys(s).sort()).toEqual(["ok", "step"]);
    expect(JSON.stringify(body)).not.toMatch(/300|"size"|"docs"/);
  });

  it("失敗時は処理名・失敗・エラーコードだけを返す（エラー本文は返さない）", async () => {
    session.user = operator;
    calls.failAggregate = true;
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const body = await (await call()).json();
    expect(body.ok).toBe(false);
    const failed = body.steps.filter((s: { ok: boolean }) => !s.ok);
    expect(failed.map((s: { step: string }) => s.step)).toEqual([
      "aggregate_month_count",
      "aggregate_month_sum_amount",
      "aggregate_month_sum_storeShare",
      "aggregate_month_sum_operatorShare",
      "aggregate_month_sum_paymentFee",
      "aggregate_month_count_and_4_sums_as_admin",
      "aggregate_all_time_count",
    ]);
    for (const s of failed) expect(s).toEqual({ step: s.step, ok: false, code: "9" });
    expect(body.steps.slice(0, 2).every((s: { ok: boolean }) => s.ok)).toBe(true);
    const text = JSON.stringify(body) + spy.mock.calls.flat().join(" ");
    expect(text).not.toContain("secret-looking");
    expect(text).not.toContain("12345");
    expect(spy.mock.calls[0][0]).toBe('[diagnostics:aggregation] step="aggregate_month_count" failed code=9');
    spy.mockRestore();
  });
});

describe("診断API：連続実行の制限と期限", () => {
  it("同じアカウントは30秒に1回まで（2回目は 429、30秒後は再び実行できる）", async () => {
    session.user = operator;
    const { GET } = await import("@/app/api/admin/diagnostics/aggregation/route");
    expect((await GET()).status).toBe(200);
    const before = calls.list.length;
    const second = await GET();
    expect(second.status).toBe(429);
    expect(calls.list.length).toBe(before); // 制限中は Firestore を読まない
    vi.advanceTimersByTime(30_000);
    expect((await GET()).status).toBe(200);
  });

  it("サーバー全体でも1時間20回まで", async () => {
    const { GET } = await import("@/app/api/admin/diagnostics/aggregation/route");
    for (let i = 0; i < 20; i++) {
      session.user = { ...operator, id: `op${i}` };
      expect((await GET()).status).toBe(200);
    }
    session.user = { ...operator, id: "op-new" };
    expect((await GET()).status).toBe(429);
  });

  it("期限（2026-11-15 JST）を過ぎると、運営でも 404", async () => {
    session.user = operator;
    vi.setSystemTime(new Date("2026-11-15T00:00:00+09:00"));
    expect((await call()).status).toBe(404);
    expect(calls.list).toEqual([]);
  });
});
