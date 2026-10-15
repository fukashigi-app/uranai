import "server-only";
import { and, desc, eq, gte } from "drizzle-orm";
import { isFirestore } from "@/lib/data-provider";
import { db } from "@/lib/db";
import { auditLogs } from "@/lib/db/schema";

/**
 * 振込先（銀行口座）の登録・変更の履歴（運営の精算画面の警告用）。
 * 既存の監査ログ（action = "store.bank.update"）から作る。データ構造は変えない。
 *  - 変更前（before）が無い → 「新規登録」、ある → 「変更」
 * 口座番号・名義などの中身は返さない（店舗・日時・種類・操作した人の区分だけ）。
 */

export type BankChange = {
  storeId: string;
  kind: "new" | "change";
  at: Date;
  /** 誰が操作したか（店舗アカウント / 運営） */
  actorRole: "STORE" | "OPERATOR" | "SYSTEM";
};

/** 精算画面で警告を出す期間（日） */
export const BANK_CHANGE_WARNING_DAYS = 60;

export async function listRecentBankChanges(days = BANK_CHANGE_WARNING_DAYS, now = new Date()): Promise<BankChange[]> {
  const since = new Date(now.getTime() - days * 86_400_000);
  const toChange = (storeId: unknown, before: unknown, at: Date, actorRole: unknown): BankChange | null =>
    typeof storeId === "string" && storeId
      ? { storeId, kind: before ? "change" : "new", at, actorRole: actorRole === "STORE" || actorRole === "OPERATOR" ? actorRole : "SYSTEM" }
      : null;

  if (isFirestore()) {
    const { C, fsdb, toDate } = await import("@/lib/firestore/admin");
    // 1つの等価条件だけで読み、期間はサーバー側で判定（複合インデックス不要）
    const snap = await fsdb().collection(C.auditLogs).where("action", "==", "store.bank.update").select("storeId", "before", "createdAt", "actorRole").get();
    return snap.docs
      .map((d) => {
        const at = toDate(d.get("createdAt"));
        return at && at >= since ? toChange(d.get("storeId"), d.get("before"), at, d.get("actorRole")) : null;
      })
      .filter((x): x is BankChange => x !== null)
      .sort((a, b) => b.at.getTime() - a.at.getTime());
  }
  const rows = await db()
    .select({ storeId: auditLogs.storeId, before: auditLogs.before, at: auditLogs.createdAt, actorRole: auditLogs.actorRole })
    .from(auditLogs)
    .where(and(eq(auditLogs.action, "store.bank.update"), gte(auditLogs.createdAt, since)))
    .orderBy(desc(auditLogs.createdAt));
  return rows.map((r) => toChange(r.storeId, r.before, r.at, r.actorRole)).filter((x): x is BankChange => x !== null);
}
