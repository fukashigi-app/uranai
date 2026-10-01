import { NextResponse } from "next/server";
import { isTestPaymentEnabled } from "@/lib/env";

/** 旧テスト入口。テスト店舗のページ（/s/test）へ転送する。テストモード OFF では 404 */
export async function GET(req: Request) {
  if (!isTestPaymentEnabled()) return new NextResponse("Not Found", { status: 404 });
  return NextResponse.redirect(new URL("/s/test", req.url), 303);
}
