import { jsonError, jsonOk } from "@/lib/api";
import { getAccessToken } from "@/lib/cookies";
import { getCheckoutStatus } from "@/lib/services/checkout";
import { rateLimit } from "@/lib/security/rate-limit";
import { clientKey } from "@/lib/security/request";
import { notePaymentApiError } from "@/lib/services/payment-monitor";

export async function GET(req: Request) {
  // 注文の Cookie が無い・形式が正しくない（getAccessToken が null）：注文は見つからないので、
  // Firestore に触れずに従来と同じ応答（期限切れ）を返す。レート制限の書き込みもしない（無料枠を消費させない）
  const token = await getAccessToken();
  if (!token) return jsonOk({ status: "expired" });
  if (!(await rateLimit(`status:${clientKey(req.headers)}`, 120, 60))) {
    return jsonError(429, "rate_limited", "しばらくしてから再度お試しください。");
  }
  try {
    return jsonOk(await getCheckoutStatus(token));
  } catch (e) {
    console.error("[api/checkout/status] failed", (e as Error).message);
    await notePaymentApiError("checkout_status", 500, (e as Error)?.name);
    return jsonError(500, "internal", "状態を確認できませんでした。");
  }
}
