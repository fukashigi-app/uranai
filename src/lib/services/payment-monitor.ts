import "server-only";
import { isFirestore } from "@/lib/data-provider";
import type { PaymentAlertInput } from "@/lib/firestore/payment-alerts";

/**
 * 決済監視の記録の入口（アプリの API・画面から使う）。Firestore を使わないとき（PostgreSQL 版）は記録しない。
 * 記録の失敗は例外にしない（決済の応答を妨げない。サーバーのログに残す）。
 */
export async function recordPaymentMonitorAlert(input: PaymentAlertInput): Promise<void> {
  if (!isFirestore()) return;
  try {
    const { recordPaymentAlert } = await import("@/lib/firestore/payment-alerts");
    await recordPaymentAlert(input);
  } catch (e) {
    console.error("[payment-alert] record failed", { kind: input.kind, error: (e as Error)?.name });
  }
}

/** 決済の API の 5xx を記録する（1時間ごと・API ごとに1件） */
export async function notePaymentApiError(route: string, httpStatus: number, errorName?: string): Promise<void> {
  if (!isFirestore()) return;
  try {
    const { notePaymentApiError: note } = await import("@/lib/firestore/payment-alerts");
    await note(route, httpStatus, errorName);
  } catch (e) {
    console.error("[payment-alert] record failed", { kind: "payment_api_5xx", error: (e as Error)?.name });
  }
}
