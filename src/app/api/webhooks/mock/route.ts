import { NextResponse } from "next/server";
import { env } from "@/lib/env";
import { handleWebhook } from "@/lib/payments/webhook-handler";

/** テスト決済用。ENABLE_TEST_PAYMENT=true 以外では存在しないものとして 404 */
export async function POST(req: Request) {
  if (!env().TEST_PAYMENT_ENABLED) return new NextResponse("not found", { status: 404 });
  return handleWebhook("mock", req);
}
