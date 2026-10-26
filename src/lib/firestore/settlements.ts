import "server-only";
import { FieldValue, type DocumentData, type DocumentReference } from "firebase-admin/firestore";
import { isValidYearMonth, jstYearMonth } from "@/lib/time";
import type { SettlementStatus, SettlementView } from "@/lib/services/settlements";
import { C, fsdb, mustDate, toDate } from "./admin";
import { writeAudit, type AuditEntry } from "./audit";
import { getStoresByIds } from "./stores";
import { isSettlementPayment } from "@/lib/payments/kind";
import { applyAdjustments, entitledStoreShare, heldStoreShare, netSalesFigures } from "@/lib/payments/settlement-rules";
import { stampTransaction, storesWithOpenAdjustments, txFacts } from "./settlement-adjustments";
import { recordPaymentReview } from "./payment-reviews";

/**
 * 月次精算（Firestore 版）。売上の計算元ではなく「振込状況（未払い／処理中／支払済）」の管理用。
 *  settlements/{storeId_年月} … 1店舗1か月1件（IDで重複を防ぐ）
 * 金額は transactions から自動集計して保存する（振込は運営が手動で、原則3か月ごとにまとめて行う）。
 *
 *  未払い（UNPAID）… 集計し直すたびに最新の値で上書き。取り分は「今の時点で支払うべき額」（返金後・異議申し立ての対応中は保留）
 *  処理中・支払済 … 確定済み。初めて確定するとき（未払い → 処理中・支払済）に、
 *                   ① その月の本番の決済に「支払う額」（settledShare）を記録し、
 *                   ② 未反映の調整（振込後の返金・異議申し立てなど）を合わせて振込額（payableAmount）を決める。
 *                      調整が振込額を超えるときは 0 円にして、残りを次回へ繰り越す（settlementAdjustments/carry_精算ID）
 *                   確定後は金額を変えない（未払いにも戻せない）。後の返金などは調整として次回の精算に反映する。
 *  確定の順番 …… 同じ店舗では古い月から確定する（古い月に未払いの精算が残っているときは確定できない）。
 *                 未反映の調整は、確定した精算に古いものから反映し、反映先（appliedSettlementId）を調整に記録する。
 *  以前の仕組みで確定した精算（lockedAt が無い）… 取引ごとの支払った額の記録が無い。推測で調整・取り込みはせず、
 *                 今の集計と金額が合わないときは「決済要確認」に記録する。
 */

/** 1回の確定で反映する調整の上限（Firestore のトランザクションの書き込みの上限に余裕を持たせる）。残りは次回の確定で反映する */
export const MAX_ADJUSTMENTS_PER_LOCK = 400;
/** 確定時に取引へ支払う額を記録するときの同時実行数 */
const STAMP_CONCURRENCY = 10;

async function inParallel<T>(items: T[], n: number, fn: (item: T) => Promise<unknown>): Promise<void> {
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (i < items.length) await fn(items[i++]);
    }),
  );
}

type Actor = { userId: string | null; role: AuditEntry["actorRole"] };

export const settlementId = (storeId: string, yearMonth: string) => `${storeId}_${yearMonth}`;

function toSettlement(id: string, d: DocumentData): SettlementView {
  const locked = d.status !== "UNPAID";
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
    heldShare: Number(d.heldShare ?? 0),
    adjustmentTotal: Number(d.adjustmentTotal ?? 0),
    carryOver: Number(d.carryOver ?? 0),
    // 以前に確定した精算（調整の仕組みの前）は、店舗報酬をそのまま振込額とみなす
    payableAmount: locked ? Number(d.payableAmount ?? d.storeShare ?? 0) : null,
    lockedAt: toDate(d.lockedAt),
    appliedAdjustmentCount: Array.isArray(d.appliedAdjustmentIds) ? d.appliedAdjustmentIds.length : 0,
  };
}

const txCol = () => fsdb().collection(C.transactions);
const adjCol = () => fsdb().collection(C.settlementAdjustments);
const isLiveDoc = (d: { get(f: string): unknown }) => isSettlementPayment(String(d.get("paymentProvider")), d.get("livemode"));

export async function generateSettlements(yearMonth: string, actor: Actor): Promise<{ upserted: number; skipped: number; late: number }> {
  if (!isValidYearMonth(yearMonth)) throw new Error("invalid yearMonth");
  if (yearMonth >= jstYearMonth()) throw new Error("当月以降の精算は作成できません（月末締め後に作成してください）");

  // その月の売上（決済成功。全額の返金・異議申し立ての敗訴は除く）を店舗ごとに合計。
  // 振込対象は本番環境の決済だけ（疑似決済・決済代行のテスト決済・livemode が記録されていない決済は含めない）。
  // 店舗報酬は今の時点で支払うべき額（一部返金は返金後の額。異議申し立ての対応中は保留 heldShare）
  const snap = await txCol().where("cYm", "==", yearMonth).get();
  const agg = new Map<string, { cnt: number; gross: number; share: number; held: number }>();
  for (const d of snap.docs) {
    if (!isLiveDoc(d)) continue;
    const f = txFacts(d.data());
    const sid = String(d.get("storeId"));
    const a = agg.get(sid) ?? { cnt: 0, gross: 0, share: 0, held: 0 };
    a.cnt += 1;
    a.gross += netSalesFigures({ ...f, operatorShare: Number(d.get("operatorShare")) }).gross;
    a.share += entitledStoreShare(f);
    a.held += heldStoreShare(f);
    agg.set(sid, a);
  }
  // 未反映の調整がある店舗は、売上が無くてもこの月の行を作る（調整だけでも精算・振込できるように）
  for (const sid of await storesWithOpenAdjustments()) if (!agg.has(sid)) agg.set(sid, { cnt: 0, gross: 0, share: 0, held: 0 });

  let upserted = 0;
  let skipped = 0;
  const col = fsdb().collection(C.settlements);
  for (const [storeId, a] of agg) {
    const ref = col.doc(settlementId(storeId, yearMonth));
    const values = { transactionCount: a.cnt, grossSales: a.gross, storeShare: a.share, heldShare: a.held };
    const changed = await fsdb().runTransaction(async (tx) => {
      const cur = await tx.get(ref);
      if (!cur.exists) {
        tx.create(ref, { storeId, yearMonth, ...values, status: "UNPAID", paidAt: null, note: "", createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() });
        return true;
      }
      if (cur.get("status") !== "UNPAID") return false; // 処理中・支払済は変更しない
      tx.update(ref, { ...values, updatedAt: FieldValue.serverTimestamp() });
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
      tx.update(d.ref, { transactionCount: 0, grossSales: 0, storeShare: 0, heldShare: 0, updatedAt: FieldValue.serverTimestamp() });
      return true;
    });
    if (zeroed) upserted++;
  }

  // 確定済みの精算の月に、確定の後で決済が確定した（PayPay の確定待ちなど）：支払った額 0 で取り込み、差額を調整として次回に反映。
  // 以前の仕組みで確定した精算（lockedAt が無い）は、どの取引を支払ったか分からないので取り込まない（金額が合わなければ要確認）
  let late = 0;
  for (const d of existing.docs) {
    if (d.get("status") === "UNPAID") continue;
    const txs = await txCol().where("storeYm", "==", `${d.get("storeId")}_${yearMonth}`).get();
    if (!d.get("lockedAt")) {
      const current = txs.docs.filter(isLiveDoc).reduce((sum, t) => sum + entitledStoreShare(txFacts(t.data())), 0);
      const recorded = Number(d.get("storeShare") ?? 0);
      if (current !== recorded) {
        await recordPaymentReview({ kind: "legacy_settlement_mismatch", objectType: "settlement", objectId: d.id, settlementId: d.id, storeId: String(d.get("storeId")), yearMonth, amount: current - recorded, livemode: true });
      }
      continue;
    }
    for (const t of txs.docs) {
      if (!isLiveDoc(t) || t.get("settlementId")) continue;
      if ((await stampTransaction(t.id, d.id, "late")) === "late") late++;
    }
  }
  await writeAudit({ actorUserId: actor.userId, actorRole: actor.role, action: "settlement.generate", targetType: "settlement", targetId: yearMonth, after: { yearMonth, upserted, skipped, late } });
  return { upserted, skipped, late };
}

export class SettlementStateError extends Error {}

export async function updateSettlementStatus(id: string, status: SettlementStatus, note: string, actor: Actor): Promise<void> {
  const ref = fsdb().collection(C.settlements).doc(id);
  const first = await ref.get();
  if (!first.exists) throw new Error("settlement not found");
  if (first.get("status") === "UNPAID" && status !== "UNPAID") {
    await lockSettlement(ref, status, note, actor);
    return;
  }
  await fsdb().runTransaction(async (tx) => {
    const cur = await tx.get(ref);
    if (!cur.exists) throw new Error("settlement not found");
    const before = toSettlement(cur.id, cur.data()!);
    if (before.status !== "UNPAID" && status === "UNPAID") {
      throw new SettlementStateError("確定済み（処理中・支払済）の精算は未払いに戻せません。金額の誤りは調整として次回の精算に反映してください。");
    }
    if (before.status === "UNPAID" && status !== "UNPAID") throw new SettlementStateError("精算の状態が変わりました。画面を再読み込みしてください。");
    tx.update(ref, { status, note: note.slice(0, 1000), paidAt: status === "PAID" ? (before.paidAt ?? new Date()) : null, updatedAt: FieldValue.serverTimestamp() });
    await writeAudit(
      { actorUserId: actor.userId, actorRole: actor.role, action: "settlement.status", targetType: "settlement", targetId: id, storeId: before.storeId, before: { status: before.status, note: before.note }, after: { status, note } },
      tx,
    );
  });
}

/**
 * 精算の確定（未払い → 処理中・支払済）。
 *  1) その月の本番の決済に、この精算で支払う額（今の取り分）を記録する（1件ずつ。返金などの処理と同時でも、どちらかの順に揃う）
 *  2) 記録した額の合計に、未反映の調整を合わせて振込額を決める（マイナスなら 0 円にして繰越）。
 *     未払いのままであることを確かめてから、精算・調整・繰越を同じトランザクションで書き込む（二重に確定しない）
 */
/** 同じ店舗の古い月に未払いの精算があれば確定させない */
async function assertOlderMonthsLocked(storeId: string, yearMonth: string): Promise<void> {
  const rows = await fsdb().collection(C.settlements).where("storeId", "==", storeId).get();
  const older = rows.docs.filter((d) => d.get("status") === "UNPAID" && String(d.get("yearMonth")) < yearMonth).map((d) => String(d.get("yearMonth"))).sort();
  if (older.length) throw new SettlementStateError(`先に${older[0]}の精算を確定してください（同じ店舗は古い月から確定します）。`);
}

async function lockSettlement(ref: DocumentReference, status: Exclude<SettlementStatus, "UNPAID">, note: string, actor: Actor): Promise<void> {
  const first = (await ref.get()).data()!;
  const storeId = String(first.storeId);
  const yearMonth = String(first.yearMonth);
  // 古い月に未払いの精算が残っていれば確定しない（調整の反映先が前後しないように。最終のトランザクションでも確かめる）
  await assertOlderMonthsLocked(storeId, yearMonth);
  const monthTxs = await txCol().where("storeYm", "==", `${storeId}_${yearMonth}`).get();
  const targets = monthTxs.docs.filter((t) => isLiveDoc(t) && !t.get("settlementId"));
  await inParallel(targets, STAMP_CONCURRENCY, (t) => stampTransaction(t.id, ref.id, "lock"));
  const stamped = await txCol().where("settlementId", "==", ref.id).get();
  let cnt = 0;
  let gross = 0;
  let share = 0;
  let held = 0;
  for (const t of stamped.docs) {
    const f = txFacts(t.data());
    const settled = Number(t.get("settledShare") ?? 0);
    const h = heldStoreShare(f);
    share += settled;
    held += h;
    if (settled > 0 || h > 0) {
      cnt += 1;
      gross += netSalesFigures({ ...f, operatorShare: Number(t.get("operatorShare")) }).gross;
    }
  }
  await fsdb().runTransaction(async (tx) => {
    const cur = await tx.get(ref);
    // 未反映の調整（店舗×状態の等価条件だけ。単一項目のインデックスで動く）。古いものから反映し、上限を超えた分は次回に回す
    const adj = await tx.get(adjCol().where("storeId", "==", storeId).where("status", "==", "OPEN"));
    const siblings = await tx.get(fsdb().collection(C.settlements).where("storeId", "==", storeId));
    if (!cur.exists) throw new Error("settlement not found");
    if (cur.get("status") !== "UNPAID") throw new SettlementStateError("この精算は既に確定しています。画面を再読み込みしてください。");
    const older = siblings.docs.find((d) => d.get("status") === "UNPAID" && String(d.get("yearMonth")) < yearMonth);
    if (older) throw new SettlementStateError(`先に${String(older.get("yearMonth"))}の精算を確定してください（同じ店舗は古い月から確定します）。`);
    const open = adj.docs
      .filter((d) => d.get("status") === "OPEN")
      .sort((a, b) => (toDate(a.get("createdAt"))?.getTime() ?? 0) - (toDate(b.get("createdAt"))?.getTime() ?? 0) || a.id.localeCompare(b.id))
      .slice(0, MAX_ADJUSTMENTS_PER_LOCK);
    const r = applyAdjustments(share, open.map((d) => Number(d.get("amount"))));
    const now = new Date();
    tx.update(ref, {
      status,
      note: note.slice(0, 1000),
      paidAt: status === "PAID" ? now : null,
      lockedAt: now,
      transactionCount: cnt,
      grossSales: gross,
      storeShare: share,
      heldShare: held,
      adjustmentTotal: r.adjustmentTotal,
      carryOver: r.carryOver,
      payableAmount: r.payable,
      appliedAdjustmentIds: open.map((d) => d.id),
      updatedAt: FieldValue.serverTimestamp(),
    });
    for (const d of open) tx.update(d.ref, { status: "APPLIED", appliedSettlementId: ref.id, appliedAt: now });
    if (r.carryOver < 0) {
      tx.create(adjCol().doc(`carry_${ref.id}`), {
        storeId,
        transactionId: null,
        paymentProvider: null,
        providerPaymentId: null,
        stripeChargeId: null,
        yearMonth,
        amount: r.carryOver,
        reason: "carryover",
        status: "OPEN",
        sourceSettlementId: ref.id,
        appliedSettlementId: null,
        appliedAt: null,
        livemode: true,
        detail: `${yearMonth}の精算で差し引ききれなかった調整`,
        createdAt: FieldValue.serverTimestamp(),
      });
    }
    await writeAudit(
      {
        actorUserId: actor.userId,
        actorRole: actor.role,
        action: "settlement.status",
        targetType: "settlement",
        targetId: ref.id,
        storeId,
        before: { status: "UNPAID", note: String(cur.get("note") ?? "") },
        after: { status, note, storeShare: share, heldShare: held, adjustmentTotal: r.adjustmentTotal, payableAmount: r.payable, carryOver: r.carryOver, adjustments: open.length },
      },
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
