import "server-only";
import type Stripe from "stripe";
import type { StripeRuntime } from "./stripe-checkout";
import { closeStripeCheckout, confirmStripeCheckout, refreshStripeFee, syncStripeRefunds } from "./stripe-confirm";
import { beginWebhookEvent, finishWebhookEvent } from "@/lib/firestore/payments";

/**
 * Stripe の Webhook の処理（モードは Stripe との接続 rt で決まる。アプリの route からは stripeRuntime()＝今はテストだけを渡す）。
 *  1) 生の本文で署名を確認（Stripe 公式 SDK。5分以内の通知だけ）。署名の値はモードごとに別（本番と Sandbox の送信先は別）
 *  2) 通知の livemode がモードと一致しなければ拒否（テストの環境に本番の通知、本番の環境にテストの通知を受け付けない）
 *  3) 通知の ID ごとに処理済みを記録し、重複・再送は1回だけ処理する（webhookEvents）。途中で止まった通知は再送で処理し直す
 *  4) 通知の中身は信用せず、Stripe API から取り直して処理する（stripe-confirm.ts。こちらもモードを照合する）
 * 処理に失敗したら 500 を返して Stripe に再送させる。関係ない通知は 200 で受け流す。
 */
export type StripeWebhookResult = { status: number; body: Record<string, unknown> | string };

export async function handleStripeWebhook(rawBody: string, signature: string | null, rt: StripeRuntime): Promise<StripeWebhookResult> {
  let event: Stripe.Event;
  try {
    event = rt.client.webhooks.constructEvent(rawBody, signature ?? "", rt.webhookSecret, 300);
  } catch {
    return { status: 400, body: "Invalid signature" };
  }
  if (event.livemode !== (rt.mode === "live")) {
    console.error("[stripe-webhook] event mode mismatch", { eventId: event.id, mode: rt.mode });
    return { status: 400, body: rt.mode === "live" ? "Test events are not accepted" : "Live events are not accepted" };
  }

  if (!(await beginWebhookEvent("stripe", event.id, event.type))) {
    return { status: 200, body: { received: true, duplicate: true } };
  }
  try {
    const outcome = await handle(event, rt);
    await finishWebhookEvent("stripe", event.id);
    return { status: 200, body: { received: true, outcome } };
  } catch (e) {
    console.error("[stripe-webhook] processing failed", { eventId: event.id, type: event.type, error: (e as Error).name });
    return { status: 500, body: "error" };
  }
}

async function handle(event: Stripe.Event, rt: StripeRuntime): Promise<string> {
  switch (event.type) {
    case "checkout.session.completed":
    case "checkout.session.async_payment_succeeded": {
      const r = await confirmStripeCheckout((event.data.object as Stripe.Checkout.Session).id, rt);
      if (r.status === "rejected") console.error("[stripe-webhook] payment rejected", { eventId: event.id, reason: r.reason });
      return r.status;
    }
    case "checkout.session.expired":
      return (await closeStripeCheckout((event.data.object as Stripe.Checkout.Session).id, {}, rt)) || "unchanged";
    case "checkout.session.async_payment_failed":
      // 非同期の支払い（PayPay など）の失敗。Session を取り直して「手続き済み・未払い」のときだけ注文を失敗にする
      return (await closeStripeCheckout((event.data.object as Stripe.Checkout.Session).id, { asyncFailed: true }, rt)) || "unchanged";
    case "charge.refunded":
      return syncStripeRefunds((event.data.object as Stripe.Charge).id, rt);
    case "refund.created":
    case "refund.updated":
    case "refund.failed":
    case "charge.refund.updated": {
      // 返金の処理中・成功・失敗。返金の一覧を Stripe API から取り直して反映する
      const charge = (event.data.object as Stripe.Refund).charge;
      const chargeId = typeof charge === "string" ? charge : charge?.id;
      return chargeId ? syncStripeRefunds(chargeId, rt) : "ignored";
    }
    case "charge.updated":
    case "charge.succeeded":
      // 手数料の確定（推定値で記録した決済だけ更新する）
      return (await refreshStripeFee((event.data.object as Stripe.Charge).id, rt)) ? "fee_updated" : "unchanged";
    default:
      return "ignored";
  }
}
