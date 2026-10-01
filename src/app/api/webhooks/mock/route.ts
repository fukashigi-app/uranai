import { NextResponse } from "next/server";
import { env } from "@/lib/env";
import { handleWebhook } from "@/lib/payments/webhook-handler";

/** 自動テスト用の疑似決済。PAYMENT_PROVIDER=mock 以外では存在しないものとして 404 */
export async function POST(req: Request) {
  if (env().PAYMENT_PROVIDER !== "mock") return new NextResponse("not found", { status: 404 });
  return handleWebhook("mock", req);
}
