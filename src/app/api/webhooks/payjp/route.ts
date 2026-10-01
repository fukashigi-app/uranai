import { handleWebhook } from "@/lib/payments/webhook-handler";

/** PAY.JP 管理画面で https://<APP_URL>/api/webhooks/payjp を登録する */
export async function POST(req: Request) {
  return handleWebhook("payjp", req);
}
