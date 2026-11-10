import "server-only";
import { FieldPath, FieldValue, Timestamp, type QueryDocumentSnapshot, type WriteBatch } from "firebase-admin/firestore";
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
    const used = Number(cur.get("count") ?? 0);
    // すでに上限に達している：書き込まずに拒否する（大量のアクセスで無料枠の書き込みを使い切らないように）。
    // 回数は上限のまま残り、時間枠（ドキュメントID）・期限（expireAt）は変えない。読み取りだけのトランザクションとして終わる
    if (used >= limit) return used + 1;
    tx.set(ref, { count: used + 1, windowStart: new Date(windowStart), expireAt: new Date(windowStart + windowMs + 86_400_000) });
    return used + 1;
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
 *  - 処理は3つのまとまりに分け、この順に実行する。まとまりごとに、開始からの締め切りがある（前のまとまりが時間を使い切らない）
 *      privacy      … 保存期間の削除（占い結果30日・未決済の注文7日・期限切れのログイン）。最優先で、開始から PRIVACY まで
 *      state        … 状態の更新（課金不明の処理中15分・期限切れの占い権利・期限切れの注文）。開始から STATE まで
 *      housekeeping … 不要な記録の削除（処理済みの通知90日・アクセス回数1日）。開始から DEADLINE まで
 *  - 中止の合図（定期処理の時間切れ）があれば、次のページ・次の書き込みを始めない（書き込み中のまとまりは壊さない）
 */
export const MAINTENANCE_PAGE_SIZE = 300;
export const MAINTENANCE_MAX_SCAN_PER_TASK = 3000;
/** 条件で絞る処理で、最初に新しい順に読む件数（直近に対象になったものを先に処理する。残りは続きの位置から古い順に読む） */
export const MAINTENANCE_HEAD_SCAN_PER_TASK = 1000;
export const MAINTENANCE_PRIVACY_UNTIL_MS = 30 * 1000;
export const MAINTENANCE_STATE_UNTIL_MS = 50 * 1000;
export const MAINTENANCE_DEADLINE_MS = 60 * 1000;

export type MaintenanceLimits = { pageSize: number; maxScanPerTask: number; headScanPerTask: number; privacyUntilMs: number; stateUntilMs: number; deadlineMs: number };

/** 処理ごとの結果（system/maintenanceTasks に記録。件数・打ち切り・残りの有無だけ） */
/**
 * 処理ごとの結果（system/maintenanceTasks に記録。件数・打ち切り・残りの有無だけ）。
 *  stoppedBy   … 途中で止まった理由：time（時間の上限）・aborted（中止の合図）・cap（件数の上限）・null（最後まで読んだ）。
 *                条件で絞る処理の「新しい順の読み込みの上限」は毎回の通常の区切りなので、ここには記録しない（続きの位置から読む）
 *  overdueFound … 未決済の注文の削除だけ：保存期間（7日）と定期処理の間隔（1日）と時刻のずれ（2時間）を過ぎてなお残っていた、
 *                削除の対象の注文の件数（この回に読んだ記録で数えた実数。読んでいない記録は数えない＝推測しない）
 */
export type MaintenanceTaskStat = {
  task: string;
  scanned: number;
  processed: number;
  conflicts: number;
  truncated: boolean;
  hasMore: boolean;
  stoppedBy: "time" | "aborted" | "cap" | null;
  overdueFound: number;
};

/** 未決済の注文が「削除が遅れている」とみなす経過時間（保存期間7日＋定期処理の間隔1日＋時刻のずれ2時間） */
export const CHECKOUT_PURGE_OVERDUE_MS = (7 * 24 + 24 + 2) * 3_600_000;

const cursorsRef = () => fsdb().collection(C.system).doc("maintenanceCursors");
const tasksRef = () => fsdb().collection(C.system).doc("maintenanceTasks");

/** Firestore の事前条件の不一致（読んだ後に更新・削除された）か */
const isPreconditionFailure = (e: unknown) => {
  const code = (e as { code?: unknown })?.code;
  return code === 9 || code === 5 || code === "failed-precondition" || code === "not-found";
};

/**
 * 定期メンテナンス（期限切れ処理・不要データの削除）。PostgreSQL 版と同じ内容（対象の条件・保存期間は変えない）。
 *
 * 取り残しの防止：
 *  - すべてが対象の削除（占い結果・ログイン・アクセス回数）は古い順に読む。消した分は次から読まないので、上限で打ち切っても次の回に続きを処理する
 *  - 条件で絞る処理（決済済みの注文・使用済みの権利など、対象外の記録が残る）は、①新しい順に一定の件数（直近に対象になったもの）と、
 *    ②続きの位置（system/maintenanceCursors）から古い順に残りの件数を読む。②は最後まで読んだら最初に戻るので、すべての記録をいずれ読む
 * 競合の防止：
 *  - 状態の更新・注文の削除は、読んだときの更新の時刻を事前条件にする（読んだ後に Webhook の確定・返金などで変わった記録は書き込まない）。
 *    期限切れの占い権利は、トランザクションの中で状態（PAID・期限）を確かめ直してから更新する。競合した記録は次の回に回す（conflicts に数える）
 * 単一の項目のインデックスだけで動く（複合インデックス・TTL の設定は不要）。
 */
export async function runMaintenance(limits: Partial<MaintenanceLimits> = {}, clock: () => number = Date.now, signal?: AbortSignal) {
  const L: MaintenanceLimits = {
    pageSize: MAINTENANCE_PAGE_SIZE,
    maxScanPerTask: MAINTENANCE_MAX_SCAN_PER_TASK,
    headScanPerTask: MAINTENANCE_HEAD_SCAN_PER_TASK,
    privacyUntilMs: MAINTENANCE_PRIVACY_UNTIL_MS,
    stateUntilMs: MAINTENANCE_STATE_UNTIL_MS,
    deadlineMs: MAINTENANCE_DEADLINE_MS,
    ...limits,
  };
  const db = fsdb();
  const now = new Date();
  const t0 = clock();
  const ts = (d: Date) => Timestamp.fromDate(d);
  let untilMs = L.privacyUntilMs;
  const stop = () => signal?.aborted === true || clock() - t0 >= Math.min(untilMs, L.deadlineMs);
  const stats: MaintenanceTaskStat[] = [];
  const savedCursors = ((await cursorsRef().get()).data() ?? {}) as Record<string, { at?: Timestamp; id?: string } | null>;
  const nextCursors: Record<string, { at: Timestamp; id: string } | null> = {};

  /** 1つの処理を、上限・締め切り・中止の合図の中で読む。onPage は処理した件数と競合の件数を返す */
  type PageFn = (docs: QueryDocumentSnapshot[]) => Promise<{ processed: number; conflicts: number }>;
  async function scanRange(
    st: MaintenanceTaskStat,
    o: { collection: string; field: string; cut: Date; dir: "asc" | "desc"; cap: number; after?: { at: Timestamp; id: string } | null; onPage: PageFn },
  ): Promise<{ reachedEnd: boolean; last: QueryDocumentSnapshot | null }> {
    let scanned = 0;
    let last: QueryDocumentSnapshot | null = null;
    for (;;) {
      if (stop() || scanned >= o.cap) {
        st.truncated = true;
        if (stop()) st.stoppedBy = signal?.aborted ? "aborted" : "time";
        else if (!st.stoppedBy) st.stoppedBy = "cap";
        return { reachedEnd: false, last };
      }
      let q = db.collection(o.collection).where(o.field, "<", ts(o.cut)).orderBy(o.field, o.dir).orderBy(FieldPath.documentId(), o.dir).limit(Math.min(L.pageSize, o.cap - scanned));
      if (last) q = q.startAfter(last);
      else if (o.after?.at && o.after.id) q = q.startAfter(o.after.at, o.after.id);
      const snap = await q.get();
      if (snap.empty) return { reachedEnd: true, last };
      const r = await o.onPage(snap.docs);
      st.scanned += snap.size;
      st.processed += r.processed;
      st.conflicts += r.conflicts;
      scanned += snap.size;
      last = snap.docs[snap.docs.length - 1];
      if (snap.size < Math.min(L.pageSize, o.cap - (scanned - snap.size))) return { reachedEnd: true, last };
    }
  }

  /** すべてが対象の削除：古い順。打ち切ったら残りがある（次の回は残りの古いものから） */
  async function allMatch(task: string, collection: string, field: string, cut: Date, onPage: PageFn) {
    const st: MaintenanceTaskStat = { task, scanned: 0, processed: 0, conflicts: 0, truncated: false, hasMore: false, stoppedBy: null, overdueFound: 0 };
    stats.push(st);
    const r = await scanRange(st, { collection, field, cut, dir: "asc", cap: L.maxScanPerTask, onPage });
    st.hasMore = !r.reachedEnd;
    return st;
  }

  /** 条件で絞る処理：新しい順に一定の件数 → 続きの位置から古い順に残りの件数（最後まで読んだら次の回は最初から） */
  async function filtered(task: string, collection: string, field: string, cut: Date, onPage: PageFn) {
    const st: MaintenanceTaskStat = { task, scanned: 0, processed: 0, conflicts: 0, truncated: false, hasMore: false, stoppedBy: null, overdueFound: 0 };
    stats.push(st);
    const headCap = Math.min(L.headScanPerTask, L.maxScanPerTask);
    const head = await scanRange(st, { collection, field, cut, dir: "desc", cap: headCap, onPage });
    if (head.reachedEnd) {
      // 新しい順で最後まで読めた：対象の範囲はすべて読んだ。続きの位置は最初に戻す
      st.truncated = false;
      nextCursors[task] = null;
      return st;
    }
    st.truncated = false;
    // 新しい順の読み込みが件数の上限で区切られたのは通常のこと（続きは古い順の読み込みで読む）：打ち切りの理由にしない
    if (st.stoppedBy === "cap") st.stoppedBy = null;
    const saved = savedCursors[task];
    const after = saved?.at && saved.id ? { at: saved.at, id: saved.id } : null;
    const sweep = await scanRange(st, { collection, field, cut, dir: "asc", cap: L.maxScanPerTask - headCap, after, onPage });
    if (sweep.reachedEnd) nextCursors[task] = null; // 最後まで読んだ：次の回は最初から
    else if (sweep.last) nextCursors[task] = { at: sweep.last.get(field) as Timestamp, id: sweep.last.id };
    else nextCursors[task] = after; // 何も読めなかった（締め切り）：位置はそのまま
    st.hasMore = true; // 条件に合わない記録が残る範囲：一周するまで、読んでいない記録がある
    return st;
  }

  /** 読んだときの更新の時刻を事前条件にして書き込む（変わっていた記録は書き込まない） */
  async function writeIfUnchanged(docs: QueryDocumentSnapshot[], op: (b: WriteBatch, d: QueryDocumentSnapshot) => void, single: (d: QueryDocumentSnapshot) => Promise<unknown>) {
    let processed = 0;
    let conflicts = 0;
    for (let i = 0; i < docs.length; i += 400) {
      if (signal?.aborted) break; // 中止：次のまとまりを始めない（書き込み済みのまとまりはそのまま）
      const chunk = docs.slice(i, i + 400);
      const b = db.batch();
      for (const d of chunk) op(b, d);
      try {
        await b.commit();
        processed += chunk.length;
      } catch (e) {
        if (!isPreconditionFailure(e)) throw e;
        // まとまりの中に変わった記録がある：1件ずつ書き込み、変わったものだけを残す
        for (const d of chunk) {
          try {
            await single(d);
            processed++;
          } catch (e2) {
            if (!isPreconditionFailure(e2)) throw e2;
            conflicts++;
          }
        }
      }
    }
    return { processed, conflicts };
  }
  const deleteIfUnchanged = (docs: QueryDocumentSnapshot[]) =>
    writeIfUnchanged(
      docs,
      (b, d) => b.delete(d.ref, { lastUpdateTime: d.updateTime }),
      (d) => d.ref.delete({ lastUpdateTime: d.updateTime }),
    );
  const updateIfUnchanged = (docs: QueryDocumentSnapshot[], data: Record<string, unknown>) =>
    writeIfUnchanged(
      docs,
      (b, d) => b.update(d.ref, data, { lastUpdateTime: d.updateTime }),
      (d) => d.ref.update(data, { lastUpdateTime: d.updateTime }),
    );
  const deleteAll = async (docs: QueryDocumentSnapshot[]) => {
    await inBatches(docs, (b, d) => b.delete(d.ref));
    return { processed: docs.length, conflicts: 0 };
  };

  // ===== privacy：保存期間の削除（最優先） =====
  // 占い結果の本文は30日
  const results = await allMatch("purgeResults", C.fortuneResults, "createdAt", new Date(now.getTime() - 30 * 86_400_000), deleteAll);
  // 未決済の注文は7日（決済済み・処理中のものは残す。読んだ後に決済が紐付いた注文は消さない）
  // 削除が遅れていた注文（保存期間＋間隔＋ずれを過ぎて残っていた、削除の対象の注文）は、読んだ範囲で実数を数える
  let overdueCheckouts = 0;
  const overdueCut = now.getTime() - CHECKOUT_PURGE_OVERDUE_MS;
  const oldCheckouts = await filtered("purgeCheckouts", C.checkouts, "createdAt", new Date(now.getTime() - 7 * 86_400_000), (docs) => {
    const targets = docs.filter((d) => ["EXPIRED", "FAILED", "CREATED"].includes(d.get("status")) && !d.get("providerPaymentId"));
    overdueCheckouts += targets.filter((d) => (toDate(d.get("createdAt"))?.getTime() ?? Infinity) < overdueCut).length;
    return deleteIfUnchanged(targets);
  });
  oldCheckouts.overdueFound = overdueCheckouts;
  // 期限切れのログイン
  await allMatch("purgeAuthSessions", C.authSessions, "expiresAt", now, deleteAll);

  // ===== state：状態の更新 =====
  untilMs = L.stateUntilMs;
  // 課金されたか不明なまま放置された処理中（Charge IDなし）。処理中の注文は少ないので、上限の件数まで1回で読む
  {
    const st: MaintenanceTaskStat = { task: "failStaleProcessing", scanned: 0, processed: 0, conflicts: 0, truncated: false, hasMore: false, stoppedBy: null, overdueFound: 0 };
    stats.push(st);
    if (stop()) {
      st.truncated = st.hasMore = true;
      st.stoppedBy = signal?.aborted ? "aborted" : "time";
    }
    else {
      const staleCut = new Date(now.getTime() - 15 * 60 * 1000);
      const processing = await db.collection(C.checkouts).where("status", "==", "PROCESSING").limit(L.maxScanPerTask).get();
      st.scanned = processing.size;
      if (processing.size >= L.maxScanPerTask) {
        st.truncated = st.hasMore = true;
        st.stoppedBy = "cap";
      }
      const stale = processing.docs.filter((d) => !d.get("providerPaymentId") && mustDate(d.get("processingStartedAt")) < staleCut);
      const r = await updateIfUnchanged(stale, { status: "FAILED", failureCode: "stale_processing", updatedAt: FieldValue.serverTimestamp() });
      st.processed = r.processed;
      st.conflicts = r.conflicts;
    }
  }
  // 期限切れの占い権利（PAID だけ）。トランザクションの中で状態と期限を確かめ直す（返金で止めた権利・使用済みの権利は変えない）
  const sessions = await filtered("expireSessions", C.fortuneSessions, "expiresAt", now, async (docs) => {
    let processed = 0;
    let conflicts = 0;
    const cands = docs.filter((d) => d.get("status") === "PAID");
    for (let i = 0; i < cands.length; i += 10) {
      if (signal?.aborted) break;
      const rs = await Promise.all(
        cands.slice(i, i + 10).map((d) =>
          db.runTransaction(async (tx) => {
            const cur = await tx.get(d.ref);
            const exp = cur.exists ? toDate(cur.get("expiresAt")) : null;
            if (!cur.exists || cur.get("status") !== "PAID" || !exp || exp >= now) return false;
            const txRef = db.collection(C.transactions).doc(String(cur.get("transactionId")));
            const t = await tx.get(txRef);
            tx.update(d.ref, { status: "EXPIRED" });
            if (t.exists) tx.update(txRef, { fortuneStatus: "EXPIRED" });
            return true;
          }),
        ),
      );
      for (const ok of rs) {
        if (ok) processed++;
        else conflicts++;
      }
    }
    return { processed, conflicts };
  });
  // 期限切れの注文（未払いの CREATED・FAILED だけ。返金済み・チャージバックの REFUNDED は決済記録があるので上書きしない）
  const checkouts = await filtered("expireCheckouts", C.checkouts, "expiresAt", now, (docs) =>
    updateIfUnchanged(
      docs.filter((d) => ["CREATED", "FAILED"].includes(d.get("status"))),
      { status: "EXPIRED", updatedAt: FieldValue.serverTimestamp() },
    ),
  );

  // ===== housekeeping：不要な記録の削除 =====
  untilMs = L.deadlineMs;
  await filtered("purgeWebhookEvents", C.webhookEvents, "createdAt", new Date(now.getTime() - 90 * 86_400_000), (docs) => deleteIfUnchanged(docs.filter((d) => d.get("processedAt"))));
  await allMatch("purgeRateLimits", C.rateLimits, "windowStart", new Date(now.getTime() - 86_400_000), deleteAll);

  // 続きの位置と、処理ごとの結果を記録する（失敗してもメンテナンスの結果は変えない）
  try {
    const merged = { ...savedCursors, ...nextCursors };
    await cursorsRef().set({ ...merged, updatedAt: FieldValue.serverTimestamp() });
    await tasksRef().set({ lastTasks: stats, lastRunAt: new Date(), updatedAt: FieldValue.serverTimestamp() });
  } catch (e) {
    console.error("[maintenance] failed to record cursors or task stats", { error: (e as Error)?.name });
  }

  return {
    expiredSessions: sessions.processed,
    expiredCheckouts: checkouts.processed,
    purgedResults: results.processed,
    purgedCheckouts: oldCheckouts.processed,
    truncatedTasks: stats.filter((t) => t.truncated).length,
    tasksWithRemaining: stats.filter((t) => t.hasMore && t.truncated).length,
    conflictsSkipped: stats.reduce((a, t) => a + t.conflicts, 0),
  };
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
