import "server-only";
import type Stripe from "stripe";
import type { StripeRuntime } from "./stripe-checkout";
import { closeStripeCheckout, confirmStripeCheckout, refreshStripeFee, syncStripeDispute, syncStripeRefunds } from "./stripe-confirm";
import { beginWebhookEvent, finishWebhookEvent } from "@/lib/firestore/payments";
import { recordPaymentReview } from "@/lib/firestore/payment-reviews";
import { recordPaymentAlert } from "@/lib/firestore/payment-alerts";
import { alertKindForWebhookEvent, alertModeOf, hourBucket, newThrottleState, throttleTick } from "./monitor-rules";

/**
 * Stripe の Webhook の処理（モードは Stripe との接続 rt で決まる。アプリの route からは stripeRuntime()＝今はテストだけを渡す）。
 *  1) 生の本文で署名を確認（Stripe 公式 SDK。5分以内の通知だけ）。署名の値はモードごとに別（本番と Sandbox の送信先は別）
 *  2) 通知の livemode がモードと一致しなければ拒否（テストの環境に本番の通知、本番の環境にテストの通知を受け付けない）。
 *     署名が正しい通知だけ、運営が気付けるよう決済要確認に記録する。署名が不正な通知は何も記録しない
 *  3) 通知の ID ごとに処理済みを記録し、重複・再送は1回だけ処理する（webhookEvents）。途中で止まった通知は再送で処理し直す
 *  4) 通知の中身は信用せず、Stripe API から取り直して処理する（stripe-confirm.ts。こちらもモードを照合する）
 * 処理に失敗したら 500 を返して Stripe に再送させる。関係ない通知は 200 で受け流す。
 */
const signatureThrottle = newThrottleState();
async function noteInvalidSignature() {
  const n = throttleTick(signatureThrottle, Date.now());
  if (!n) return; // 今回は書き込まない（メモリ上で数えるだけ。応答を待たせない）
  const now = new Date();
  const ok = await recordPaymentAlert({ kind: "webhook_signature_invalid", objectType: "webhook", objectId: `stripe:${hourBucket(now)}`, mode: "unknown", observedCount: n }, now);
  if (!ok) signatureThrottle.pending += n; // 書き込めなかった分は次の書き込みに回す
}

export type StripeWebhookResult = { status: number; body: Record<string, unknown> | string };

export async function handleStripeWebhook(rawBody: string, signature: string | null, rt: StripeRuntime): Promise<StripeWebhookResult> {
  let event: Stripe.Event;
  try {
    event = rt.client.webhooks.constructEvent(rawBody, signature ?? "", rt.webhookSecret, 300);
  } catch {
    // 署名を確認できない通知は信用しない（中身・署名は記録しない）。1時間ごとに1件の記録で件数だけを数える。
    // 大量に届いても書き込みが集中しないよう、書き込みは1分に1回まで（間の件数はまとめて加算。正確な総数ではない）
    await noteInvalidSignature();
    return { status: 400, body: "Invalid signature" };
  }
  if (event.livemode !== (rt.mode === "live")) {
    console.error("[stripe-webhook] event mode mismatch", { eventId: event.id, mode: rt.mode });
    // 署名は正しいが本番とテストの取り違え（送信先・署名の値の設定の誤り）：受け付けずに決済要確認に記録する（対象ごとに1件）
    const objId = (event.data?.object as { id?: unknown } | undefined)?.id;
    await recordPaymentReview({ kind: "mode_mismatch", objectType: "event", objectId: typeof objId === "string" ? objId : event.id, eventType: event.type, livemode: event.livemode });
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
    // 署名を確認できた通知の処理の失敗（Stripe が再送する）。通知ごとに1件（再送は回数だけ増える）
    await recordPaymentAlert({ kind: alertKindForWebhookEvent(event.type), objectType: "event", objectId: event.id, eventType: event.type, mode: alertModeOf(event.livemode), errorName: (e as Error)?.name ?? null });
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
      return syncStripeRefunds((event.data.object as Stripe.Charge).id, rt, event.type);
    case "refund.created":
    case "refund.updated":
    case "refund.failed":
    case "charge.refund.updated": {
      // 返金の処理中・成功・失敗。返金の一覧を Stripe API から取り直して反映する
      const charge = (event.data.object as Stripe.Refund).charge;
      const chargeId = typeof charge === "string" ? charge : charge?.id;
      return chargeId ? syncStripeRefunds(chargeId, rt, event.type) : "ignored";
    }
    case "charge.dispute.created":
    case "charge.dispute.updated":
    case "charge.dispute.closed":
    case "charge.dispute.funds_withdrawn":
    case "charge.dispute.funds_reinstated":
      // 異議申し立て（チャージバック）。状態・金額は Stripe API から取り直して反映する
      return syncStripeDispute((event.data.object as Stripe.Dispute).id, rt, event.type);
    case "charge.updated":
    case "charge.succeeded":
      // 手数料の確定（推定値で記録した決済だけ更新する）
      return (await refreshStripeFee((event.data.object as Stripe.Charge).id, rt)) ? "fee_updated" : "unchanged";
    default:
      return "ignored";
  }
}
