import "server-only";
import type { StripeRuntime } from "./stripe-checkout";
import {
  RECHECK_RECOVERY_DEADLINE_MS,
  RECHECK_RECOVERY_MAX_ITEMS,
  RECHECK_RECOVERY_MAX_PAGES,
  RECHECK_RECOVERY_PAGE_SIZE,
  RECHECK_RECOVERY_RESULTS,
  recheckRecoveryResultOf,
  recheckRecoverySkipReason,
  type RecheckRecoveryResult,
} from "./recheck-recovery-rules";
import type { ManualRecheckClaim, ManualRecheckSnapshot, PendingRecheckDoc, RecheckRecoveryClaim, RecheckRecoveryRunRecord } from "@/lib/firestore/recheck-recovery";
import type { ManualRecheckBlock } from "./recheck-recovery-rules";

/**
 * 決済記録の作成の後の再確認が終わっていない（recheckState=PENDING）決済記録の自動の回収（定期処理から呼ぶ）。
 *  - 1件の回収は既存の confirmStripeCheckout を、決済記録がある経路だけで呼ぶ（requireExistingTransaction・expectedPaymentIntentId）。
 *    決済記録・占い権利を新しく作らない。返金済み・チャージバック済みの注文は refunded のまま（権利・注文を戻さない）。
 *    再確認の中の反映は、Stripe の最新の状態と記録済みのキーで書き込むので、Webhook と同時に動いても二重にならない
 *  - Stripe API は Firestore のトランザクションの外で呼ぶ（試行の記録のトランザクションの後）
 *  - PENDING の決済記録は文書の ID の順に、前回の続きから読む（最後まで読んだら最初に戻る。1回の実行で同じ記録は1回だけ）。
 *    対象外の記録も続きの位置を進めるので、同じ記録ばかり読まれて、ほかの記録が取り残されることはない
 *  - 1回に最大 RECHECK_RECOVERY_MAX_ITEMS 件。開始から RECHECK_RECOVERY_DEADLINE_MS を過ぎた（または notAfter を過ぎた）ら新しい回収を始めない
 *    （始めた回収は最後まで行う。1件の Stripe API の呼び出しの時間には上限が無いので、定期処理の最後に実行する）
 */

export type RecheckRecoveryDeps = {
  readCursor: () => Promise<string | null>;
  listPage: (afterId: string | null, pageSize: number) => Promise<PendingRecheckDoc[]>;
  claim: (txId: string, now: Date) => Promise<RecheckRecoveryClaim>;
  /** 1件の回収（決済の確定の処理を、決済記録がある経路だけで呼ぶ） */
  recheck: (c: { txId: string; sessionId: string; paymentIntentId: string }) => Promise<{ status: string; reason?: string; recheck?: "done" | "pending" | "not_pending" }>;
  recordResult: (txId: string, result: RecheckRecoveryResult, errorName: string | null) => Promise<void>;
  recordRun: (run: RecheckRecoveryRunRecord) => Promise<void>;
};

export type RecheckRecoveryRunSummary = {
  status: "completed" | "partial" | "failed";
  scanned: number;
  attempted: number;
  results: Record<RecheckRecoveryResult, number>;
  skipped: Record<string, number>;
  /** 上限（件数・時間・ページ）で読み終えずに次回へ回した */
  deferred: boolean;
  nextCursor: string | null;
  errorName: string | null;
};

const errorNameOf = (e: unknown) => {
  const n = (e as Error)?.name;
  return typeof n === "string" && /^[\w.\-]{1,60}$/.test(n) ? n : "Error";
};

export async function runPendingRecheckRecovery(
  rt: Pick<StripeRuntime, "mode">,
  deps: RecheckRecoveryDeps,
  opts: {
    now?: () => Date;
    deadlineMs?: number;
    notAfter?: Date;
    maxItems?: number;
    pageSize?: number;
    maxPages?: number;
    isSessionId: (v: unknown) => boolean;
    /** 中止の合図（定期処理の時間切れ）。1件ごとに確かめ、中止の後は新しい回収を始めない（時間の区切りと同じ扱い。残りは次回） */
    signal?: AbortSignal;
  },
): Promise<RecheckRecoveryRunSummary> {
  const clock = opts.now ?? (() => new Date());
  const startedAt = clock();
  const maxItems = opts.maxItems ?? RECHECK_RECOVERY_MAX_ITEMS;
  const pageSize = opts.pageSize ?? RECHECK_RECOVERY_PAGE_SIZE;
  const maxPages = opts.maxPages ?? RECHECK_RECOVERY_MAX_PAGES;
  const deadlineMs = opts.deadlineMs ?? RECHECK_RECOVERY_DEADLINE_MS;
  const results = Object.fromEntries(RECHECK_RECOVERY_RESULTS.map((k) => [k, 0])) as Record<RecheckRecoveryResult, number>;
  const summary: RecheckRecoveryRunSummary = { status: "completed", scanned: 0, attempted: 0, results, skipped: {}, deferred: false, nextCursor: null, errorName: null };
  const skip = (reason: string) => void (summary.skipped[reason] = (summary.skipped[reason] ?? 0) + 1);
  const timeUp = () => {
    const t = clock();
    return opts.signal?.aborted === true || t.getTime() - startedAt.getTime() >= deadlineMs || (opts.notAfter !== undefined && t.getTime() >= opts.notAfter.getTime());
  };

  const startCursor = await deps.readCursor().catch(() => null);
  let cursor = startCursor;
  let wrapped = startCursor === null; // 最初から読み始めたなら、最後まで読んだら終わり（もう一度最初には戻らない）
  const seen = new Set<string>();
  let lastExamined: string | null = startCursor;
  let finished = false;
  try {
    outer: for (let page = 0; page < maxPages; page++) {
      const docs = await deps.listPage(cursor, pageSize);
      for (const d of docs) {
        if (seen.has(d.id)) {
          // 一周した（この実行で読んだ記録に戻った）：終わり
          finished = true;
          break outer;
        }
        if (summary.attempted >= maxItems || timeUp()) {
          summary.deferred = true; // この記録はまだ見ていない：次回はこの記録から（直前の記録の次から）
          break outer;
        }
        seen.add(d.id);
        summary.scanned++;
        lastExamined = d.id;
        const reason = recheckRecoverySkipReason(d.candidate, clock(), rt.mode, opts.isSessionId);
        if (reason) {
          skip(reason);
          continue;
        }
        // 試行の回数を先に記録する（トランザクションで最新の状態を確かめ直す。Stripe API はこの後）
        const c = await deps.claim(d.id, clock());
        if (!c.claimed) {
          skip(`claim_${c.reason}`);
          continue;
        }
        summary.attempted++;
        let result: RecheckRecoveryResult;
        let errorName: string | null = null;
        try {
          const r = await deps.recheck({ txId: d.id, sessionId: c.sessionId, paymentIntentId: c.paymentIntentId });
          result = recheckRecoveryResultOf(r);
          if (result === "rejected") errorName = r.reason ?? r.status;
          if (result !== "done") console.warn("[recheck-recovery] recheck not completed", { txId: d.id, result, reason: errorName });
        } catch (e) {
          result = "error";
          errorName = errorNameOf(e);
          console.error("[recheck-recovery] recheck failed", { txId: d.id, error: errorName });
        }
        results[result]++;
        await deps.recordResult(d.id, result, errorName);
      }
      if (docs.length < pageSize) {
        // 最後まで読んだ：最初からでなければ最初に戻って続ける（一周したら終わり）
        if (wrapped) {
          finished = true;
          break;
        }
        wrapped = true;
        cursor = null;
        continue;
      }
      cursor = docs[docs.length - 1].id;
      if (page === maxPages - 1) summary.deferred = true; // ページの上限：次回は続きから
    }
  } catch (e) {
    summary.status = "failed";
    summary.errorName = errorNameOf(e);
    console.error("[recheck-recovery] run failed", { error: summary.errorName });
  }
  // 次の実行の位置：最後まで読み終えたら最初から、途中で止めたら最後に見た記録の次から
  summary.nextCursor = finished ? null : lastExamined;
  if (summary.status !== "failed" && (summary.deferred || summary.results.error > 0)) summary.status = "partial";
  await deps.recordRun({
    startedAt,
    finishedAt: clock(),
    status: summary.status,
    counts: { scanned: summary.scanned, attempted: summary.attempted, ...results, ...Object.fromEntries(Object.entries(summary.skipped).map(([k, v]) => [`skipped_${k}`, v])) },
    nextCursor: summary.nextCursor,
    errorName: summary.errorName,
  });
  return summary;
}

export type CronRecheckRecoveryResult =
  | { status: "skipped"; reason: "not_firestore" | "stripe_unavailable" }
  | { status: RecheckRecoveryRunSummary["status"]; scanned: number; attempted: number; done: number; pending: number; rejected: number; error: number; deferred: boolean };

/** 定期処理から呼ぶ（Stripe との接続が無い環境では何もしない）。notAfter を過ぎたら新しい回収を始めない */
export async function runCronRecheckRecovery(notAfter?: Date, signal?: AbortSignal): Promise<CronRecheckRecoveryResult> {
  const { isFirestore } = await import("@/lib/data-provider");
  if (!isFirestore()) return { status: "skipped", reason: "not_firestore" };
  const { stripeRuntime, isStripeSessionId } = await import("./stripe-checkout");
  let rt: StripeRuntime;
  try {
    rt = stripeRuntime();
  } catch {
    return { status: "skipped", reason: "stripe_unavailable" };
  }
  const s = await runPendingRecheckRecovery(rt, await defaultRecheckRecoveryDeps(rt), { notAfter, isSessionId: (v) => isStripeSessionId(v, rt.mode), ...(signal ? { signal } : {}) });
  return { status: s.status, scanned: s.scanned, attempted: s.attempted, done: s.results.done, pending: s.results.pending, rejected: s.results.rejected, error: s.results.error, deferred: s.deferred };
}

/** 既存の Firestore の読み書きと、決済の確定の処理（決済記録がある経路だけ）を使う依存 */
export async function defaultRecheckRecoveryDeps(rt: StripeRuntime): Promise<RecheckRecoveryDeps> {
  const fsr = await import("@/lib/firestore/recheck-recovery");
  const { confirmStripeCheckout } = await import("./stripe-confirm");
  const { isStripeSessionId } = await import("./stripe-checkout");
  return {
    readCursor: fsr.readRecheckRecoveryCursor,
    listPage: fsr.listPendingRecheckPage,
    claim: (txId, now) => fsr.claimRecheckRecovery(txId, now, rt.mode, (v) => isStripeSessionId(v, rt.mode)),
    recheck: ({ sessionId, paymentIntentId }) => confirmStripeCheckout(sessionId, rt, { expectedPaymentIntentId: paymentIntentId, requireExistingTransaction: true }),
    recordResult: fsr.recordRecheckRecoveryResult,
    recordRun: fsr.recordRecheckRecoveryRun,
  };
}

// ---------- 運営の手動の再確認 ----------

export type ManualRecheckDeps = {
  claim: (txId: string, now: Date, actorUserId: string) => Promise<ManualRecheckClaim>;
  recheck: (c: { sessionId: string; paymentIntentId: string }) => Promise<{ status: string; reason?: string; recheck?: "done" | "pending" | "not_pending" }>;
  finish: (txId: string, token: string, result: RecheckRecoveryResult, errorName: string | null) => Promise<ManualRecheckSnapshot | null>;
  audit: (entry: { actorUserId: string | null; actorRole: "OPERATOR"; txId: string; storeId: string | null; before: ManualRecheckSnapshot; after: Record<string, unknown> }) => Promise<void>;
};

export type ManualRecheckOutcome =
  | { started: false; reason: ManualRecheckBlock | "missing" }
  | { started: true; result: RecheckRecoveryResult; errorName: string | null; after: ManualRecheckSnapshot | null };

/**
 * 運営の手動の再確認（1件）。自動の回収と同じく、既存の confirmStripeCheckout を決済記録がある経路だけで呼ぶ
 * （決済記録・占い権利を作らない。返金済み・チャージバック済みの権利・注文を戻さない。通知の対象の PaymentIntent と照合する）。
 *  1) トランザクションで対象を確かめ直し、実行中の印・実行者・時刻を記録する（同じ決済記録の手動・自動の二重の実行を防ぐ）
 *  2) トランザクションの外で、決済の確定の処理（再確認）を呼ぶ
 *  3) 結果を記録して印を外し、実行者・前後の状態・結果を監査ログに残す（Stripe の例外でも記録する）
 * 自動の回収の回数・間隔の上限は手動には適用しない（上限に達した記録も、運営は再確認できる）
 */
export async function manualRecheckTransaction(txId: string, actor: { userId: string; role: "OPERATOR" }, deps: ManualRecheckDeps, now: Date = new Date()): Promise<ManualRecheckOutcome> {
  const c = await deps.claim(txId, now, actor.userId);
  if (!c.claimed) return { started: false, reason: c.reason };
  let result: RecheckRecoveryResult;
  let errorName: string | null = null;
  try {
    const r = await deps.recheck({ sessionId: c.sessionId, paymentIntentId: c.paymentIntentId });
    result = recheckRecoveryResultOf(r);
    if (result === "rejected") errorName = r.reason ?? r.status;
  } catch (e) {
    result = "error";
    errorName = errorNameOf(e);
    console.error("[recheck-recovery] manual recheck failed", { txId, error: errorName });
  }
  const after = await deps.finish(txId, c.token, result, errorName);
  await deps
    .audit({ actorUserId: actor.userId, actorRole: actor.role, txId, storeId: c.storeId, before: c.before, after: { result, errorName, ...(after ?? {}) } })
    .catch((e) => console.error("[recheck-recovery] audit failed", (e as Error)?.name));
  return { started: true, result, errorName, after };
}

/** 既存の Firestore の読み書き・決済の確定の処理（決済記録がある経路だけ）・監査ログを使う依存 */
export async function defaultManualRecheckDeps(rt: StripeRuntime): Promise<ManualRecheckDeps> {
  const fsr = await import("@/lib/firestore/recheck-recovery");
  const { confirmStripeCheckout } = await import("./stripe-confirm");
  const { isStripeSessionId } = await import("./stripe-checkout");
  const { writeAudit } = await import("@/lib/firestore/audit");
  return {
    claim: (txId, now, actorUserId) => fsr.claimManualRecheck(txId, now, rt.mode, (v) => isStripeSessionId(v, rt.mode), actorUserId),
    recheck: ({ sessionId, paymentIntentId }) => confirmStripeCheckout(sessionId, rt, { expectedPaymentIntentId: paymentIntentId, requireExistingTransaction: true }),
    finish: fsr.finishManualRecheck,
    audit: (a) =>
      writeAudit({ actorUserId: a.actorUserId, actorRole: a.actorRole, action: "transaction.recheck", targetType: "transaction", targetId: a.txId, storeId: a.storeId ?? undefined, before: a.before, after: a.after }),
  };
}
