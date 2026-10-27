import "server-only";
import { createHash, randomUUID } from "node:crypto";
import type { DocumentData } from "firebase-admin/firestore";
import { C, fsdb, safeId, toDate } from "./admin";
import { writeAudit } from "./audit";
import { upsertDedupedRecord } from "./deduped-record";
import { hourBucket, type AlertMode, type MonitorRunStatus, type PaymentAlertKind } from "@/lib/payments/monitor-rules";

/**
 * 決済監視の異常の記録（Firestore 版）。
 *  paymentAlerts/{種類_対象のハッシュ} … 種類・対象ごとに1件。くり返しは回数と最後の日時だけ（無制限に増えない）
 *  system/paymentMonitor              … 監視の点検の状態（最後に開始・終了した日時・結果・確認できなかった項目）
 *
 * 保存するのは種類・対象の ID・モード（テスト／本番）・回数・エラーの名前（Error.name）だけ。
 * 個人情報・カード情報・Stripe の秘密鍵・Webhook の署名・通知の本文・エラーの文面は保存しない。
 * 記録に失敗しても決済・Webhook の処理は止めない（サーバーのログに "[payment-alert] record failed" を残す）。
 * 決済要確認（paymentReviews。記録と照合できなかった通知）とは別。照合の食い違いはそちらに記録する。
 */

export type PaymentAlertInput = {
  kind: PaymentAlertKind;
  objectType: "webhook" | "event" | "checkout" | "transaction" | "settlement" | "api" | "review" | "monitor";
  objectId: string;
  mode: AlertMode;
  eventType?: string | null;
  checkoutId?: string | null;
  transactionId?: string | null;
  storeId?: string | null;
  settlementId?: string | null;
  route?: string | null;
  httpStatus?: number | null;
  errorName?: string | null;
  /** 関係する金額・件数（円・件） */
  amount?: number | null;
  /** 間引いて記録する異常（署名の不正など）：この書き込みでまとめて加算する、観測した件数 */
  observedCount?: number;
};

export type PaymentAlertStatus = "OPEN" | "RESOLVED";
export type PaymentAlert = PaymentAlertInput & { id: string; status: PaymentAlertStatus; /** 記録（書き込み）の回数。間引く異常では実際の件数より少ない */ occurrences: number; /** 間引いて記録した異常か（true なら observedCount は「少なくとも」の件数） */ sampled: boolean; firstSeenAt: Date | null; lastSeenAt: Date | null; resolvedAt: Date | null; resolvedBy: string | null };

export const PAYMENT_ALERT_TIMEOUT_MS = 3000;
const col = () => fsdb().collection(C.paymentAlerts);
const ID_RE = /^[A-Za-z0-9_:.-]{1,200}$/;
const clean = (v: unknown) => (typeof v === "string" && ID_RE.test(v) ? v : null);
export const paymentAlertId = (kind: PaymentAlertKind, objectId: string) => safeId(kind, createHash("sha256").update(objectId).digest("hex").slice(0, 40));

/** 異常を記録する（同じ種類・対象なら回数を増やす。確認済みの後にまた起きたら未確認に戻す）。失敗しても例外にしない */
export async function recordPaymentAlert(input: PaymentAlertInput, now: Date = new Date()): Promise<boolean> {
  const objectId = clean(input.objectId) ?? "invalid";
  const fields = {
    kind: input.kind,
    objectType: input.objectType,
    objectId,
    mode: input.mode === "live" || input.mode === "test" ? input.mode : "unknown",
    eventType: clean(input.eventType),
    checkoutId: clean(input.checkoutId),
    transactionId: clean(input.transactionId),
    storeId: clean(input.storeId),
    settlementId: clean(input.settlementId),
    route: clean(input.route),
    httpStatus: Number.isInteger(input.httpStatus) ? input.httpStatus : null,
    errorName: typeof input.errorName === "string" && /^[A-Za-z0-9_]{1,60}$/.test(input.errorName) ? input.errorName : null,
    amount: Number.isSafeInteger(input.amount) ? input.amount : null,
    ...(input.observedCount !== undefined ? { sampled: true } : {}),
  };
  const observed = Number.isSafeInteger(input.observedCount) && input.observedCount! > 0 ? input.observedCount! : null;
  try {
    const r = await upsertDedupedRecord(col().doc(paymentAlertId(input.kind, objectId)), fields, { causeKey: input.kind, reopen: "always", timeoutMs: PAYMENT_ALERT_TIMEOUT_MS, now, ...(observed ? { add: { observedCount: observed } } : {}) });
    if (!r.ok) console.error("[payment-alert] record failed", { kind: input.kind, objectType: input.objectType, error: r.error });
    return r.ok;
  } catch (e) {
    console.error("[payment-alert] record failed", { kind: input.kind, objectType: input.objectType, error: (e as Error)?.name });
    return false;
  }
}

/** 決済の API の 5xx（1時間ごと・API ごとに1件。回数を数える） */
export function notePaymentApiError(route: string, httpStatus: number, errorName?: string, now: Date = new Date()): Promise<boolean> {
  return recordPaymentAlert({ kind: "payment_api_5xx", objectType: "api", objectId: `${route}:${hourBucket(now)}`, route, httpStatus, errorName: errorName ?? null, mode: "unknown" }, now);
}

function toAlert(id: string, d: DocumentData): PaymentAlert {
  return {
    id,
    kind: d.kind,
    objectType: d.objectType,
    objectId: String(d.objectId),
    mode: d.mode === "live" || d.mode === "test" ? d.mode : "unknown",
    eventType: d.eventType ?? null,
    checkoutId: d.checkoutId ?? null,
    transactionId: d.transactionId ?? null,
    storeId: d.storeId ?? null,
    settlementId: d.settlementId ?? null,
    route: d.route ?? null,
    httpStatus: typeof d.httpStatus === "number" ? d.httpStatus : null,
    errorName: d.errorName ?? null,
    amount: typeof d.amount === "number" ? d.amount : null,
    sampled: d.sampled === true,
    observedCount: typeof d.observedCount === "number" ? d.observedCount : undefined,
    status: d.status === "RESOLVED" ? "RESOLVED" : "OPEN",
    occurrences: Number(d.occurrences ?? 1),
    firstSeenAt: toDate(d.firstSeenAt),
    lastSeenAt: toDate(d.lastSeenAt),
    resolvedAt: toDate(d.resolvedAt),
    resolvedBy: d.resolvedBy ?? null,
  };
}

/** 一覧に読み込む件数の上限（運営画面の表示のたびに全件を読まない） */
export const PAYMENT_ALERT_LIST_LIMIT = 200;

/**
 * 一覧（上限 limit 件）。表示の順は「未確認 → 確認済み」、同じ状態の中は最後の発生日時の新しい順。
 * 状態（とモード）で絞り、最後の発生日時で並べて Firestore から読む（firestore.indexes.json の複合インデックスを使う）。
 * 「すべて」は未確認を先に読み、残りの件数だけ確認済みを読む。
 * 上限を超えた（表示していない記録がある）ときは truncated=true（画面に件数の制限を出す。異常の有無の判定は件数の集計で行う）。
 */
export async function listPaymentAlerts(opts: { status?: PaymentAlertStatus; mode?: AlertMode; limit?: number } = {}): Promise<{ rows: PaymentAlert[]; truncated: boolean }> {
  const limit = Math.min(opts.limit ?? PAYMENT_ALERT_LIST_LIMIT, 500);
  const read = async (status: PaymentAlertStatus, n: number) => {
    let q = col().where("status", "==", status);
    if (opts.mode) q = q.where("mode", "==", opts.mode);
    const snap = await q.orderBy("lastSeenAt", "desc").limit(n + 1).get();
    return { rows: snap.docs.slice(0, n).map((d) => toAlert(d.id, d.data())), more: snap.size > n };
  };
  if (opts.status) return (({ rows, more }) => ({ rows, truncated: more }))(await read(opts.status, limit));
  const open = await read("OPEN", limit);
  if (open.more || open.rows.length >= limit) {
    // 未確認だけで上限に達した：確認済みは表示しない（あるかどうかだけを確かめる）
    const resolvedExists = !(await col().where("status", "==", "RESOLVED").limit(1).get()).empty;
    return { rows: open.rows, truncated: open.more || resolvedExists };
  }
  const resolved = await read("RESOLVED", limit - open.rows.length);
  return { rows: [...open.rows, ...resolved.rows], truncated: resolved.more };
}

export async function countOpenPaymentAlerts(): Promise<number> {
  return (await col().where("status", "==", "OPEN").count().get()).data().count;
}

/** 確認済みにする（運営の操作。監査ログに残す） */
export async function resolvePaymentAlert(id: string, actor: { userId: string; role: "OPERATOR" }): Promise<boolean> {
  if (!/^[A-Za-z0-9_]{1,120}$/.test(id)) return false;
  const ref = col().doc(id);
  return fsdb().runTransaction(async (tx) => {
    const cur = await tx.get(ref);
    if (!cur.exists || cur.get("status") !== "OPEN") return false;
    tx.update(ref, { status: "RESOLVED", resolvedAt: new Date(), resolvedBy: actor.userId });
    await writeAudit({ actorUserId: actor.userId, actorRole: actor.role, action: "payment_alert.resolved", targetType: "payment_alert", targetId: id, storeId: cur.get("storeId") ?? undefined, before: { kind: cur.get("kind"), mode: cur.get("mode"), occurrences: cur.get("occurrences") }, after: null }, tx);
    return true;
  });
}

// ---------- 監視の点検の状態 ----------

const statusRef = () => fsdb().collection(C.system).doc("paymentMonitor");

export async function readMonitorStatus(): Promise<MonitorRunStatus | null> {
  const d = await statusRef().get();
  if (!d.exists) return null;
  return {
    lastStartedAt: toDate(d.get("lastStartedAt")),
    lastFinishedAt: toDate(d.get("lastFinishedAt")),
    lastResult: (["ok", "issues", "partial", "failed"] as const).find((v) => v === d.get("lastResult")) ?? null,
    unchecked: Array.isArray(d.get("unchecked")) ? (d.get("unchecked") as unknown[]).map(String).slice(0, 20) : [],
    found: Number(d.get("found") ?? 0),
    stripeMode: d.get("stripeMode") === "live" || d.get("stripeMode") === "test" ? d.get("stripeMode") : null,
    inProgress: typeof d.get("currentRunId") === "string" && d.get("currentRunId") !== d.get("lastRunId"),
  };
}

// ---------- 点検の排他制御（複数のサーバーのインスタンス・手動・今後の Cron で共通） ----------
//  system/paymentMonitorLock … 実行中の点検（runId・有効期限）。トランザクションで取得し、期限切れなら次の点検が取得できる
//  system/paymentMonitor の currentRunId … 最後に開始した点検。終了の書き込みはこれと一致するときだけ（古い点検は上書きしない）

const lockRef = () => fsdb().collection(C.system).doc("paymentMonitorLock");
export type MonitorSource = "admin" | "script" | "cron";
export type MonitorLockResult = { ok: true; runId: string } | { ok: false; reason: "busy"; heldUntil: Date | null; source: string | null };

/** 点検の開始：実行中の点検が無い（または期限切れ）ときだけ取得する。Firestore の失敗は例外（呼び出し側で点検を開始しない） */
export async function acquireMonitorLock(opts: { now: Date; ttlMs: number; source: MonitorSource; runId?: string }): Promise<MonitorLockResult> {
  const runId = opts.runId ?? randomUUID();
  return fsdb().runTransaction(async (tx) => {
    const cur = await tx.get(lockRef());
    const until = cur.exists ? toDate(cur.get("expiresAt")) : null;
    if (cur.exists && until && until > opts.now) return { ok: false as const, reason: "busy" as const, heldUntil: until, source: typeof cur.get("source") === "string" ? cur.get("source") : null };
    tx.set(lockRef(), { runId, source: opts.source, acquiredAt: opts.now, expiresAt: new Date(opts.now.getTime() + opts.ttlMs) });
    tx.set(statusRef(), { lastStartedAt: opts.now, currentRunId: runId, currentSource: opts.source }, { merge: true });
    return { ok: true as const, runId };
  });
}

/** 点検の終了：自分の点検のロックだけを外す（期限切れの後に別の点検が取得したロックは外さない） */
export async function releaseMonitorLock(runId: string): Promise<boolean> {
  return fsdb().runTransaction(async (tx) => {
    const cur = await tx.get(lockRef());
    if (!cur.exists || cur.get("runId") !== runId) return false;
    tx.delete(lockRef());
    return true;
  });
}

/** 点検の結果を書く：最後に開始した点検（currentRunId）と一致するときだけ。古い点検は新しい結果を上書きしない */
export async function markMonitorFinished(r: { runId: string; now: Date; result: "ok" | "issues" | "partial" | "failed"; unchecked: string[]; found: number; stripeMode: "test" | "live" | null; checks: Record<string, number> }): Promise<boolean> {
  return fsdb().runTransaction(async (tx) => {
    const cur = await tx.get(statusRef());
    if (!cur.exists || cur.get("currentRunId") !== r.runId) return false;
    tx.set(statusRef(), { lastFinishedAt: r.now, lastResult: r.result, unchecked: r.unchecked.slice(0, 20), found: r.found, stripeMode: r.stripeMode, checks: r.checks, lastRunId: r.runId }, { merge: true });
    return true;
  });
}
