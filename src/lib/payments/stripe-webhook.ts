import "server-only";
import type Stripe from "stripe";
import type { StripeRuntime } from "./stripe-checkout";
import { closeStripeCheckout, confirmStripeCheckout, refreshStripeFee, syncStripeDispute, syncStripeRefunds } from "./stripe-confirm";
import { acquireWebhookEventLease, finishWebhookEventWithLease, recordWebhookEventFailure } from "@/lib/firestore/payments";
import { stripeEventMeta, webhookErrorNameOf } from "./webhook-event-state";
import { recordPaymentReview } from "@/lib/firestore/payment-reviews";
import { recordPaymentAlert } from "@/lib/firestore/payment-alerts";
import { alertKindForWebhookEvent, alertModeOf, hourBucket, newThrottleState, throttleTick } from "./monitor-rules";

/**
 * Stripe の Webhook の処理（モードは Stripe との接続 rt で決まる。アプリの route からは stripeRuntime()＝今はテストだけを渡す）。
 *  1) 生の本文で署名を確認（Stripe 公式 SDK。5分以内の通知だけ）。署名の値はモードごとに別（本番と Sandbox の送信先は別）
 *  2) 通知の livemode がモードと一致しなければ拒否（テストの環境に本番の通知、本番の環境にテストの通知を受け付けない）。
 *     署名が正しい通知だけ、運営が気付けるよう決済要確認に記録する。署名が不正な通知は何も記録しない
 *  3) 通知の ID ごとに処理済みを記録し、重複・再送は1回だけ処理する（webhookEvents）。途中で止まった通知は再送で処理し直す。
 *     処理の状態（RECEIVED→PROCESSED、失敗は RETRYABLE）・回数・最後のエラーの名前・対象の ID も記録する（webhook-event-state.ts）。
 *     処理は処理権（lease：処理ごとのランダムな値と期限）を取ってから始める。同じ通知を別の処理が期限内に処理中なら、処理せずに
 *     409 を返す（処理済みにしない。Stripe が後で再送し、その時には処理済みなら 200、処理が止まっていれば期限切れの後に処理し直す）。
 *     完了・失敗の記録は処理権を持つ処理だけが書く（期限切れの後に古い処理が終わっても、新しい処理の状態を上書きしない）
 *  4) 通知の中身は信用せず、Stripe API から取り直して処理する（stripe-confirm.ts。こちらもモードを照合する）
 *  5) 同じ Sandbox を使う別の環境（別の Firestore）の決済の通知は、Stripe から取り直した metadata の環境を表す値で見分ける
 *     （stripeEnvTag。通知の ID・livemode だけでは見分けられない）。この環境に記録が無ければ何も書かず、IGNORED_OTHER_ENV
 *     として処理済みにする（決済要確認の「決済記録が無い」を出さない）。値が無い以前の決済は今までどおり。値が違うのに
 *     この環境に記録があるときは判断せずに例外（処理済みにしない）
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
/** processStripeEvent の結果。500 のときは記録したエラーの名前も返す（復旧の結果の記録用。応答には使わない） */
export type StripeEventProcessResult = StripeWebhookResult & { errorName?: string };

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
  const r = await processStripeEvent(event, rt);
  return { status: r.status, body: r.body };
}

/**
 * 信頼できる Stripe の通知（署名を確認した通知、または Stripe API から取り直した通知）を処理する（上の 2〜4）。
 * Webhook の受信と、通知の復旧（webhook-recovery.ts。Stripe API の events.retrieve で取り直した通知）が共通で使う。
 * 呼び出し側は、署名の確認か Stripe API からの取得のどちらかを必ず済ませること（保存した中身・外から渡された中身は渡さない）。
 */
export async function processStripeEvent(event: Stripe.Event, rt: StripeRuntime): Promise<StripeEventProcessResult> {
  if (event.livemode !== (rt.mode === "live")) {
    console.error("[stripe-webhook] event mode mismatch", { eventId: event.id, mode: rt.mode });
    // 署名は正しいが本番とテストの取り違え（送信先・署名の値の設定の誤り）：受け付けずに決済要確認に記録する（対象ごとに1件）
    const objId = (event.data?.object as { id?: unknown } | undefined)?.id;
    await recordPaymentReview({ kind: "mode_mismatch", objectType: "event", objectId: typeof objId === "string" ? objId : event.id, eventType: event.type, livemode: event.livemode });
    return { status: 400, body: rt.mode === "live" ? "Test events are not accepted" : "Live events are not accepted" };
  }

  // 処理権の取得に失敗したら例外（今までどおり。route が 500 を返し、Stripe が再送する）
  const lease = await acquireWebhookEventLease("stripe", event.id, event.type, stripeEventMeta(event));
  if (lease.status === "processed") return { status: 200, body: { received: true, duplicate: true } };
  if (lease.status === "busy") {
    // 別の処理が処理中。処理済みにはしない（2xx を返すと Stripe は再送しない。処理中の処理が止まっていたら取りこぼす）
    console.warn("[stripe-webhook] event is being processed by another delivery", { eventId: event.id, type: event.type });
    return { status: 409, body: "Event is being processed" };
  }
  try {
    const outcome = await handle(event, rt);
    await rt.testHooks?.beforeFinishWebhookEvent?.(event.id);
    const finished = await finishWebhookEventWithLease("stripe", event.id, lease.token, outcome === OTHER_ENV ? "IGNORED_OTHER_ENV" : "PROCESSED");
    // 処理権を失っていた（期限切れの後に別の処理が取り直した）：処理済みにせず 500（新しい処理か Stripe の再送で処理済みにする。反映は冪等）
    if (finished === "lease_lost") throw Object.assign(new Error("webhook event lease was taken over by another delivery"), { name: "WebhookLeaseLost" });
    return { status: 200, body: { received: true, outcome } };
  } catch (e) {
    console.error("[stripe-webhook] processing failed", { eventId: event.id, type: event.type, error: (e as Error).name });
    // 処理済みにしない（processedAt を書かない）。処理権を持っていれば RETRYABLE にして処理権を外す（記録できなくても応答は変えない。
    // RECEIVED のまま残り、処理権は期限で切れる）。処理権を失っていれば何も書かない
    if (!rt.testHooks?.skipFailureStateRecord?.(event.id)) await recordWebhookEventFailure("stripe", event.id, webhookErrorNameOf(e), lease.token);
    // 署名を確認できた通知の処理の失敗（Stripe が再送する）。通知ごとに1件（再送は回数だけ増える）
    await recordPaymentAlert({ kind: alertKindForWebhookEvent(event.type), objectType: "event", objectId: event.id, eventType: event.type, mode: alertModeOf(event.livemode), errorName: (e as Error)?.name ?? null });
    return { status: 500, body: "error", errorName: webhookErrorNameOf(e) };
  }
}

/** 別の環境の決済の通知として扱った結果（handle の戻り値） */
const OTHER_ENV = "ignored_other_env";

async function handle(event: Stripe.Event, rt: StripeRuntime): Promise<string> {
  switch (event.type) {
    case "checkout.session.completed":
    case "checkout.session.async_payment_succeeded": {
      const r = await confirmStripeCheckout((event.data.object as Stripe.Checkout.Session).id, rt);
      if (r.status === "rejected" && r.reason !== "other_environment") console.error("[stripe-webhook] payment rejected", { eventId: event.id, reason: r.reason });
      // 決済確定の後の再確認が失敗した（決済記録は PENDING のまま）：処理済みにせず 500 を返し、Stripe の再送で再確認する
      if (r.recheck === "pending") throw Object.assign(new Error("recheck after confirmation is pending"), { name: "StripeRecheckPendingError" });
      if (r.status === "rejected" && r.reason === "other_environment") return OTHER_ENV;
      return r.status;
    }
    case "checkout.session.expired":
      return (await closeStripeCheckout((event.data.object as Stripe.Checkout.Session).id, {}, rt)) || "unchanged";
    case "checkout.session.async_payment_failed":
      // 非同期の支払い（PayPay など）の失敗。Session を取り直して「手続き済み・未払い」のときだけ注文を失敗にする
      return (await closeStripeCheckout((event.data.object as Stripe.Checkout.Session).id, { asyncFailed: true }, rt)) || "unchanged";
    case "charge.refunded":
      return syncStripeRefunds((event.data.object as Stripe.Charge).id, rt, event.type, event.id);
    case "refund.created":
    case "refund.updated":
    case "refund.failed":
    case "charge.refund.updated": {
      // 返金の処理中・成功・失敗。返金の一覧を Stripe API から取り直して反映する
      const charge = (event.data.object as Stripe.Refund).charge;
      const chargeId = typeof charge === "string" ? charge : charge?.id;
      return chargeId ? syncStripeRefunds(chargeId, rt, event.type, event.id) : "ignored";
    }
    case "charge.dispute.created":
    case "charge.dispute.updated":
    case "charge.dispute.closed":
    case "charge.dispute.funds_withdrawn":
    case "charge.dispute.funds_reinstated":
      // 異議申し立て（チャージバック）。状態・金額は Stripe API から取り直して反映する
      return syncStripeDispute((event.data.object as Stripe.Dispute).id, rt, event.type, event.id);
    case "charge.updated":
    case "charge.succeeded":
      // 手数料の確定（推定値で記録した決済だけ更新する）
      return (await refreshStripeFee((event.data.object as Stripe.Charge).id, rt)) ? "fee_updated" : "unchanged";
    default:
      return "ignored";
  }
}
