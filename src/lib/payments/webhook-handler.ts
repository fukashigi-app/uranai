import "server-only";
import { NextResponse } from "next/server";
import { beginWebhookEvent, confirmCharge, finishWebhookEvent, markChargeFailed, markRefunded } from "./confirm";
import { getProvider } from "./index";
import { WebhookVerificationError, type ProviderId } from "./types";

/**
 * 決済代行のWebhook共通処理。
 * 1) 署名/トークン検証 2) イベント単位の冪等性 3) Charge をAPIから取り直して確定
 * 処理失敗時は 500 を返して決済代行に再送させる（confirmCharge は冪等）。
 */
export async function handleWebhook(providerId: ProviderId, req: Request): Promise<Response> {
  const rawBody = await req.text();
  if (rawBody.length > 256 * 1024) return new NextResponse("payload too large", { status: 413 });

  let event;
  try {
    event = await getProvider(providerId).parseWebhook(req.headers, rawBody);
  } catch (e) {
    if (e instanceof WebhookVerificationError) {
      console.warn(`[webhook:${providerId}] verification failed: ${e.message}`);
      return new NextResponse("unauthorized", { status: 401 });
    }
    throw e;
  }

  if (!(await beginWebhookEvent(providerId, event.eventId, event.kind === "ignored" ? event.type : event.kind))) {
    return NextResponse.json({ received: true, duplicate: true });
  }

  try {
    if (event.kind === "charge.succeeded") {
      const outcome = await confirmCharge(providerId, event.chargeId);
      if (outcome.status === "rejected") {
        console.error(`[webhook:${providerId}] charge rejected`, { chargeId: event.chargeId, reason: outcome.reason });
      }
    } else if (event.kind === "charge.refunded") {
      await markRefunded(providerId, event.chargeId);
    } else if (event.kind === "charge.failed") {
      await markChargeFailed(providerId, event.chargeId);
    }
    await finishWebhookEvent(providerId, event.eventId);
    return NextResponse.json({ received: true });
  } catch (e) {
    console.error(`[webhook:${providerId}] processing failed`, (e as Error).message);
    return new NextResponse("error", { status: 500 });
  }
}
