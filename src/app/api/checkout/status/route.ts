import { jsonError, jsonOk } from "@/lib/api";
import { getAccessToken } from "@/lib/cookies";
import { getCheckoutStatus } from "@/lib/services/checkout";
import { rateLimit } from "@/lib/security/rate-limit";
import { clientKey } from "@/lib/security/request";
import { notePaymentApiError } from "@/lib/services/payment-monitor";

export async function GET(req: Request) {
  if (!(await rateLimit(`status:${clientKey(req.headers)}`, 120, 60))) {
    return jsonError(429, "rate_limited", "しばらくしてから再度お試しください。");
  }
  try {
    return jsonOk(await getCheckoutStatus(await getAccessToken()));
  } catch (e) {
    console.error("[api/checkout/status] failed", (e as Error).message);
    await notePaymentApiError("checkout_status", 500, (e as Error)?.name);
    return jsonError(500, "internal", "状態を確認できませんでした。");
  }
}
