import { jsonError, jsonOk } from "@/lib/api";
import { getAccessToken } from "@/lib/cookies";
import { getCheckoutStatus } from "@/lib/services/checkout";
import { rateLimit } from "@/lib/security/rate-limit";
import { clientKey } from "@/lib/security/request";

export async function GET(req: Request) {
  if (!(await rateLimit(`status:${clientKey(req.headers)}`, 120, 60))) {
    return jsonError(429, "rate_limited", "しばらくしてから再度お試しください。");
  }
  try {
    return jsonOk(await getCheckoutStatus(await getAccessToken()));
  } catch (e) {
    console.error("[api/checkout/status] failed", (e as Error).message);
    return jsonError(500, "internal", "状態を確認できませんでした。");
  }
}
