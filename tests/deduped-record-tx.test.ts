import { FieldValue, type DocumentReference, type DocumentSnapshot, type Transaction } from "firebase-admin/firestore";
import { describe, expect, it } from "vitest";
import { upsertDedupedRecordInTx } from "@/lib/firestore/deduped-record";

// 決済要確認・決済監視の「種類・対象ごとに1件」の記録を、呼び出し側のトランザクションの中で書く規則（Firestore には接続しない）
const NOW = new Date("2026-10-29T03:00:00Z");
const ref = { path: "paymentReviews/legacy_settlement_change_x" } as unknown as DocumentReference;
const snap = (data: Record<string, unknown> | null, path = ref.path) =>
  ({ exists: data !== null, ref: { path }, get: (k: string) => (data ?? {})[k] }) as unknown as DocumentSnapshot;
function fakeTx() {
  const calls: { op: "create" | "update"; data: Record<string, unknown> }[] = [];
  const tx = {
    create: (_r: unknown, data: Record<string, unknown>) => calls.push({ op: "create", data }),
    update: (_r: unknown, data: Record<string, unknown>) => calls.push({ op: "update", data }),
  } as unknown as Transaction;
  return { tx, calls };
}
const fields = { kind: "legacy_settlement_change", amount: -9 };

describe("upsertDedupedRecordInTx（トランザクションの中の記録）", () => {
  it("記録が無ければ、未確認・回数1で作成する", () => {
    const { tx, calls } = fakeTx();
    upsertDedupedRecordInTx(tx, ref, snap(null), fields, { causeKey: "k1", reopen: "on_change", now: NOW });
    expect(calls).toEqual([{ op: "create", data: { ...fields, causeKey: "k1", status: "OPEN", occurrences: 1, firstSeenAt: NOW, lastSeenAt: NOW, resolvedAt: null, resolvedBy: null } }]);
  });

  it("未確認の記録があれば、回数と最後の日時だけを更新する（状態は変えない）", () => {
    const { tx, calls } = fakeTx();
    upsertDedupedRecordInTx(tx, ref, snap({ status: "OPEN", causeKey: "k1", occurrences: 1 }), fields, { causeKey: "k1", reopen: "on_change", now: NOW });
    expect(calls).toHaveLength(1);
    expect(calls[0].op).toBe("update");
    expect(calls[0].data.occurrences).toEqual(FieldValue.increment(1));
    expect(calls[0].data.lastSeenAt).toBe(NOW);
    expect(calls[0].data).not.toHaveProperty("status");
    expect(calls[0].data).not.toHaveProperty("firstSeenAt");
  });

  it("確認済みの記録に同じ内容：確認済みのまま（回数だけ増える）", () => {
    const { tx, calls } = fakeTx();
    upsertDedupedRecordInTx(tx, ref, snap({ status: "RESOLVED", causeKey: "k1", resolvedBy: "op" }), fields, { causeKey: "k1", reopen: "on_change", now: NOW });
    expect(calls[0].data).not.toHaveProperty("status");
    expect(calls[0].data).not.toHaveProperty("resolvedBy");
  });

  it("確認済みの記録に違う内容：未確認に戻す", () => {
    const { tx, calls } = fakeTx();
    upsertDedupedRecordInTx(tx, ref, snap({ status: "RESOLVED", causeKey: "k1", resolvedBy: "op" }), fields, { causeKey: "k2", reopen: "on_change", now: NOW });
    expect(calls[0].data).toMatchObject({ status: "OPEN", resolvedAt: null, resolvedBy: null, causeKey: "k2" });
  });

  it("reopen=always は、確認済みの後にもう一度起きたら未確認に戻す（決済監視）", () => {
    const { tx, calls } = fakeTx();
    upsertDedupedRecordInTx(tx, ref, snap({ status: "RESOLVED", causeKey: "k1" }), fields, { causeKey: "k1", reopen: "always", now: NOW });
    expect(calls[0].data).toMatchObject({ status: "OPEN" });
  });

  it("先に読んだ記録と参照が違うときは書かない（例外。トランザクション全体が失敗する）", () => {
    const { tx, calls } = fakeTx();
    expect(() => upsertDedupedRecordInTx(tx, ref, snap(null, "paymentReviews/other"), fields, { causeKey: "k1", reopen: "on_change" })).toThrow();
    expect(calls).toHaveLength(0);
  });
});

describe("以前の方式の項目（recentOccurrenceKeys）", () => {
  it("新しくは書かない（既存の値はそのまま。回数は今までどおり数える）", () => {
    const d = fakeTx();
    upsertDedupedRecordInTx(d.tx, ref, snap({ status: "OPEN", causeKey: "k1", recentOccurrenceKeys: ["event:e1"] }), fields, { causeKey: "k1", reopen: "on_change" });
    expect(d.calls[0].data).not.toHaveProperty("recentOccurrenceKeys");
    expect(d.calls[0].data.occurrences).toEqual(FieldValue.increment(1));
    const e = fakeTx();
    upsertDedupedRecordInTx(e.tx, ref, snap(null), fields, { causeKey: "k1", reopen: "on_change" });
    expect(e.calls[0].data).not.toHaveProperty("recentOccurrenceKeys");
  });
});
