import { z } from "zod";
import { guardPost, jsonError, jsonOk, paymentStopResponse, readJson } from "@/lib/api";
import { env, serviceStopReason } from "@/lib/env";
import { getAccessToken } from "@/lib/cookies";
import { CheckoutError, payCheckout } from "@/lib/services/checkout";
import { notePaymentApiError } from "@/lib/services/payment-monitor";

// 金額は受け取らない。疑似決済のトークン（mock_tok_…）だけ
const bodySchema = z.object({ cardToken: z.string().min(1).max(200).regex(/^[A-Za-z0-9_]+$/) }).strict();

/**
 * 疑似決済（自動テスト専用）の支払い。PAYMENT_PROVIDER=mock のときだけ存在し、それ以外（Stripe・未設定・Vercel の本番）では 404。
 * 実際の決済は Stripe Checkout（/api/checkout/stripe-session）。PAY.JP のカード決済の受付は廃止した。
 */
export async function POST(req: Request) {
  if (env().PAYMENT_PROVIDER !== "mock") return jsonError(404, "not_found", "ただいまお支払いを受け付けていません。");
  // 危険な設定・開発モード・準備中のときは、誰に対しても決済を受け付けない（サーバー側で判定。運営アカウントも例外なし）
  const stopped = paymentStopResponse(serviceStopReason());
  if (stopped) return stopped;
  const blocked = await guardPost(req, "pay", 10, 60);
  if (blocked) return blocked;
  let body;
  try {
    body = bodySchema.parse(await readJson(req));
  } catch {
    return jsonError(400, "invalid_request", "お支払いの内容を確認できませんでした。もう一度お試しください。");
  }
  try {
    const result = await payCheckout(await getAccessToken(), body.cardToken);
    if (result.status === "failed") return jsonError(402, "payment_failed", result.message);
    return jsonOk(result);
  } catch (e) {
    if (e instanceof CheckoutError) return jsonError(e.httpStatus, e.code, e.userMessage);
    console.error("[api/checkout/pay] failed", (e as Error).message);
    await notePaymentApiError("checkout_pay", 500, (e as Error)?.name);
    return jsonError(500, "internal", "決済処理でエラーが発生しました。お支払い状況を確認してから再度お試しください。");
  }
}
