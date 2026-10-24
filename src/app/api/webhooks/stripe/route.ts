import { NextResponse } from "next/server";
import { verifyStripeWebhook } from "@/lib/payments/stripe-checkout";

/**
 * Preview-only Stripe webhook verification endpoint.
 * This is deliberately fail-closed until payment reconciliation is implemented.
 * No Firestore writes or entitlement grants are performed here.
 */
export async function POST(request: Request): Promise<Response> {
  if (process.env.VERCEL_ENV !== "preview") {
    return new NextResponse("Not found", { status: 404 });
  }

  const rawBody = await request.text();
  if (Buffer.byteLength(rawBody, "utf8") > 256 * 1024) {
    return new NextResponse("Payload too large", { status: 413 });
  }

  try {
    const event = verifyStripeWebhook(rawBody, request.headers.get("stripe-signature"));
    console.info("[stripe-webhook] verified but processing disabled", {
      eventId: event.id,
      type: event.type,
    });
    // Do not acknowledge success before durable, idempotent processing exists.
    return new NextResponse("Processing not enabled", { status: 503 });
  } catch {
    return new NextResponse("Unauthorized", { status: 401 });
  }
}
