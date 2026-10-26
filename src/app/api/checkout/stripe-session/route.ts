import { guardPost, jsonError, jsonOk } from "@/lib/api";
import { env } from "@/lib/env";
import { getAccessToken } from "@/lib/cookies";
import { CheckoutError } from "@/lib/errors";
import { stripeCheckoutAccess } from "@/lib/payments/stripe-access";
import { startStripeCheckout } from "@/lib/payments/stripe-confirm";
import { stripeErrorSummary } from "@/lib/payments/stripe-checkout";
import { stripeTestConfig } from "@/lib/payments/stripe-guard";
import { stripeReturnOrigin } from "@/lib/payments/stripe-return-origin";

/**
 * Stripe の決済画面（Checkout）の URL を返す。運営アカウントのテスト決済、または一般のお客さんの決済（公開中で PAYMENT_PROVIDER=stripe）を
 * 受け付けているときだけ（stripeCheckoutAccess）。一般のお客さんはログイン不要（注文の Cookie で本人の注文を見つける）。
 * 注文はブラウザの Cookie から見つける（注文IDや金額はリクエストで受け付けない）。注文と Session を紐付けてから URL を返す。
 * 戻り先は決済を始めたドメイン（注文の Cookie があるドメイン）。同一オリジンの確認（guardPost）と、
 * このデプロイ自身の URL だけの許可リストで確かめる。許可されなければ公開URL（APP_URL）に戻す。
 */
export async function POST(req: Request) {
  const access = await stripeCheckoutAccess();
  if (!access.ok) return jsonError(404, "not_found", "ただいまお支払いを受け付けていません。");
  const blocked = await guardPost(req, "stripe-session", 10, 60);
  if (blocked) return blocked;
  try {
    const cfg = stripeTestConfig();
    const returnOrigin = stripeReturnOrigin(req.headers.get("origin"), env().APP_URL, cfg.ok ? cfg.mode : "preview");
    const r = await startStripeCheckout(await getAccessToken(), returnOrigin);
    // pending … Stripe 側で支払いの確定待ち（PayPay など）。新しい決済画面には移動させず、確認中の画面へ
    return jsonOk(r.status === "succeeded" ? { status: "succeeded" } : r.status === "pending" ? { status: "pending", url: r.returnUrl } : { status: "redirect", url: r.url });
  } catch (e) {
    if (e instanceof CheckoutError) return jsonError(e.httpStatus, e.code, e.userMessage);
    // Stripe のエラーは種類・コード・項目名・リクエストID だけを残す（エラー文・秘密情報は出さない。Stripe のログで照合できる）
    console.error("[api/checkout/stripe-session] failed", stripeErrorSummary(e));
    return jsonError(502, "stripe_unavailable", "決済画面を開けませんでした。少し時間をおいてから、もう一度お試しください。");
  }
}
