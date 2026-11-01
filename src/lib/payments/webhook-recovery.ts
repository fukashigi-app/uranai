import "server-only";
import type Stripe from "stripe";
import { retrieveStripeEvent, stripeRuntime, type StripeRuntime } from "./stripe-checkout";
import { processStripeEvent } from "./stripe-webhook";
import { webhookErrorNameOf } from "./webhook-event-state";
import {
  isRecoveryAttempt,
  RECOVERY_DEADLINE_MS,
  RECOVERY_MAX_EVENTS,
  RECOVERY_MAX_PAGES,
  RECOVERY_STALE_MS,
  selectRecoveryCandidates,
  WEBHOOK_RECOVERY_RESULTS,
  type WebhookRecoveryResult,
} from "./webhook-recovery-rules";
import { getWebhookEventRecord, listUnfinishedWebhookEvents, markWebhookEventUnavailable, recordWebhookRecoveryResult, recordWebhookRecoveryRun, type UnfinishedWebhookEvent } from "@/lib/firestore/payments";

/**
 * Stripe の Webhook の通知の復旧（途中で止まった・失敗した・Stripe の再送が終わった通知を、通知の ID で処理し直す）。規則は webhook-recovery-rules.ts。
 *  - 対象は webhookEvents に記録がある通知だけ（署名を確認して受信した ID）。外から決済の内容を渡す経路は無い
 *  - 通知の中身は保存していないので、Stripe API から取り直す（events.retrieve。この接続のキーで Stripe から直接受け取った値。
 *    署名付きの Webhook の受信とは別の経路だが、取り直した後は Webhook と同じ processStripeEvent で処理する）
 *  - 処理権・処理済みの判定（processedAt）・環境の識別（IGNORED_OTHER_ENV）・決済要確認の重複の防止（recordedReviewIds）・
 *    決済確定・返金・異議申し立ての反映は、すべて Webhook と同じ処理を使う（復旧のために複製しない）
 *  - 失敗しても processedAt は書かない（Webhook と同じく RETRYABLE。復旧の結果と理由は lastRecovery* に記録する）
 *  - Stripe から取得できない通知（404。保存期間切れ・アカウントの設定違いなど。原因は判断しない）は処理済みにせず FAILED_PERMANENT（要確認）にする
 */
export type WebhookRecoveryOutcome = { eventId: string; result: WebhookRecoveryResult; errorName: string | null; outcome: string | null };

const isMissing = (e: unknown) => {
  const x = e as { type?: unknown; statusCode?: unknown; code?: unknown };
  return x?.type === "StripeInvalidRequestError" && (x.statusCode === 404 || x.code === "resource_missing");
};

/** 通知を1件、ID で復旧する（手動・自動で共通）。何度・同時に呼んでも、処理権と冪等性で二重には反映しない */
export async function recoverStripeWebhookEvent(eventId: string, rt: StripeRuntime, opts: { now?: Date } = {}): Promise<WebhookRecoveryOutcome> {
  const done = async (result: WebhookRecoveryResult, errorName: string | null = null, outcome: string | null = null): Promise<WebhookRecoveryOutcome> => {
    // 試した結果だけ記録する（処理中・処理済みで何もしなかったときに記録すると、間隔待ちで自動の復旧が遅れる）
    if (isRecoveryAttempt(result)) await recordWebhookRecoveryResult("stripe", eventId, { result, errorName });
    return { eventId, result, errorName, outcome };
  };
  if (!/^evt_[A-Za-z0-9_]{1,200}$/.test(eventId)) return { eventId, result: "not_found", errorName: null, outcome: null };
  const now = opts.now ?? new Date();
  const rec = await getWebhookEventRecord("stripe", eventId);
  if (!rec) return { eventId, result: "not_found", errorName: null, outcome: null };
  if (rec.processed) return done("already_processed");
  if (rec.livemode !== null && rec.livemode !== (rt.mode === "live")) return done("mode_mismatch");
  // 処理中（期限内の処理権）なら Stripe にも問い合わせない（取得しても processStripeEvent が 409 にする）
  if (rec.leaseOwner && rec.leaseExpiresAt && now.getTime() < rec.leaseExpiresAt.getTime()) return done("busy");

  let event: Stripe.Event;
  try {
    event = await retrieveStripeEvent(eventId, rt);
  } catch (e) {
    if (isMissing(e)) {
      // 処理済みにはしない。要確認（FAILED_PERMANENT）にして、自動の復旧の対象から外す（記録に失敗しても結果は同じ）
      await markWebhookEventUnavailable("stripe", eventId, now).catch((err) => console.error("[webhook-recovery] marking unavailable failed", (err as Error)?.name));
      return done("event_unavailable", "StripeEventUnavailable");
    }
    console.error("[webhook-recovery] retrieving the event failed", { eventId, error: webhookErrorNameOf(e) });
    return done("stripe_error", webhookErrorNameOf(e));
  }
  // 取り直した通知が記録と同じ通知であること（ID・種類・モード）
  if (event?.object !== "event" || event.id !== eventId || event.type !== rec.type || event.livemode !== (rt.mode === "live")) {
    console.error("[webhook-recovery] retrieved event does not match the record", { eventId });
    return done("event_mismatch");
  }
  let r;
  try {
    r = await processStripeEvent(event, rt);
  } catch (e) {
    // 処理権の取得の失敗（Firestore）など。processStripeEvent は処理を始めていない
    console.error("[webhook-recovery] processing failed", { eventId, error: webhookErrorNameOf(e) });
    return done("failed", webhookErrorNameOf(e));
  }
  const body = (typeof r.body === "object" ? r.body : {}) as { duplicate?: boolean; outcome?: unknown };
  if (r.status === 200 && body.duplicate) return done("already_processed");
  if (r.status === 200) return done(body.outcome === "ignored_other_env" ? "ignored_other_env" : "recovered", null, typeof body.outcome === "string" ? body.outcome : null);
  if (r.status === 409) return done("busy");
  if (r.status === 400) return done("mode_mismatch");
  return done("failed", r.errorName ?? "Error");
}

export type WebhookRecoveryRunSummary = {
  status: "completed" | "partial" | "failed";
  /** 読んだ未処理の記録（時間がたったもの） */
  scanned: number;
  candidates: number;
  attempted: number;
  /** 結果ごとの件数 */
  results: Record<WebhookRecoveryResult, number>;
  /** 対象外（処理中・モード違い・回数の上限・間隔）・上限を超えて次回に回した件数・時間の上限で始めなかった件数 */
  skipped: number;
  overLimit: number;
  deferred: number;
  /** ページの上限まで読んでも続きがあった */
  truncated: boolean;
  errorName: string | null;
};

/**
 * 自動の復旧（定期処理から呼ぶ）。未処理の記録をページで読み、候補を選んで、時間の上限まで1件ずつ復旧する。
 * 定期処理が重なって起動しても、通知ごとの処理権で同じ通知は1つの処理だけが進む（結果の件数が分かれるだけ）。
 * 実行の結果（件数）は system/webhookRecovery に記録する（記録に失敗しても結果は返す）。
 */
export async function runStripeWebhookRecovery(rt: StripeRuntime, opts: { source: "cron" | "admin"; now?: () => Date; deadlineMs?: number; maxEvents?: number; maxPages?: number; pageSize?: number } = { source: "cron" }): Promise<WebhookRecoveryRunSummary> {
  const clock = opts.now ?? (() => new Date());
  const startedAt = clock();
  const results = Object.fromEntries(WEBHOOK_RECOVERY_RESULTS.map((k) => [k, 0])) as Record<WebhookRecoveryResult, number>;
  const summary: WebhookRecoveryRunSummary = { status: "completed", scanned: 0, candidates: 0, attempted: 0, results, skipped: 0, overLimit: 0, deferred: 0, truncated: false, errorName: null };
  try {
    const records: UnfinishedWebhookEvent[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < (opts.maxPages ?? RECOVERY_MAX_PAGES); page++) {
      const p = await listUnfinishedWebhookEvents({ staleMs: RECOVERY_STALE_MS, now: startedAt, cursor, pageSize: opts.pageSize });
      records.push(...p.records);
      cursor = p.nextCursor;
      if (!p.hasMore) break;
      if (page === (opts.maxPages ?? RECOVERY_MAX_PAGES) - 1) summary.truncated = true;
    }
    summary.scanned = records.length;
    const sel = selectRecoveryCandidates(records, startedAt, rt.mode, opts.maxEvents ?? RECOVERY_MAX_EVENTS);
    summary.candidates = sel.candidates.length;
    summary.skipped = Object.values(sel.skipped).reduce((a, b) => a + b, 0);
    summary.overLimit = sel.overLimit;
    for (const [i, c] of sel.candidates.entries()) {
      if (clock().getTime() - startedAt.getTime() >= (opts.deadlineMs ?? RECOVERY_DEADLINE_MS)) {
        summary.deferred = sel.candidates.length - i;
        break;
      }
      const o = await recoverStripeWebhookEvent(c.eventId, rt, { now: clock() });
      summary.attempted++;
      results[o.result]++;
    }
    if (summary.truncated || summary.overLimit > 0 || summary.deferred > 0) summary.status = "partial";
  } catch (e) {
    // 未処理の記録を読めなかった（Firestore）など。処理済みにしたものは無い（復旧した分はそのまま）
    summary.status = "failed";
    summary.errorName = webhookErrorNameOf(e);
    console.error("[webhook-recovery] run failed", { error: summary.errorName });
  }
  await recordWebhookRecoveryRun({
    source: opts.source,
    startedAt,
    finishedAt: clock(),
    status: summary.status,
    counts: { scanned: summary.scanned, candidates: summary.candidates, attempted: summary.attempted, skipped: summary.skipped, overLimit: summary.overLimit, deferred: summary.deferred, ...results },
    truncated: summary.truncated,
    errorName: summary.errorName,
  });
  return summary;
}

export type CronWebhookRecoveryResult =
  | { status: "skipped"; reason: "not_firestore" | "stripe_unavailable" }
  | ({ status: WebhookRecoveryRunSummary["status"] } & Pick<WebhookRecoveryRunSummary, "scanned" | "attempted" | "deferred" | "truncated"> & { recovered: number; failed: number });

/**
 * 定期処理（/api/cron/maintenance）から呼ぶ自動の復旧。Stripe の接続（stripeRuntime）が使えない環境（今の Production は
 * テスト決済を拒否する）・Firestore ではない環境では何もしない。例外を投げない（定期処理のほかの結果を変えない）。
 */
export async function runCronWebhookRecovery(): Promise<CronWebhookRecoveryResult> {
  const { isFirestore } = await import("@/lib/data-provider");
  if (!isFirestore()) return { status: "skipped", reason: "not_firestore" };
  let rt: StripeRuntime;
  try {
    rt = stripeRuntime();
  } catch {
    return { status: "skipped", reason: "stripe_unavailable" };
  }
  const s = await runStripeWebhookRecovery(rt, { source: "cron" });
  const failed = s.results.failed + s.results.stripe_error + s.results.event_unavailable + s.results.event_mismatch;
  return { status: s.status, scanned: s.scanned, attempted: s.attempted, deferred: s.deferred, truncated: s.truncated, recovered: s.results.recovered + s.results.ignored_other_env, failed };
}
