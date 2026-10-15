import "server-only";
import { and, eq, inArray, sql } from "drizzle-orm";
import { Timestamp } from "firebase-admin/firestore";
import { isFirestore } from "@/lib/data-provider";
import { db } from "@/lib/db";
import { auditLogs, testFortuneLogs } from "@/lib/db/schema";
import { jstMonthRange, jstYearMonth } from "@/lib/time";
import { TEST_STORE, LEGACY_TEST_STORE_CODE } from "./test-store";

/**
 * 無料テストモードの利用件数（表示専用）。
 * 既存のテスト専用記録（test_fortune_logs / testFortuneLogs）を数えるだけで、データ構造は変えない。
 * 決済履歴（transactions）とは別の記録なので、有料の利用件数・売上・取り分には一切入らない。
 *
 * テスト記録は「店舗コード」で残っているため、QR を再発行した店舗は監査ログ（store.qr.reissue）から
 * 以前のコードも集めて合算する（再発行前のテスト利用も、その店舗の件数として数える）。
 */

export type TestUsage = { thisMonth: number; total: number };

/** 店舗の現在と過去の店舗コード（QR 再発行の監査ログから） */
export async function storeCodeHistory(storeId: string, currentCode: string): Promise<string[]> {
  const codes = new Set([currentCode]);
  if (isFirestore()) {
    const { C, fsdb } = await import("@/lib/firestore/admin");
    const snap = await fsdb().collection(C.auditLogs).where("storeId", "==", storeId).select("action", "before").get();
    for (const d of snap.docs) if (d.get("action") === "store.qr.reissue") addCode(codes, d.get("before"));
  } else {
    const rows = await db()
      .select({ before: auditLogs.before })
      .from(auditLogs)
      .where(and(eq(auditLogs.storeId, storeId), eq(auditLogs.action, "store.qr.reissue")));
    for (const r of rows) addCode(codes, r.before);
  }
  return [...codes];
}

function addCode(codes: Set<string>, before: unknown) {
  const code = (before as { storeCode?: unknown } | null)?.storeCode;
  if (typeof code === "string" && code) codes.add(code);
}

/** 指定した店舗コード（現在＋過去）の無料テスト利用件数 */
export async function testUsageForCodes(codes: string[], now = new Date()): Promise<TestUsage> {
  const monthStart = jstMonthRange(jstYearMonth(now)).start;
  if (!codes.length) return { thisMonth: 0, total: 0 };
  if (isFirestore()) {
    const { C, fsdb } = await import("@/lib/firestore/admin");
    let thisMonth = 0;
    let total = 0;
    // 店舗コードの等価条件だけで読み、月の判定はサーバー側で行う（複合インデックス不要）
    for (const code of codes) {
      const snap = await fsdb().collection(C.testFortuneLogs).where("storeCode", "==", code).select("createdAt").get();
      for (const d of snap.docs) {
        total += 1;
        const at = d.get("createdAt") as Timestamp | null;
        if (at && at.toDate() >= monthStart) thisMonth += 1;
      }
    }
    return { thisMonth, total };
  }
  const [r] = await db()
    .select({
      total: sql<number>`count(*)::int`,
      thisMonth: sql<number>`count(*) filter (where ${testFortuneLogs.createdAt} >= ${monthStart})::int`,
    })
    .from(testFortuneLogs)
    .where(inArray(testFortuneLogs.storeCode, codes));
  return { thisMonth: Number(r?.thisMonth ?? 0), total: Number(r?.total ?? 0) };
}

/** 1店舗の無料テスト利用件数（QR 再発行前のコードの分も含む） */
export async function testUsageForStore(store: { id: string; storeCode: string }, now = new Date()): Promise<TestUsage> {
  return testUsageForCodes(await storeCodeHistory(store.id, store.storeCode), now);
}

/** 全体の無料テスト利用件数（運営ダッシュボード用）。うちテスト店舗（/s/test）の分も返す */
export async function testUsageOverall(now = new Date()): Promise<TestUsage & { testStore: TestUsage }> {
  const monthStart = jstMonthRange(jstYearMonth(now)).start;
  const testStore = await testUsageForCodes([TEST_STORE.storeCode, LEGACY_TEST_STORE_CODE], now);
  if (isFirestore()) {
    const { C, fsdb } = await import("@/lib/firestore/admin");
    const col = fsdb().collection(C.testFortuneLogs);
    // 件数だけ（count 集計は本番 Firestore でも動作確認済み。1つの条件だけなので複合インデックス不要）
    const [total, month] = await Promise.all([col.count().get(), col.where("createdAt", ">=", Timestamp.fromDate(monthStart)).count().get()]);
    return { total: Number(total.data().count), thisMonth: Number(month.data().count), testStore };
  }
  const [r] = await db()
    .select({ total: sql<number>`count(*)::int`, thisMonth: sql<number>`count(*) filter (where ${testFortuneLogs.createdAt} >= ${monthStart})::int` })
    .from(testFortuneLogs);
  return { total: Number(r?.total ?? 0), thisMonth: Number(r?.thisMonth ?? 0), testStore };
}
