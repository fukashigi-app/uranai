import { z } from "zod";
import { guardPost, jsonError, jsonOk, readJson } from "@/lib/api";
import { getAccessToken, getQrStoreCode, setAccessCookie } from "@/lib/cookies";
import { getFortuneSession } from "@/lib/services/fortune";
import { CheckoutError, createCheckout, getCheckoutByToken } from "@/lib/services/checkout";

const bodySchema = z.object({ fortuneType: z.enum(["BIRTHDAY", "ZODIAC", "BLOOD"]) }).strict();

/** 決済セッション作成。金額・店舗はサーバー側で決定する（body に金額や storeId は受け付けない） */
export async function POST(req: Request) {
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
    const { checkoutId, accessToken } = await createCheckout(await getQrStoreCode(), body.fortuneType);
    await setAccessCookie(accessToken);
    return jsonOk({ checkoutId }, 201);
  } catch (e) {
    if (e instanceof CheckoutError) return jsonError(e.httpStatus, e.code, e.userMessage);
    console.error("[api/checkout] failed", (e as Error).message);
    return jsonError(500, "internal", "エラーが発生しました。時間をおいて再度お試しください。");
  }
}
