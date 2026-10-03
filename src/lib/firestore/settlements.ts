import "server-only";
import { FieldValue, type DocumentData } from "firebase-admin/firestore";
import type { Settlement } from "@/lib/db/schema";
import { isValidYearMonth, jstYearMonth } from "@/lib/time";
import type { SettlementStatus } from "@/lib/services/settlements";
import { C, fsdb, mustDate, toDate } from "./admin";
import { writeAudit, type AuditEntry } from "./audit";
import { getStoresByIds } from "./stores";

/**
 * 月次精算（Firestore 版）。売上の計算元ではなく「振込状況（未払い／処理中／支払済）」の管理用。
 *  settlements/{storeId_年月} … 1店舗1か月1件（IDで重複を防ぐ）
 * 金額は transactions（決済成功・返金除外）から自動集計して保存する。
 */

type Actor = { userId: string | null; role: AuditEntry["actorRole"] };

export const settlementId = (storeId: string, yearMonth: string) => `${storeId}_${yearMonth}`;

function toSettlement(id: string, d: DocumentData): Settlement {
  return {
    id,
    storeId: String(d.storeId),
    yearMonth: String(d.yearMonth),
    transactionCount: Number(d.transactionCount ?? 0),
    grossSales: Number(d.grossSales ?? 0),
    storeShare: Number(d.storeShare ?? 0),
    status: d.status,
    paidAt: toDate(d.paidAt),
    note: String(d.note ?? ""),
    createdAt: mustDate(d.createdAt),
    updatedAt: mustDate(d.updatedAt),
  };
}

export async function generateSettlements(yearMonth: string, actor: Actor): Promise<{ upserted: number; skipped: number }> {
  if (!isValidYearMonth(yearMonth)) throw new Error("invalid yearMonth");
  if (yearMonth >= jstYearMonth()) throw new Error("当月以降の精算は作成できません（月末締め後に作成してください）");

  // その月の売上（決済成功・返金除外）を店舗ごとに合計。テスト用の疑似決済は振込対象にしない
  const snap = await fsdb().collection(C.transactions).where("cYm", "==", yearMonth).get();
  const agg = new Map<string, { cnt: number; gross: number; share: number }>();
  for (const d of snap.docs) {
    if (d.get("paymentProvider") === "mock") continue;
    const sid = String(d.get("storeId"));
    const a = agg.get(sid) ?? { cnt: 0, gross: 0, share: 0 };
    a.cnt += 1;
    a.gross += Number(d.get("amount"));
    a.share += Number(d.get("storeShare"));
    agg.set(sid, a);
  }

  let upserted = 0;
  let skipped = 0;
  const col = fsdb().collection(C.settlements);
  for (const [storeId, a] of agg) {
    const ref = col.doc(settlementId(storeId, yearMonth));
    const changed = await fsdb().runTransaction(async (tx) => {
      const cur = await tx.get(ref);
      if (!cur.exists) {
        tx.create(ref, { storeId, yearMonth, transactionCount: a.cnt, grossSales: a.gross, storeShare: a.share, status: "UNPAID", paidAt: null, note: "", createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() });
        return true;
      }
      if (cur.get("status") !== "UNPAID") return false; // 処理中・支払済は変更しない
      tx.update(ref, { transactionCount: a.cnt, grossSales: a.gross, storeShare: a.share, updatedAt: FieldValue.serverTimestamp() });
      return true;
    });
    if (changed) upserted++;
    else skipped++;
  }

  // 返金等で当月の決済がなくなった店舗の未払い精算は 0 に更新
  const existing = await col.where("yearMonth", "==", yearMonth).get();
  for (const d of existing.docs) {
    if (agg.has(String(d.get("storeId")))) continue;
    const zeroed = await fsdb().runTransaction(async (tx) => {
      const cur = await tx.get(d.ref);
      if (cur.get("status") !== "UNPAID") return false;
      tx.update(d.ref, { transactionCount: 0, grossSales: 0, storeShare: 0, updatedAt: FieldValue.serverTimestamp() });
      return true;
    });
    if (zeroed) upserted++;
  }
  await writeAudit({ actorUserId: actor.userId, actorRole: actor.role, action: "settlement.generate", targetType: "settlement", targetId: yearMonth, after: { yearMonth, upserted, skipped } });
  return { upserted, skipped };
}

export async function updateSettlementStatus(id: string, status: SettlementStatus, note: string, actor: Actor): Promise<void> {
  const ref = fsdb().collection(C.settlements).doc(id);
  await fsdb().runTransaction(async (tx) => {
    const cur = await tx.get(ref);
    if (!cur.exists) throw new Error("settlement not found");
    const before = toSettlement(cur.id, cur.data()!);
    tx.update(ref, { status, note: note.slice(0, 1000), paidAt: status === "PAID" ? (before.paidAt ?? new Date()) : null, updatedAt: FieldValue.serverTimestamp() });
    await writeAudit(
      { actorUserId: actor.userId, actorRole: actor.role, action: "settlement.status", targetType: "settlement", targetId: id, storeId: before.storeId, before: { status: before.status, note: before.note }, after: { status, note } },
      tx,
    );
  });
}

export async function listSettlements(opts: { yearMonth?: string; status?: SettlementStatus; storeId?: string; limit?: number }) {
  const col = fsdb().collection(C.settlements);
  const q = opts.storeId ? col.where("storeId", "==", opts.storeId) : opts.yearMonth ? col.where("yearMonth", "==", opts.yearMonth) : col;
  const snap = await q.get();
  let rows = snap.docs.map((d) => toSettlement(d.id, d.data()));
  if (opts.yearMonth) rows = rows.filter((r) => r.yearMonth === opts.yearMonth);
  if (opts.status) rows = rows.filter((r) => r.status === opts.status);
  const stores = new Map((await getStoresByIds(rows.map((r) => r.storeId))).map((s) => [s.id, s]));
  return rows
    .filter((r) => stores.has(r.storeId))
    .map((s) => ({ s, storeName: stores.get(s.storeId)!.name, bankLast4: stores.get(s.storeId)!.bankAccountLast4 }))
    .sort((a, b) => (a.s.yearMonth === b.s.yearMonth ? a.storeName.localeCompare(b.storeName, "ja") : a.s.yearMonth < b.s.yearMonth ? 1 : -1))
    .slice(0, opts.limit ?? Number.MAX_SAFE_INTEGER);
}
