import "server-only";
import { FieldPath, FieldValue } from "firebase-admin/firestore";
import { C, fsdb, toDate } from "./admin";
import { randomUUID } from "node:crypto";
import {
  manualRecheckBlock,
  RECHECK_MANUAL_LEASE_MS,
  recheckRecoverySkipReason,
  type ManualRecheckBlock,
  type RecheckRecoveryCandidate,
  type RecheckRecoveryResult,
  type RecheckRecoverySkipReason,
} from "@/lib/payments/recheck-recovery-rules";

/**
 * 決済記録の再確認（recheckState=PENDING）の自動の回収の Firestore の読み書き（規則は payments/recheck-recovery-rules.ts）。
 *  - PENDING の決済記録は、文書の ID の順にページで読む（等号の条件だけなので、文書の ID の順は単一フィールドのインデックスで扱える）。
 *    続きの位置（最後に読んだ文書の ID）は system/recheckRecovery に保存し、次の実行はその次から読む（最後まで読んだら最初に戻る）。
 *    対象外の記録・上限で回せなかった記録が、同じ記録ばかり読まれて取り残されないようにするため
 *  - 自動の回収の回数・時刻・結果は、決済記録の recheckRecovery* に記録する（確定の処理の recheckAttempts とは別）。
 *    回数は Stripe API を呼ぶ前に、トランザクションで対象であることを確かめ直してから増やす（例外・打ち切りでも数える。
 *    同時に動いた別の実行は、前回の時刻が新しくなっているので同じ記録を試さない）
 */

const RUN_DOC = "recheckRecovery";
const txCol = () => fsdb().collection(C.transactions);

export type PendingRecheckDoc = { id: string; candidate: RecheckRecoveryCandidate };

const candidateOf = (get: (k: string) => unknown): RecheckRecoveryCandidate => ({
  paymentProvider: get("paymentProvider"),
  recheckState: get("recheckState"),
  livemode: get("livemode"),
  createdAt: toDate(get("createdAt")),
  recoveryAttempts: get("recheckRecoveryAttempts"),
  recoveryLastAt: toDate(get("recheckRecoveryLastAt")),
  sessionId: get("stripeCheckoutSessionId"),
  paymentIntentId: get("stripePaymentIntentId"),
  recoveryLastResult: get("recheckRecoveryLastResult"),
  manualUntil: toDate(get("recheckManualUntil")),
});

/** PENDING の決済記録を文書の ID の順に1ページ読む（afterId の次から。null なら最初から） */
export async function listPendingRecheckPage(afterId: string | null, pageSize: number): Promise<PendingRecheckDoc[]> {
  let q = txCol().where("recheckState", "==", "PENDING").orderBy(FieldPath.documentId()).limit(pageSize);
  if (afterId) q = q.startAfter(afterId);
  const snap = await q.get();
  return snap.docs.map((d) => ({ id: d.id, candidate: candidateOf((k) => d.get(k)) }));
}

export type RecheckRecoveryClaim =
  | { claimed: true; sessionId: string; paymentIntentId: string; attempt: number }
  | { claimed: false; reason: RecheckRecoverySkipReason | "missing" };

/**
 * 回収の試行を始める：トランザクションで最新の状態を読み直し、まだ対象なら回数を増やして時刻を記録する（Stripe API はここでは呼ばない）。
 * 決済記録が無くなっていた・対象でなくなっていた（別の処理が完了した・同時の実行が先に試した）なら試さない
 */
export async function claimRecheckRecovery(txId: string, now: Date, mode: "test" | "live", isSessionId: (v: unknown) => boolean): Promise<RecheckRecoveryClaim> {
  const ref = txCol().doc(txId);
  return fsdb().runTransaction(async (tx): Promise<RecheckRecoveryClaim> => {
    const d = await tx.get(ref);
    if (!d.exists) return { claimed: false, reason: "missing" };
    const c = candidateOf((k) => d.get(k));
    const skip = recheckRecoverySkipReason(c, now, mode, isSessionId);
    if (skip) return { claimed: false, reason: skip };
    const attempt = (typeof c.recoveryAttempts === "number" && c.recoveryAttempts > 0 ? c.recoveryAttempts : 0) + 1;
    tx.update(ref, { recheckRecoveryAttempts: attempt, recheckRecoveryLastAt: now, recheckRecoveryLastResult: "started", recheckRecoveryLastError: null });
    return { claimed: true, sessionId: String(c.sessionId), paymentIntentId: String(c.paymentIntentId), attempt };
  });
}

/** 回収の結果を決済記録に記録する（記録に失敗しても、回数は試行の前に記録済み。決済記録が無ければ何もしない） */
export async function recordRecheckRecoveryResult(txId: string, result: RecheckRecoveryResult, errorName: string | null): Promise<void> {
  try {
    await fsdb().runTransaction(async (tx) => {
      const ref = txCol().doc(txId);
      const d = await tx.get(ref);
      if (!d.exists) return;
      tx.update(ref, { recheckRecoveryLastResult: result, recheckRecoveryLastError: errorName && /^[\w.\-]{1,60}$/.test(errorName) ? errorName : errorName ? "Error" : null });
    });
  } catch (e) {
    console.error("[recheck-recovery] recording the result failed", { txId, error: (e as Error)?.name });
  }
}

export type RecheckRecoveryRunRecord = {
  startedAt: Date;
  finishedAt: Date;
  status: "completed" | "partial" | "failed";
  counts: Record<string, number>;
  /** 次の実行で読み始める位置（この文書の ID の次から。null なら最初から） */
  nextCursor: string | null;
  errorName: string | null;
};

/** 前回の実行が保存した続きの位置（無い・読めなければ最初から） */
export async function readRecheckRecoveryCursor(): Promise<string | null> {
  const d = await fsdb().collection(C.system).doc(RUN_DOC).get();
  const v = d.exists ? d.get("nextCursor") : null;
  // 文書の ID の形（決済記録の ID）でなければ最初から読む（壊れた値で毎回の読み込みが失敗し続けないように）
  return typeof v === "string" && /^[A-Za-z0-9_]{1,200}$/.test(v) ? v : null;
}

export async function recordRecheckRecoveryRun(run: RecheckRecoveryRunRecord): Promise<void> {
  try {
    await fsdb().collection(C.system).doc(RUN_DOC).set({ ...run, updatedAt: FieldValue.serverTimestamp() });
  } catch (e) {
    console.error("[recheck-recovery] recording the run failed", (e as Error)?.name);
  }
}

export async function readRecheckRecoveryRun(): Promise<RecheckRecoveryRunRecord | null> {
  const d = await fsdb().collection(C.system).doc(RUN_DOC).get();
  if (!d.exists) return null;
  const status = d.get("status");
  return {
    startedAt: toDate(d.get("startedAt")) ?? new Date(0),
    finishedAt: toDate(d.get("finishedAt")) ?? new Date(0),
    status: status === "completed" || status === "partial" || status === "failed" ? status : "failed",
    counts: (d.get("counts") ?? {}) as Record<string, number>,
    nextCursor: typeof d.get("nextCursor") === "string" ? d.get("nextCursor") : null,
    errorName: typeof d.get("errorName") === "string" ? d.get("errorName") : null,
  };
}

// ---------- 運営画面の一覧 ----------

/** 運営画面の一覧の1ページの件数の上限 */
export const PENDING_RECHECK_ADMIN_PAGE_MAX = 50;
const ERROR_NAME_RE = /^[\w.\-]{1,60}$/;
const nameOrNull = (v: unknown) => (typeof v === "string" && ERROR_NAME_RE.test(v) ? v : null);
const numOr0 = (v: unknown) => (typeof v === "number" && Number.isSafeInteger(v) && v > 0 ? v : 0);

export type PendingRecheckRow = {
  id: string;
  candidate: RecheckRecoveryCandidate;
  paidAt: Date | null;
  createdAt: Date | null;
  paymentStatus: string | null;
  storeId: string | null;
  livemode: boolean | null;
  /** 確定の処理の中の再確認の回数・最後の試行・エラー（recheckAttempts など） */
  recheckAttempts: number;
  recheckLastAttemptAt: Date | null;
  recheckLastError: string | null;
  /** 自動の回収の回数・最後の試行・結果・エラー */
  recoveryAttempts: number;
  recoveryLastAt: Date | null;
  recoveryLastResult: string | null;
  recoveryLastError: string | null;
  /** 運営の手動の再確認の最後の実行 */
  manualLastAt: Date | null;
  manualLastBy: string | null;
  manualLastResult: string | null;
};

/** PENDING の決済記録を文書の ID の順にページで読む（cursor の次から。pageSize は上限 PENDING_RECHECK_ADMIN_PAGE_MAX） */
export async function listPendingRechecksForAdmin(cursor: string | null, pageSize = 20): Promise<{ rows: PendingRecheckRow[]; nextCursor: string | null }> {
  const n = Math.max(1, Math.min(PENDING_RECHECK_ADMIN_PAGE_MAX, Math.floor(pageSize)));
  let q = txCol().where("recheckState", "==", "PENDING").orderBy(FieldPath.documentId()).limit(n + 1);
  if (cursor) q = q.startAfter(cursor);
  const snap = await q.get();
  const docs = snap.docs.slice(0, n);
  const rows = docs.map((d): PendingRecheckRow => {
    const get = (k: string) => d.get(k);
    return {
      id: d.id,
      candidate: candidateOf(get),
      paidAt: toDate(get("paidAt")),
      createdAt: toDate(get("createdAt")),
      paymentStatus: typeof get("paymentStatus") === "string" ? get("paymentStatus") : null,
      storeId: typeof get("storeId") === "string" ? get("storeId") : null,
      livemode: typeof get("livemode") === "boolean" ? get("livemode") : null,
      recheckAttempts: numOr0(get("recheckAttempts")),
      recheckLastAttemptAt: toDate(get("recheckLastAttemptAt")),
      recheckLastError: nameOrNull(get("recheckLastError")),
      recoveryAttempts: numOr0(get("recheckRecoveryAttempts")),
      recoveryLastAt: toDate(get("recheckRecoveryLastAt")),
      recoveryLastResult: nameOrNull(get("recheckRecoveryLastResult")),
      recoveryLastError: nameOrNull(get("recheckRecoveryLastError")),
      manualLastAt: toDate(get("recheckManualLastAt")),
      manualLastBy: typeof get("recheckManualLastBy") === "string" ? get("recheckManualLastBy") : null,
      manualLastResult: nameOrNull(get("recheckManualLastResult")),
    };
  });
  return { rows, nextCursor: snap.docs.length > n ? docs[docs.length - 1].id : null };
}

// ---------- 運営の手動の再確認 ----------

export type ManualRecheckSnapshot = { recheckState: string | null; paymentStatus: string | null; refundStatus: string | null; disputeStatus: string | null };
const snapshotOf = (get: (k: string) => unknown): ManualRecheckSnapshot => ({
  recheckState: nameOrNull(get("recheckState")),
  paymentStatus: nameOrNull(get("paymentStatus")),
  refundStatus: nameOrNull(get("refundStatus")),
  disputeStatus: nameOrNull(get("disputeStatus")),
});

export type ManualRecheckClaim =
  | { claimed: true; token: string; sessionId: string; paymentIntentId: string; storeId: string | null; before: ManualRecheckSnapshot }
  | { claimed: false; reason: ManualRecheckBlock | "missing" };

/**
 * 運営の手動の再確認を始める：トランザクションで最新の状態を読み直し、実行できるなら実行中の印（期限つき）と実行者・時刻を記録する
 * （Stripe API はここでは呼ばない）。同じ決済記録の手動の再確認・自動の回収が実行中なら始めない
 */
export async function claimManualRecheck(txId: string, now: Date, mode: "test" | "live", isSessionId: (v: unknown) => boolean, actorUserId: string): Promise<ManualRecheckClaim> {
  const ref = txCol().doc(txId);
  return fsdb().runTransaction(async (tx): Promise<ManualRecheckClaim> => {
    const d = await tx.get(ref);
    if (!d.exists) return { claimed: false, reason: "missing" };
    const get = (k: string) => d.get(k);
    const c = candidateOf(get);
    const block = manualRecheckBlock(c, now, mode, isSessionId);
    if (block) return { claimed: false, reason: block };
    const token = randomUUID();
    tx.update(ref, {
      recheckManualUntil: new Date(now.getTime() + RECHECK_MANUAL_LEASE_MS),
      recheckManualToken: token,
      recheckManualAttempts: numOr0(get("recheckManualAttempts")) + 1,
      recheckManualLastAt: now,
      recheckManualLastBy: actorUserId,
      recheckManualLastResult: "started",
      recheckManualLastError: null,
    });
    return { claimed: true, token, sessionId: String(c.sessionId), paymentIntentId: String(c.paymentIntentId), storeId: typeof get("storeId") === "string" ? get("storeId") : null, before: snapshotOf(get) };
  });
}

/** 手動の再確認を終える：結果を記録し、実行中の印を外す（自分の印のときだけ）。終わった後の状態を返す（監査ログ用） */
export async function finishManualRecheck(txId: string, token: string, result: RecheckRecoveryResult, errorName: string | null): Promise<ManualRecheckSnapshot | null> {
  try {
    return await fsdb().runTransaction(async (tx) => {
      const ref = txCol().doc(txId);
      const d = await tx.get(ref);
      if (!d.exists) return null;
      if (d.get("recheckManualToken") === token) {
        tx.update(ref, { recheckManualLastResult: result, recheckManualLastError: errorName ? (ERROR_NAME_RE.test(errorName) ? errorName : "Error") : null, recheckManualUntil: null, recheckManualToken: null });
      }
      return snapshotOf((k) => d.get(k));
    });
  } catch (e) {
    console.error("[recheck-recovery] finishing the manual recheck failed", { txId, error: (e as Error)?.name }); // 印は期限で外れる
    return null;
  }
}
