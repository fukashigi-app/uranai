import { NextResponse } from "next/server";
import { stripeRuntime } from "@/lib/payments/stripe-checkout";
import { handleStripeWebhook } from "@/lib/payments/stripe-webhook";

export const dynamic = "force-dynamic";
/**
 * 関数の実行時間の上限（秒）。Hobby プラン・Fluid Compute 有効（Vercel の管理画面で確認）で使える上限の300秒。
 * 上限は「ここで打ち切られる」時間で、処理が終わる保証ではない。打ち切られた通知は processedAt を書かないので、
 * 処理権の期限（WEBHOOK_LEASE_TTL_MS＝360秒。この値より60秒長い）の後の Stripe の再送で処理し直す（docs/preview-verification.md §11）
 */
export const maxDuration = 300;

const MAX_BODY = 256 * 1024;

/**
 * Stripe の Webhook。Stripe との接続は stripeRuntime()（今はテスト＝Sandbox だけ。本番決済は未実装・無効）。
 * 使える設定がそろっていなければ 404（安全側。Stripe は再送する）。処理の中身は lib/payments/stripe-webhook.ts
 * （署名の確認・通知のモードの照合・重複の排除・Stripe API での取り直し）。
 */
export async function POST(req: Request): Promise<Response> {
  let rt;
  try {
    rt = stripeRuntime();
  } catch {
    return new NextResponse("Not found", { status: 404 });
  }
  const rawBody = await req.text();
  if (Buffer.byteLength(rawBody, "utf8") > MAX_BODY) return new NextResponse("Payload too large", { status: 413 });
  const r = await handleStripeWebhook(rawBody, req.headers.get("stripe-signature"), rt);
  return typeof r.body === "string" ? new NextResponse(r.body, { status: r.status }) : NextResponse.json(r.body, { status: r.status });
}
