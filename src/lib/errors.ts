import "server-only";
import { activeProvider, PaymentUnavailableError } from "@/lib/payments";
import type { PaymentProvider } from "@/lib/payments/types";

/** 決済まわりのエラー（利用者向けの日本語メッセージ付き） */
export class CheckoutError extends Error {
  constructor(
    public readonly code: string,
    public readonly userMessage: string,
    public readonly httpStatus = 400,
  ) {
    super(code);
  }
}

/** 占い実行まわりのエラー */
export class FortuneError extends Error {
  constructor(
    public readonly code: string,
    public readonly userMessage: string,
    public readonly httpStatus = 400,
  ) {
    super(code);
  }
}

/** 同じメールアドレスのアカウントが既にある */
export class DuplicateEmailError extends Error {}

/** 有料フローで使う決済プロバイダ。未設定なら利用者向けエラー */
export function providerOrThrow(): PaymentProvider {
  try {
    return activeProvider();
  } catch (e) {
    if (e instanceof PaymentUnavailableError) {
      throw new CheckoutError("payment_unavailable", "ただいまお支払いを受け付けていません。お手数ですがお店のスタッフにお知らせください。", 503);
    }
    throw e;
  }
}

/** テスト店舗では有料決済を受け付けない（テストモードは決済を使わない別フロー） */
export const PAID_FLOW_BLOCKED_STORE_CODES = new Set(["test", "testmode0001"]);
