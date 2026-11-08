import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth/session";
import { isSameOrigin } from "@/lib/security/request";
import { isFirestore } from "@/lib/data-provider";
import { writeAudit } from "@/lib/services/audit";
import { DiagnosticsRateLimiter } from "@/lib/ops/stripe-account-diagnostics";
import { stripeRuntime, type StripeRuntime } from "@/lib/payments/stripe-checkout";
import { jstDayRangeToSec } from "@/lib/payments/reconcile-rules";
import { ReconcileInputError, RECONCILE_TOKEN_MAX_LENGTH, resumeReconcile, startReconcile, type ReconcileRun } from "@/lib/payments/stripe-reconcile";

export const dynamic = "force-dynamic";
/**
 * 関数の実行時間の上限（秒）。照合は40秒を過ぎたら次のページを読まない（RECONCILE_LIMITS.deadlineMs）が、その直前に始めた
 * Stripe の取得は SDK の再試行（20秒×最大3回）で長引くことがあるので、Webhook と同じ300秒（Hobby・Fluid Compute の上限）にする
 */
export const maxDuration = 300;

const HEADERS = { "Cache-Control": "private, no-store, max-age=0", "X-Robots-Tag": "noindex" };
/** 同時に1つだけ。1分に1人6回・全体20回まで（メモリだけ。Firestore には書かない） */
const limiter = new DiagnosticsRateLimiter(6, 20);
const MAX_BODY = RECONCILE_TOKEN_MAX_LENGTH + 4096;

/**
 * Stripe 起点の決済照合（F2 第1段階。運営アカウントだけ・POST だけ・読み取り専用）。
 *  - {"action":"start","from":"YYYY-MM-DD","to":"YYYY-MM-DD"} … 日本時間の日付の期間で始める（最長31日）
 *  - {"action":"resume","token":"…"} … 未完了の照合を続きから（期間・環境は token のもの。外から変えられない）
 * Stripe は一覧の取得だけ、Firestore は読むだけ。書き込みは監査ログ1件（実行ごと）だけ。
 * 応答とログには ID・件数・分類だけを出す（個人情報・キー・Stripe のエラーの文言は出さない）。
 */
export async function POST(req: Request): Promise<Response> {
  const user = await getSessionUser();
  if (!user || user.role !== "OPERATOR") return new NextResponse("Not found", { status: 404, headers: HEADERS });
  if (!isSameOrigin(req)) return new NextResponse("Forbidden", { status: 403, headers: HEADERS });
  if (!isFirestore()) return NextResponse.json({ error: "firestore_required" }, { status: 409, headers: HEADERS });
  let rt: StripeRuntime;
  try {
    rt = stripeRuntime();
  } catch {
    return NextResponse.json({ error: "stripe_unavailable" }, { status: 409, headers: HEADERS });
  }
  const text = await req.text();
  if (text.length > MAX_BODY) return NextResponse.json({ error: "too_large" }, { status: 413, headers: HEADERS });
  let body: { action?: unknown; from?: unknown; to?: unknown; token?: unknown };
  try {
    body = JSON.parse(text) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid_request" }, { status: 400, headers: HEADERS });
  }
  if (body?.action !== "start" && body?.action !== "resume") return NextResponse.json({ error: "invalid_request" }, { status: 400, headers: HEADERS });
  let range: { from: number; to: number } | null = null;
  if (body.action === "start") {
    range = jstDayRangeToSec(body.from, body.to);
    if (!range) return NextResponse.json({ error: "invalid_range" }, { status: 400, headers: HEADERS });
  }

  const release = limiter.acquire(user.id);
  if (!release) return NextResponse.json({ error: "rate_limited" }, { status: 429, headers: { ...HEADERS, "Retry-After": "60" } });
  try {
    let run: ReconcileRun;
    try {
      run = range ? await startReconcile({ rt, userId: user.id, fromSec: range.from, toSec: range.to }) : await resumeReconcile({ rt, userId: user.id, token: body.token });
    } catch (e) {
      if (e instanceof ReconcileInputError) return NextResponse.json({ error: e.code }, { status: 400, headers: HEADERS });
      throw e;
    }
    const s = run.state;
    console.info("[payment-reconcile]", { runId: s.runId, mode: s.mode, verdict: run.verdict, stoppedBy: run.stoppedBy, pages: s.pages, scanned: s.counts.scanned, anomalies: s.counts.anomalies, pending: s.counts.pending, needsReview: s.counts.needsReview });
    await writeAudit({
      actorUserId: user.id,
      actorRole: "OPERATOR",
      action: "payment_reconcile.run",
      targetType: "payment_reconcile",
      targetId: s.runId,
      after: { resumed: body.action === "resume", mode: s.mode, from: s.from, to: s.to, verdict: run.verdict, stoppedBy: run.stoppedBy, pages: s.pages, scanned: s.counts.scanned, anomalies: s.counts.anomalies },
    }).catch((e) => console.error("[payment-reconcile] audit failed", (e as Error)?.name));
    return NextResponse.json(
      {
        runId: s.runId,
        mode: s.mode,
        from: s.from,
        to: s.to,
        startedAt: s.startedAt,
        verdict: run.verdict,
        stoppedBy: run.stoppedBy,
        done: s.done,
        pages: s.pages,
        segmentPages: run.segmentPages,
        counts: s.counts,
        byKind: s.byKind,
        anomalies: s.anomalies,
        pendingItems: s.pendingItems,
        reviewItems: s.reviewItems,
        truncated: s.truncated,
        phase: s.phase,
        metrics: s.metrics,
        token: run.token,
      },
      { headers: HEADERS },
    );
  } catch {
    console.error("[payment-reconcile] failed");
    return NextResponse.json({ error: "unknown" }, { status: 500, headers: HEADERS });
  } finally {
    release();
  }
}
