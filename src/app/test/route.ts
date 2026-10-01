import { NextResponse } from "next/server";
import { isTestPaymentEnabled, secureCookiesEnabled } from "@/lib/env";
import { ensureTestStore } from "@/lib/services/test-store";
import { QR_STORE_COOKIE } from "@/lib/cookies";

/**
 * 動作確認用の入口（QRの代わり）。テスト店舗を選んだ状態で占い選択へ進む。
 * ENABLE_TEST_PAYMENT=true のときだけ有効。それ以外は存在しないものとして 404。
 */
export async function GET(req: Request) {
  if (!isTestPaymentEnabled()) return new NextResponse("Not Found", { status: 404 });
  const store = await ensureTestStore();
  const res = NextResponse.redirect(new URL("/fortune", req.url), 303);
  res.cookies.set(QR_STORE_COOKIE, store.storeCode, { httpOnly: true, secure: secureCookiesEnabled(), sameSite: "lax", path: "/", maxAge: 60 * 60 * 6 });
  res.headers.set("Cache-Control", "no-store");
  return res;
}
