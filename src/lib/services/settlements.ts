import "server-only";
import { isFirestore } from "@/lib/data-provider";
import * as fsSettle from "@/lib/firestore/settlements";
import { and, desc, eq, notInArray, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { settlements, stores, type Settlement } from "@/lib/db/schema";
import { isValidYearMonth, jstMonthRange, jstYearMonth } from "@/lib/time";
import { writeAudit } from "./audit";
import type { Actor } from "./stores";

export type SettlementStatus = "UNPAID" | "PROCESSING" | "PAID";
export const SETTLEMENT_LABEL: Record<SettlementStatus, string> = { UNPAID: "未払い", PROCESSING: "処理中", PAID: "支払済" };

/**
 * 精算の表示用の値。
 *  storeShare     … その月の店舗報酬（確定後は、確定時に支払う額として記録した合計）
 *  heldShare      … 異議申し立ての対応中で保留している額（店舗報酬に含めない）
 *  adjustmentTotal … 確定時に反映した調整の合計（振込後の返金などはマイナス）
 *  carryOver      … 調整が振込額を超えて次回へ繰り越した額（マイナス）
 *  payableAmount  … 振込額（確定後だけ。未払いの間は null）
 * PostgreSQL 版（調整の仕組みなし）は、確定後の店舗報酬をそのまま振込額とする。
 */
export type SettlementView = Settlement & { heldShare: number; adjustmentTotal: number; carryOver: number; payableAmount: number | null; lockedAt: Date | null; appliedAdjustmentCount: number };

const pgView = (s: Settlement): SettlementView => ({ ...s, heldShare: 0, adjustmentTotal: 0, carryOver: 0, payableAmount: s.status === "UNPAID" ? null : s.storeShare, lockedAt: null, appliedAdjustmentCount: 0 });

/**
 * 月次精算を作成/更新する（締め済みの月のみ）。
 * 未払い(UNPAID)の行は最新の集計で更新、処理中・支払済の行は変更しない。
 * 疑似決済（payment_provider = 'mock'）と決済代行のテスト決済（livemode = false）は振込対象外。
 */
export async function generateSettlements(yearMonth: string, actor: Actor): Promise<{ upserted: number; skipped: number; late?: number }> {
  if (isFirestore()) return fsSettle.generateSettlements(yearMonth, actor);
  if (!isValidYearMonth(yearMonth)) throw new Error("invalid yearMonth");
  if (yearMonth >= jstYearMonth()) throw new Error("当月以降の精算は作成できません（月末締め後に作成してください）");
  const { start, end } = jstMonthRange(yearMonth);
  return db().transaction(async (tx) => {
    const agg = await tx.execute(sql`
      SELECT store_id, count(*)::int AS cnt, sum(amount)::int AS gross, sum(store_share)::int AS share
      FROM transactions
      WHERE payment_status = 'SUCCEEDED' AND paid_at >= ${start.toISOString()} AND paid_at < ${end.toISOString()}
        -- 振込対象は本番環境の決済だけ（疑似決済・決済代行のテスト決済は含めない。lib/payments/kind.ts の isSettlementPayment と同じ）
        AND payment_provider <> 'mock' AND livemode = true
      GROUP BY store_id`);
    let upserted = 0;
    let skipped = 0;
    for (const r of agg.rows) {
      const res = await tx
        .insert(settlements)
        .values({ storeId: String(r.store_id), yearMonth, transactionCount: Number(r.cnt), grossSales: Number(r.gross), storeShare: Number(r.share) })
        .onConflictDoUpdate({
          target: [settlements.storeId, settlements.yearMonth],
          set: { transactionCount: Number(r.cnt), grossSales: Number(r.gross), storeShare: Number(r.share), updatedAt: new Date() },
          setWhere: sql`${settlements.status} = 'UNPAID'`,
        })
        .returning({ id: settlements.id });
      if (res.length) upserted++;
      else skipped++;
    }
    // 返金等で当月の決済がなくなった店舗の未払い精算は 0 に更新（古い金額のまま振り込まないように）
    const storeIds = agg.rows.map((r) => String(r.store_id));
    const zeroed = await tx
      .update(settlements)
      .set({ transactionCount: 0, grossSales: 0, storeShare: 0, updatedAt: new Date() })
      .where(
        and(
          eq(settlements.yearMonth, yearMonth),
          eq(settlements.status, "UNPAID"),
          storeIds.length ? notInArray(settlements.storeId, storeIds) : undefined,
        ),
      )
      .returning({ id: settlements.id });
    upserted += zeroed.length;
    await writeAudit({ actorUserId: actor.userId, actorRole: actor.role, action: "settlement.generate", targetType: "settlement", targetId: yearMonth, after: { yearMonth, upserted, skipped } }, tx);
    return { upserted, skipped };
  });
}

export async function updateSettlementStatus(id: string, status: SettlementStatus, note: string, actor: Actor): Promise<void> {
  if (isFirestore()) return fsSettle.updateSettlementStatus(id, status, note, actor);
  await db().transaction(async (tx) => {
    const [before] = await tx.select().from(settlements).where(eq(settlements.id, id)).for("update");
    if (!before) throw new Error("settlement not found");
    await tx
      .update(settlements)
      .set({ status, note: note.slice(0, 1000), paidAt: status === "PAID" ? (before.paidAt ?? new Date()) : null })
      .where(eq(settlements.id, id));
    await writeAudit(
      { actorUserId: actor.userId, actorRole: actor.role, action: "settlement.status", targetType: "settlement", targetId: id, storeId: before.storeId, before: { status: before.status, note: before.note }, after: { status, note } },
      tx,
    );
  });
}

export async function listSettlements(opts: { yearMonth?: string; status?: SettlementStatus; storeId?: string; limit?: number }): Promise<{ s: SettlementView; storeName: string; bankLast4: string | null }[]> {
  if (isFirestore()) return fsSettle.listSettlements(opts);
  const conds = [
    opts.yearMonth ? eq(settlements.yearMonth, opts.yearMonth) : undefined,
    opts.status ? eq(settlements.status, opts.status) : undefined,
    opts.storeId ? eq(settlements.storeId, opts.storeId) : undefined,
  ].filter(Boolean);
  return db()
    .select({ s: settlements, storeName: stores.name, bankLast4: stores.bankAccountLast4 })
    .from(settlements)
    .innerJoin(stores, eq(stores.id, settlements.storeId))
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(desc(settlements.yearMonth), stores.name)
    // limit 未指定時は全件（振込CSV・精算画面で店舗が欠けないように）
    .limit(opts.limit ?? Number.MAX_SAFE_INTEGER)
    .then((rows) => rows.map((r) => ({ ...r, s: pgView(r.s) })));
}

/** 精算の調整の一覧（振込後の返金・異議申し立てなど）。PostgreSQL 版は調整の仕組みがないため空 */
export async function listSettlementAdjustments(opts: { storeId?: string; status?: "OPEN" | "APPLIED"; limit?: number } = {}) {
  if (!isFirestore()) return [];
  const { listAdjustments } = await import("@/lib/firestore/settlement-adjustments");
  return listAdjustments(opts);
}
