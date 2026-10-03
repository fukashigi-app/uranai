import "server-only";
import { FieldValue, Timestamp } from "firebase-admin/firestore";
import type { FortuneTypeValue } from "@/lib/db/schema";
import { sha256Hex } from "@/lib/security/crypto";
import { C, fsdb, inBatches, mustDate } from "./admin";

/**
 * Rate Limit（固定時間枠）。rateLimits/{キーのハッシュ_枠の開始時刻}
 * expireAt を TTL ポリシーに設定すると Firestore が自動削除する（未設定でも定期メンテナンスで削除）。
 */
export async function rateLimit(key: string, limit: number, windowSec: number): Promise<boolean> {
  const windowMs = windowSec * 1000;
  const windowStart = Math.floor(Date.now() / windowMs) * windowMs;
  const ref = fsdb().collection(C.rateLimits).doc(`${sha256Hex(key).slice(0, 40)}_${windowStart}`);
  const count = await fsdb().runTransaction(async (tx) => {
    const cur = await tx.get(ref);
    const next = Number(cur.get("count") ?? 0) + 1;
    tx.set(ref, { count: next, windowStart: new Date(windowStart), expireAt: new Date(windowStart + windowMs + 86_400_000) });
    return next;
  });
  return count <= limit;
}

/** テストモードの利用記録（売上とは別のコレクション。個人情報は保存しない） */
export async function logTestFortune(storeCode: string, type: FortuneTypeValue): Promise<void> {
  await fsdb().collection(C.testFortuneLogs).add({ storeCode: storeCode.slice(0, 32), fortuneType: type, createdAt: FieldValue.serverTimestamp() });
}

/** 定期メンテナンス（期限切れ処理・不要データの削除）。PostgreSQL 版と同じ内容 */
export async function runMaintenance() {
  const db = fsdb();
  const now = new Date();
  const ts = (d: Date) => Timestamp.fromDate(d);

  // 期限切れの占い権利
  const sessions = (await db.collection(C.fortuneSessions).where("expiresAt", "<", ts(now)).get()).docs.filter((d) => d.get("status") === "PAID");
  await inBatches(sessions, (b, d) => {
    b.update(d.ref, { status: "EXPIRED" });
    b.update(db.collection(C.transactions).doc(String(d.get("transactionId"))), { fortuneStatus: "EXPIRED" });
  });

  // 期限切れの注文
  const expiredCheckouts = (await db.collection(C.checkouts).where("expiresAt", "<", ts(now)).get()).docs.filter((d) => ["CREATED", "FAILED"].includes(d.get("status")));
  await inBatches(expiredCheckouts, (b, d) => b.update(d.ref, { status: "EXPIRED", updatedAt: FieldValue.serverTimestamp() }));

  // 課金されたか不明なまま放置された処理中（Charge IDなし）
  const staleCut = new Date(now.getTime() - 15 * 60 * 1000);
  const stale = (await db.collection(C.checkouts).where("status", "==", "PROCESSING").get()).docs.filter(
    (d) => !d.get("providerPaymentId") && mustDate(d.get("processingStartedAt")) < staleCut,
  );
  await inBatches(stale, (b, d) => b.update(d.ref, { status: "FAILED", failureCode: "stale_processing", updatedAt: FieldValue.serverTimestamp() }));

  // プライバシー: 結果本文は30日、未決済の注文は7日で削除
  const results = (await db.collection(C.fortuneResults).where("createdAt", "<", ts(new Date(now.getTime() - 30 * 86_400_000))).get()).docs;
  await inBatches(results, (b, d) => b.delete(d.ref));
  const oldCheckouts = (await db.collection(C.checkouts).where("createdAt", "<", ts(new Date(now.getTime() - 7 * 86_400_000))).get()).docs.filter(
    (d) => ["EXPIRED", "FAILED", "CREATED"].includes(d.get("status")) && !d.get("providerPaymentId"),
  );
  await inBatches(oldCheckouts, (b, d) => b.delete(d.ref));

  const sessionsAuth = (await db.collection(C.authSessions).where("expiresAt", "<", ts(now)).get()).docs;
  await inBatches(sessionsAuth, (b, d) => b.delete(d.ref));
  const events = (await db.collection(C.webhookEvents).where("createdAt", "<", ts(new Date(now.getTime() - 90 * 86_400_000))).get()).docs.filter((d) => d.get("processedAt"));
  await inBatches(events, (b, d) => b.delete(d.ref));
  const limits = (await db.collection(C.rateLimits).where("windowStart", "<", ts(new Date(now.getTime() - 86_400_000))).get()).docs;
  await inBatches(limits, (b, d) => b.delete(d.ref));

  return { expiredSessions: sessions.length, expiredCheckouts: expiredCheckouts.length, purgedResults: results.length, purgedCheckouts: oldCheckouts.length };
}

/** 接続確認（/api/health）。読み取り1回のみ */
export async function ping(): Promise<string> {
  await fsdb().collection(C.stores).limit(1).get();
  return "ok";
}
