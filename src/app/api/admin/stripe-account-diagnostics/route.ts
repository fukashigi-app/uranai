import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth/session";
import { isSameOrigin } from "@/lib/security/request";
import { stripeRuntime } from "@/lib/payments/stripe-checkout";
import { DiagnosticsRateLimiter, isSandboxV2Environment, runStripeAccountDiagnostics } from "@/lib/ops/stripe-account-diagnostics";

export const dynamic = "force-dynamic";

const HEADERS = { "Cache-Control": "private, no-store, max-age=0", "X-Robots-Tag": "noindex" };
const limiter = new DiagnosticsRateLimiter();

/**
 * Sandbox v2 専用：Stripe のアカウントの照合の診断（運営アカウントだけ・POST だけ）。
 *  1. 運営アカウントのログイン（サーバー側で確認。運営以外は 404）・自サイトからの送信（CSRF）
 *  2. Sandbox v2 の Preview か（それ以外は 404。本番・旧 Preview では動かない）
 *  3. レート制限（メモリだけ。Firestore には書かない）
 *  4. 決済の処理と同じ接続（stripeRuntime）で GET /v1/account だけを呼び、ID を比べる
 * 決済画面・PaymentIntent の作成、Firestore への書き込み、返金、Webhook の再送はしない。
 * ログには結果の分類だけを出す（キー・Webhook の秘密・アカウントの ID・Stripe のエラーの文言は出さない）。
 */
export async function POST(req: Request): Promise<Response> {
  const user = await getSessionUser();
  if (!user || user.role !== "OPERATOR") return new NextResponse("Not found", { status: 404, headers: HEADERS });
  if (!isSameOrigin(req)) return new NextResponse("Forbidden", { status: 403, headers: HEADERS });
  if (!isSandboxV2Environment()) return NextResponse.json({ error: "environment_not_allowed", environment: "other" }, { status: 404, headers: HEADERS });

  const release = limiter.acquire(user.id);
  if (!release) return NextResponse.json({ error: "rate_limited" }, { status: 429, headers: { ...HEADERS, "Retry-After": "60" } });
  try {
    const result = await runStripeAccountDiagnostics(() => stripeRuntime().client.accounts.retrieveCurrent());
    console.info("[ops/stripe-account-diagnostics]", { apiAuth: result.apiAuth, accountMatch: result.accountMatch, error: result.error });
    return NextResponse.json(result, { headers: HEADERS });
  } catch {
    // ここには来ない想定（runStripeAccountDiagnostics は Stripe の例外を分類して返す）。念のため、例外の内容は返さず・出さない
    console.error("[ops/stripe-account-diagnostics] failed");
    return NextResponse.json({ error: "unknown" }, { status: 500, headers: HEADERS });
  } finally {
    release();
  }
}
