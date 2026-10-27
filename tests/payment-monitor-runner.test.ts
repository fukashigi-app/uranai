import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { monitorHealth } from "@/lib/payments/monitor-rules";

// Firestore の代わり：読み込みを失敗させるコレクションを選べる。点検の状態（system/paymentMonitor）と異常の記録だけ保存する
const fs = vi.hoisted(() => ({ failing: new Set<string>(), docs: new Map<string, Record<string, unknown>>(), reads: 0, txFail: false }));

vi.mock("@/lib/firestore/admin", async (orig) => {
  const actual = await orig<typeof import("@/lib/firestore/admin")>();
  const query = (name: string) => {
    const q = {
      where: () => q,
      orderBy: () => q,
      limit: () => q,
      startAfter: () => q,
      get: async () => {
        fs.reads++;
        if (fs.failing.has(name)) throw Object.assign(new Error("unavailable"), { name: "FirebaseError" });
        return { docs: [], size: 0 };
      },
      count: () => ({
        get: async () => {
          if (fs.failing.has(name)) throw Object.assign(new Error("unavailable"), { name: "FirebaseError" });
          return { data: () => ({ count: 0 }) };
        },
      }),
      doc: (id: string) => {
        const path = `${name}/${id}`;
        return {
          path,
          id,
          get: async () => ({ exists: fs.docs.has(path), get: (k: string) => fs.docs.get(path)?.[k] }),
          set: async (data: Record<string, unknown>) => void fs.docs.set(path, { ...fs.docs.get(path), ...data }),
        };
      },
    };
    return q;
  };
  const fake = {
    collection: (name: string) => query(name),
    getAll: async () => [],
    runTransaction: async (fn: (tx: unknown) => Promise<unknown>) => {
      if (fs.txFail) throw Object.assign(new Error("unavailable"), { name: "FirebaseError" });
      return fn({
        get: async (r: { path: string }) => ({ exists: fs.docs.has(r.path), get: (k: string) => fs.docs.get(r.path)?.[k] }),
        create: (r: { path: string }, d: Record<string, unknown>) => void fs.docs.set(r.path, d),
        update: (r: { path: string }, d: Record<string, unknown>) => void fs.docs.set(r.path, { ...fs.docs.get(r.path), ...d }),
        set: (r: { path: string }, d: Record<string, unknown>, o?: { merge?: boolean }) => void fs.docs.set(r.path, o?.merge ? { ...fs.docs.get(r.path), ...d } : d),
        delete: (r: { path: string }) => void fs.docs.delete(r.path),
      });
    },
  };
  return { ...actual, fsdb: () => fake };
});

const { runPaymentMonitor } = await import("@/lib/payments/payment-monitor");
const { readMonitorStatus } = await import("@/lib/firestore/payment-alerts");

async function monitor(o: Parameters<typeof runPaymentMonitor>[0]) {
  const x = await runPaymentMonitor(o);
  if (!x.started) throw new Error(`not started: ${JSON.stringify(x)}`);
  return x.report;
}
describe("監視の点検：Firestore の読み込みに失敗しても、確認していない範囲を「異常なし」にしない", () => {
  beforeEach(() => {
    fs.reads = 0;
    fs.txFail = false;
    fs.failing.clear();
    fs.docs.clear();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });
  afterEach(() => vi.restoreAllMocks());

  it("すべて読めれば ok", async () => {
    const r = await monitor({ rt: null });
    expect(r.result).toBe("ok");
    expect(monitorHealth(await readMonitorStatus(), new Date(), 0).state).toBe("ok");
  });

  it("取引の読み込みに失敗 → 一部未確認（その項目を「確認できなかった項目」に出し、異常の記録にも残す）", async () => {
    fs.failing.add("transactions");
    const r = await monitor({ rt: null });
    expect(r.result).toBe("partial");
    expect(r.unchecked).toContain("占い権利の付与");
    expect(monitorHealth(await readMonitorStatus(), new Date(), 0).state).toBe("partial");
    expect([...fs.docs.values()].some((d) => d.kind === "monitor_check_failed")).toBe(true);
  });

  it("すべての項目の読み込みに失敗 → 失敗（異常なしと表示しない）", async () => {
    for (const c of ["checkouts", "transactions", "settlements", "paymentReviews"]) fs.failing.add(c);
    const r = await monitor({ rt: null });
    expect(r.result).toBe("failed");
    expect(monitorHealth(await readMonitorStatus(), new Date(), 0).state).toBe("failed");
  });

  it("時間の上限を超えたら、残りの項目は実施せず一部未確認", async () => {
    const r = await monitor({ rt: null, limits: { deadlineMs: -1 } });
    expect(r.result).toBe("failed");
    expect(r.unchecked.every((u) => u.includes("時間切れ"))).toBe(true);
    expect(fs.reads).toBe(0); // 時間切れの後は読み込まない
  });

  it("実行状態（ロック）を記録できなければ点検を開始しない（読み込みもしない）", async () => {
    fs.txFail = true;
    const x = await runPaymentMonitor({ rt: null });
    expect(x).toEqual({ started: false, reason: "lock_failed" });
    expect(fs.reads).toBe(0);
  });

  it("点検の後はロックを外す（次の点検を開始できる）。実行中のロックがあれば開始しない", async () => {
    await monitor({ rt: null });
    expect(fs.docs.has("system/paymentMonitorLock")).toBe(false);
    fs.docs.set("system/paymentMonitorLock", { runId: "other", source: "cron", expiresAt: new Date(Date.now() + 60_000) });
    fs.reads = 0;
    const x = await runPaymentMonitor({ rt: null });
    expect(x).toMatchObject({ started: false, reason: "busy", source: "cron" });
    expect(fs.reads).toBe(0);
    expect(fs.docs.get("system/paymentMonitorLock")).toMatchObject({ runId: "other" }); // 他の点検のロックはそのまま
  });
});
