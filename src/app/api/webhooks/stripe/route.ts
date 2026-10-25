import { NextResponse } from "next/server";
import type Stripe from "stripe";
import { stripeTestConfig } from "@/lib/payments/stripe-guard";
import { stripeClient, stripeWebhookSecret } from "@/lib/payments/stripe-checkout";
import { closeStripeCheckout, confirmStripeCheckout, refreshStripeFee, syncStripeRefunds } from "@/lib/payments/stripe-confirm";
import { beginWebhookEvent, finishWebhookEvent } from "@/lib/firestore/payments";

export const dynamic = "force-dynamic";

const MAX_BODY = 256 * 1024;

/**
 * Stripe の Webhook（テスト決済だけ）。
 *  1) テスト決済の設定がそろっていなければ 404（安全側。Stripe は再送する）
 *  2) 生の本文で署名を確認（Stripe 公式 SDK。5分以内の通知だけ）。本番の通知（livemode=true）は受け付けない
 *  3) 通知の ID ごとに処理済みを記録し、重複・再送は1回だけ処理する（webhookEvents）
 *  4) 通知の中身は信用せず、Stripe API から取り直して処理する（stripe-confirm.ts）
 *  処理に失敗したら 500 を返して Stripe に再送させる。関係ない通知は 200 で受け流す。
 */
export async function POST(req: Request): Promise<Response> {
  if (!stripeTestConfig().ok) return new NextResponse("Not found", { status: 404 });
  const rawBody = await req.text();
  if (Buffer.byteLength(rawBody, "utf8") > MAX_BODY) return new NextResponse("Payload too large", { status: 413 });

  let event: Stripe.Event;
  try {
    event = stripeClient().webhooks.constructEvent(rawBody, req.headers.get("stripe-signature") ?? "", stripeWebhookSecret(), 300);
  } catch {
    return new NextResponse("Invalid signature", { status: 400 });
  }
  if (event.livemode) {
    console.error("[stripe-webhook] live event rejected", { eventId: event.id });
    return new NextResponse("Live events are not accepted", { status: 400 });
  }

  if (!(await beginWebhookEvent("stripe", event.id, event.type))) {
    return NextResponse.json({ received: true, duplicate: true });
  }
  try {
    const outcome = await handle(event);
    await finishWebhookEvent("stripe", event.id);
    return NextResponse.json({ received: true, outcome });
  } catch (e) {
    console.error("[stripe-webhook] processing failed", { eventId: event.id, type: event.type, error: (e as Error).name });
    return new NextResponse("error", { status: 500 });
  }
}

async function handle(event: Stripe.Event): Promise<string> {
  switch (event.type) {
    case "checkout.session.completed":
    case "checkout.session.async_payment_succeeded": {
      const r = await confirmStripeCheckout((event.data.object as Stripe.Checkout.Session).id);
      if (r.status === "rejected") console.error("[stripe-webhook] payment rejected", { eventId: event.id, reason: r.reason });
      return r.status;
    }
    case "checkout.session.expired":
      return (await closeStripeCheckout((event.data.object as Stripe.Checkout.Session).id)) || "unchanged";
    case "checkout.session.async_payment_failed":
      // 非同期の支払い（PayPay など）の失敗。Session を取り直して「手続き済み・未払い」のときだけ注文を失敗にする
      return (await closeStripeCheckout((event.data.object as Stripe.Checkout.Session).id, { asyncFailed: true })) || "unchanged";
    case "charge.refunded":
      return syncStripeRefunds((event.data.object as Stripe.Charge).id);
    case "refund.created":
    case "refund.updated":
    case "refund.failed":
    case "charge.refund.updated": {
      // 返金の処理中・成功・失敗。返金の一覧を Stripe API から取り直して反映する
      const charge = (event.data.object as Stripe.Refund).charge;
      const chargeId = typeof charge === "string" ? charge : charge?.id;
      return chargeId ? syncStripeRefunds(chargeId) : "ignored";
    }
    case "charge.updated":
    case "charge.succeeded":
      // 手数料の確定（推定値で記録した決済だけ更新する）
      return (await refreshStripeFee((event.data.object as Stripe.Charge).id)) ? "fee_updated" : "unchanged";
    default:
      return "ignored";
  }
}
