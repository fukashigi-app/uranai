import { z } from "zod";
import { guardPost, jsonError, jsonOk, readJson } from "@/lib/api";
import { getAccessToken } from "@/lib/cookies";
import { CheckoutError, payCheckout } from "@/lib/services/checkout";

// 金額は受け取らない。カードトークン（決済代行が発行）のみ
const bodySchema = z.object({ cardToken: z.string().min(1).max(200).regex(/^[A-Za-z0-9_]+$/) }).strict();

export async function POST(req: Request) {
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
