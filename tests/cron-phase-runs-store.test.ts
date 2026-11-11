/**
 * 段階ごとの実行の結果の保存（system/cronPhaseRuns。lib/firestore/cron-run.ts の recordCronPhaseRun・readCronPhaseRuns）。
 *  - 段階ごとに最後の結果だけ。より新しい開始の記録は、古い実行の結果で上書きしない
 *  - 要約は件数・状態・時刻だけ（入れ子のオブジェクトは保存しない・文字列は短く切る）
 * Firestore は模擬（メモリ上）。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({ doc: null as Record<string, unknown> | null, writes: 0 }));
vi.mock("@/lib/firestore/admin", async (orig) => {
  const actual = await orig<typeof import("@/lib/firestore/admin")>();
  const snap = () => ({ exists: db.doc !== null, get: (k: string) => db.doc?.[k], data: () => db.doc ?? undefined });
  const ref = { get: async () => snap() };
  return {
    ...actual,
    fsdb: () => ({
      collection: () => ({ doc: () => ref }),
      runTransaction: async <T,>(fn: (tx: unknown) => Promise<T>) =>
        fn({
          get: async () => snap(),
          set: (_r: unknown, v: Record<string, unknown>) => {
            db.writes++;
            db.doc = { ...(db.doc ?? {}), ...v };
          },
        }),
    }),
  };
});

beforeEach(() => {
  db.doc = null;
  db.writes = 0;
});

const entry = (startedAt: string, status: "ok" | "failed" = "ok", detail: Record<string, unknown> | null = null) => ({
  status,
  reason: null,
  errorCode: status === "failed" ? "X".repeat(200) : null,
  startedAt: new Date(startedAt),
  finishedAt: new Date(new Date(startedAt).getTime() + 1000),
  durationMs: 1000,
  abortSettled: null,
  detail,
});

describe("system/cronPhaseRuns", () => {
  it("段階ごとに保存し、読み戻せる（日時は Date）。エラーの識別子は80文字まで", async () => {
    const { recordCronPhaseRun, readCronPhaseRuns } = await import("@/lib/firestore/cron-run");
    expect(await recordCronPhaseRun("maintenance", entry("2026-11-11T03:00:00Z"))).toBe(true);
    expect(await recordCronPhaseRun("webhookRecovery", entry("2026-11-11T03:05:00Z", "failed"))).toBe(true);
    const r = await readCronPhaseRuns();
    expect(Object.keys(r).sort()).toEqual(["maintenance", "webhookRecovery"]);
    expect(r.maintenance.startedAt).toEqual(new Date("2026-11-11T03:00:00Z"));
    expect(r.webhookRecovery.status).toBe("failed");
    expect(r.webhookRecovery.errorCode).toHaveLength(80);
  });

  it("より新しい開始の記録があれば、古い実行の結果で上書きしない", async () => {
    const { recordCronPhaseRun, readCronPhaseRuns } = await import("@/lib/firestore/cron-run");
    await recordCronPhaseRun("paymentMonitor", entry("2026-11-11T03:10:00Z"));
    expect(await recordCronPhaseRun("paymentMonitor", entry("2026-11-10T03:10:00Z", "failed"))).toBe(false);
    expect((await readCronPhaseRuns()).paymentMonitor.status).toBe("ok");
    expect(await recordCronPhaseRun("paymentMonitor", entry("2026-11-12T03:10:00Z", "failed"))).toBe(true);
    expect((await readCronPhaseRuns()).paymentMonitor.status).toBe("failed");
  });

  it("要約は件数・状態・時刻だけ（入れ子のオブジェクト・配列は保存しない。文字列は80文字まで）", async () => {
    const { recordCronPhaseRun, readCronPhaseRuns } = await import("@/lib/firestore/cron-run");
    await recordCronPhaseRun(
      "paymentMonitor",
      entry("2026-11-11T03:10:00Z", "ok", { status: "issues", found: 2, stripeMode: "live", finishedAt: new Date("2026-11-11T03:10:30Z"), nested: { secret: "x" }, list: [1, 2], long: "y".repeat(300), undef: undefined }),
    );
    const d = (await readCronPhaseRuns()).paymentMonitor.detail!;
    expect(d).toMatchObject({ status: "issues", found: 2, stripeMode: "live", finishedAt: new Date("2026-11-11T03:10:30Z") });
    expect(d).not.toHaveProperty("nested");
    expect(d).not.toHaveProperty("list");
    expect(d).not.toHaveProperty("undef");
    expect((d.long as string).length).toBe(80);
  });

  it("壊れた記録・updatedAt は読み飛ばす", async () => {
    const { readCronPhaseRuns } = await import("@/lib/firestore/cron-run");
    db.doc = { updatedAt: new Date(), maintenance: { status: "ok" }, bogus: "x", recheckRecovery: { status: "ok", startedAt: new Date(), finishedAt: new Date() } };
    expect(Object.keys(await readCronPhaseRuns())).toEqual(["recheckRecovery"]);
  });
});
