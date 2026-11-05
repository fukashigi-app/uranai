import "server-only";
import { FieldValue, Timestamp, type QueryDocumentSnapshot } from "firebase-admin/firestore";
import type { FortuneTypeValue } from "@/lib/db/schema";
import { sha256Hex } from "@/lib/security/crypto";
import { C, fsdb, inBatches, mustDate, toDate } from "./admin";

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

/**
 * テストモードの利用記録（売上とは別のコレクション。個人情報は保存しない）。
 * 開発モードの記録にだけ mode: "development" を付ける（既存の記録・項目は変更しない）。
 */
export async function logTestFortune(storeCode: string, type: FortuneTypeValue, mode?: "development"): Promise<void> {
  await fsdb()
    .collection(C.testFortuneLogs)
    .add({ storeCode: storeCode.slice(0, 32), fortuneType: type, ...(mode ? { mode } : {}), createdAt: FieldValue.serverTimestamp() });
}

/**
 * 定期メンテナンスの件数・時間の上限（後ろの段階の Webhook の復旧・再確認の時間を使い切らないように）。
 *  - 処理ごとに、最大 MAINTENANCE_MAX_SCAN_PER_TASK 件まで、MAINTENANCE_PAGE_SIZE 件ずつ読む
 *  - 開始から MAINTENANCE_DEADLINE_MS を過ぎたら、新しいページを読まずに終える（残りは次の定期処理で処理する）
 *  - 上限で打ち切った処理の数を truncatedTasks に返す（記録と応答に残る。0 なら全件を処理した）
 */
export const MAINTENANCE_PAGE_SIZE = 300;
export const MAINTENANCE_MAX_SCAN_PER_TASK = 3000;
export const MAINTENANCE_DEADLINE_MS = 60 * 1000;

export type MaintenanceLimits = { pageSize: number; maxScanPerTask: number; deadlineMs: number };

/**
 * 定期メンテナンス（期限切れ処理・不要データの削除）。PostgreSQL 版と同じ内容（対象の条件は変えない）。
 * 読み込みは「日時の項目 < 区切り」を新しい順に（単一の項目のインデックスだけで動く。複合インデックスは不要）。
 * 新しい順なので、件数・時間の上限で打ち切っても、直近に期限が来たもの（毎日の定期処理で新しく対象になるもの）から処理する。
 */
export async function runMaintenance(limits: Partial<MaintenanceLimits> = {}, clock: () => number = Date.now) {
  const L: MaintenanceLimits = { pageSize: MAINTENANCE_PAGE_SIZE, maxScanPerTask: MAINTENANCE_MAX_SCAN_PER_TASK, deadlineMs: MAINTENANCE_DEADLINE_MS, ...limits };
  const db = fsdb();
  const now = new Date();
  const t0 = clock();
  const timeUp = () => clock() - t0 >= L.deadlineMs;
  const ts = (d: Date) => Timestamp.fromDate(d);
  let truncatedTasks = 0;

  /** collection の field < cut を新しい順にページで読み、onPage で処理する。上限で打ち切ったら truncatedTasks を数える */
  async function scan(collection: string, field: string, cut: Date, onPage: (docs: QueryDocumentSnapshot[]) => Promise<void>): Promise<void> {
    let cursor: QueryDocumentSnapshot | null = null;
    let scanned = 0;
    for (;;) {
      if (timeUp() || scanned >= L.maxScanPerTask) {
        truncatedTasks++;
        return;
      }
      let q = db.collection(collection).where(field, "<", ts(cut)).orderBy(field, "desc").limit(Math.min(L.pageSize, L.maxScanPerTask - scanned));
      if (cursor) q = q.startAfter(cursor);
      const snap = await q.get();
      if (snap.empty) return;
      await onPage(snap.docs);
      scanned += snap.size;
      cursor = snap.docs[snap.docs.length - 1];
      if (snap.size < L.pageSize && scanned < L.maxScanPerTask) return;
    }
  }

  // 期限切れの占い権利
  let expiredSessions = 0;
  await scan(C.fortuneSessions, "expiresAt", now, async (docs) => {
    const sessions = docs.filter((d) => d.get("status") === "PAID");
    expiredSessions += sessions.length;
    await inBatches(sessions, (b, d) => {
      b.update(d.ref, { status: "EXPIRED" });
      b.update(db.collection(C.transactions).doc(String(d.get("transactionId"))), { fortuneStatus: "EXPIRED" });
    });
  });

  // 期限切れの注文（未払いの CREATED・FAILED だけ。返金済み・チャージバックの REFUNDED は決済記録があるので上書きしない）
  let expiredCheckouts = 0;
  await scan(C.checkouts, "expiresAt", now, async (docs) => {
    const expired = docs.filter((d) => ["CREATED", "FAILED"].includes(d.get("status")));
    expiredCheckouts += expired.length;
    await inBatches(expired, (b, d) => b.update(d.ref, { status: "EXPIRED", updatedAt: FieldValue.serverTimestamp() }));
  });

  // 課金されたか不明なまま放置された処理中（Charge IDなし）。処理中の注文は少ないので、上限の件数まで1回で読む
  const staleCut = new Date(now.getTime() - 15 * 60 * 1000);
  if (timeUp()) truncatedTasks++;
  else {
    const processing = await db.collection(C.checkouts).where("status", "==", "PROCESSING").limit(L.maxScanPerTask).get();
    if (processing.size >= L.maxScanPerTask) truncatedTasks++;
    const stale = processing.docs.filter((d) => !d.get("providerPaymentId") && mustDate(d.get("processingStartedAt")) < staleCut);
    await inBatches(stale, (b, d) => b.update(d.ref, { status: "FAILED", failureCode: "stale_processing", updatedAt: FieldValue.serverTimestamp() }));
  }

  // プライバシー: 結果本文は30日、未決済の注文は7日で削除
  let purgedResults = 0;
  await scan(C.fortuneResults, "createdAt", new Date(now.getTime() - 30 * 86_400_000), async (docs) => {
    purgedResults += docs.length;
    await inBatches(docs, (b, d) => b.delete(d.ref));
  });
  let purgedCheckouts = 0;
  await scan(C.checkouts, "createdAt", new Date(now.getTime() - 7 * 86_400_000), async (docs) => {
    const old = docs.filter((d) => ["EXPIRED", "FAILED", "CREATED"].includes(d.get("status")) && !d.get("providerPaymentId"));
    purgedCheckouts += old.length;
    await inBatches(old, (b, d) => b.delete(d.ref));
  });

  await scan(C.authSessions, "expiresAt", now, (docs) => inBatches(docs, (b, d) => b.delete(d.ref)));
  await scan(C.webhookEvents, "createdAt", new Date(now.getTime() - 90 * 86_400_000), (docs) =>
    inBatches(
      docs.filter((d) => d.get("processedAt")),
      (b, d) => b.delete(d.ref),
    ),
  );
  await scan(C.rateLimits, "windowStart", new Date(now.getTime() - 86_400_000), (docs) => inBatches(docs, (b, d) => b.delete(d.ref)));

  return { expiredSessions, expiredCheckouts, purgedResults, purgedCheckouts, truncatedTasks };
}

/** 接続確認（/api/health）。読み取り1回のみ */
export async function ping(): Promise<string> {
  await fsdb().collection(C.stores).limit(1).get();
  return "ok";
}

// ---------- 定期処理の実行記録（system/maintenance。成功・失敗・最終実行時刻だけ。秘密情報は保存しない） ----------

export type MaintenanceRun = { ok: true; result: Record<string, number> } | { ok: false; errorCode: string };

export async function recordMaintenanceRun(run: MaintenanceRun, startedAt: Date, finishedAt: Date): Promise<void> {
  const ref = fsdb().collection(C.system).doc("maintenance");
  const common = { lastRunAt: finishedAt, lastDurationMs: finishedAt.getTime() - startedAt.getTime(), updatedAt: FieldValue.serverTimestamp() };
  if (run.ok) await ref.set({ ...common, lastStatus: "success", lastSuccessAt: finishedAt, lastResult: run.result, lastErrorCode: null }, { merge: true });
  else await ref.set({ ...common, lastStatus: "failure", lastFailureAt: finishedAt, lastErrorCode: run.errorCode.slice(0, 80) }, { merge: true });
}

export async function getMaintenanceStatus(): Promise<{ lastRunAt: Date | null; lastStatus: string | null; lastSuccessAt: Date | null; lastFailureAt: Date | null; lastErrorCode: string | null }> {
  const d = await fsdb().collection(C.system).doc("maintenance").get();
  return {
    lastRunAt: toDate(d.get("lastRunAt")),
    lastStatus: (d.get("lastStatus") as string | undefined) ?? null,
    lastSuccessAt: toDate(d.get("lastSuccessAt")),
    lastFailureAt: toDate(d.get("lastFailureAt")),
    lastErrorCode: (d.get("lastErrorCode") as string | undefined) ?? null,
  };
}
