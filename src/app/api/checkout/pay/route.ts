import { z } from "zod";
import { guardPost, jsonError, jsonOk, readJson } from "@/lib/api";
import { serviceStopReason } from "@/lib/env";
import { getAccessToken } from "@/lib/cookies";
import { CheckoutError, payCheckout } from "@/lib/services/checkout";

// 金額は受け取らない。カードトークン（決済代行が発行）のみ
const bodySchema = z.object({ cardToken: z.string().min(1).max(200).regex(/^[A-Za-z0-9_]+$/) }).strict();

export async function POST(req: Request) {
  // 本番で危険な設定（ENABLE_TEST_PAYMENT=true・PAYMENT_PROVIDER=mock）のままのときは、実際の課金へ切り替えずに受付を停止する（安全側）
  const stop = serviceStopReason();
  if (stop === "dangerous_config") return jsonError(503, "service_paused", "ただいま占いの受付を一時停止しています。しばらくしてからお試しください。");
  // 準備中モード（SITE_STATUS=coming_soon）
  if (stop === "coming_soon") return jsonError(503, "coming_soon", "ただいま準備中です。公開まで今しばらくお待ちください。");
  const blocked = await guardPost(req, "pay", 10, 60);
  if (blocked) return blocked;
  let body;
  try {
    body = bodySchema.parse(await readJson(req));
  } catch {
    return jsonError(400, "invalid_request", "カード情報を確認できませんでした。もう一度入力してください。");
  }
  try {
    const result = await payCheckout(await getAccessToken(), body.cardToken);
    if (result.status === "failed") return jsonError(402, "payment_failed", result.message);
    return jsonOk(result);
  } catch (e) {
    if (e instanceof CheckoutError) return jsonError(e.httpStatus, e.code, e.userMessage);
    console.error("[api/checkout/pay] failed", (e as Error).message);
    return jsonError(500, "internal", "決済処理でエラーが発生しました。お支払い状況を確認してから再度お試しください。");
  }
}
