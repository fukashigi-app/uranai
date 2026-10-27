import { z } from "zod";
import { guardPost, jsonError, jsonOk, paymentStopResponse, readJson } from "@/lib/api";
import { serviceStopReason } from "@/lib/env";
import { getAccessToken, getQrStoreCode, setAccessCookie } from "@/lib/cookies";
import { getFortuneSession } from "@/lib/services/fortune";
import { CheckoutError, createCheckout, getCheckoutByToken } from "@/lib/services/checkout";
import { isStripeProviderSelected, stripeCheckoutAccess } from "@/lib/payments/stripe-access";
import { STRIPE_SESSION_TTL_MS } from "@/lib/payments/stripe-checkout";
import { clearFreeSessions } from "@/lib/services/test-store";

const bodySchema = z.object({ fortuneType: z.enum(["BIRTHDAY", "ZODIAC", "BLOOD"]) }).strict();

/** 決済セッション作成。金額・店舗はサーバー側で決定する（body に金額や storeId は受け付けない） */
export async function POST(req: Request) {
  // Stripe Checkout：運営アカウントのテスト決済（Preview・ローカル。開発モード・準備中でも使える）、
  // または一般のお客さん（公開中で PAYMENT_PROVIDER=stripe のとき。今は Sandbox だけ）。設定が欠けていたら使わない。
  // それ以外は、危険な設定・開発モード・準備中のとき、誰に対しても決済を受け付けない（サーバー側で判定）
  const stripe = await stripeCheckoutAccess();
  if (!stripe.ok) {
    const stopped = paymentStopResponse(serviceStopReason());
    if (stopped) return stopped;
    // Stripe を選んでいるのに使えない（本番決済は未実装・設定の不足）：疑似決済などへは切り替えない
    if (isStripeProviderSelected()) return jsonError(503, "payment_unavailable", "ただいまお支払いを受け付けていません。");
  }
  const blocked = await guardPost(req, "checkout", 20, 60);
  if (blocked) return blocked;
  let body;
  try {
    body = bodySchema.parse(await readJson(req));
  } catch {
    return jsonError(400, "invalid_request", "占いの種類を選び直してください。");
  }
  // 支払い済みで未使用の権利・処理中の決済がある場合は、Cookie を上書きせずそちらへ誘導（権利の消失・二重決済防止）
  const current = await getAccessToken();
  if (current) {
    if ((await getFortuneSession(current)).state === "paid") {
      return jsonError(409, "paid_session_exists", "お支払い済みの占いがあります。先にそちらをお楽しみください。");
    }
    const co = await getCheckoutByToken(current);
    if (co?.checkout.status === "PROCESSING") {
      return jsonError(409, "payment_processing", "お支払いを確認中です。確認画面に戻ります。");
    }
  }
  try {
    // 有料フローは店舗QR必須（テストモードは /api/test-fortune を使う）
    const { checkoutId, accessToken } = await createCheckout(
      await getQrStoreCode(),
      body.fortuneType,
      stripe.ok ? { provider: "stripe", ttlMs: STRIPE_SESSION_TTL_MS } : {},
    );
    await setAccessCookie(accessToken);
    // Stripe の決済：無料の占いの Cookie（fx_dev など）が残っていると、支払い後の入力・結果の画面で
    // 無料の占いが優先されてしまうため消す（有料の占い権利を確実に使えるように）
    if (stripe.ok) await clearFreeSessions();
    return jsonOk({ checkoutId }, 201);
  } catch (e) {
    if (e instanceof CheckoutError) return jsonError(e.httpStatus, e.code, e.userMessage);
    console.error("[api/checkout] failed", (e as Error).message);
    return jsonError(500, "internal", "エラーが発生しました。時間をおいて再度お試しください。");
  }
}
