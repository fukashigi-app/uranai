/**
 * 占いの入力画面で、支払い済みで未使用の占い権利について出す案内の判定（表示だけ。権利の発行・消費・決済の処理は変えない）。
 *
 *  payment_completed    … 「お支払いが完了しました」。この権利の決済の確定（サーバーが記録した権利の作成時刻）から
 *                         PAYMENT_NOTICE_WINDOW_MS 以内で、運営が戻した権利ではなく、既存の権利の再利用の導線でもないときだけ
 *  existing_entitlement … 「購入済みの占い権利があります」。それ以外（以前の支払いの権利を使う・時間がたってから開いた・戻した権利）
 *
 * 判定の元はサーバーの記録（権利の作成時刻・戻した印）。URL の値（?entitlement=existing）は「支払い完了」を
 * 「購入済みの権利」の案内に下げるためにだけ使い、支払い完了の表示に上げる方向には使わない（URL を書き換えても支払い済みにはならない）。
 */
export const PAYMENT_NOTICE_WINDOW_MS = 10 * 60 * 1000;

/** 既存の未使用の権利の再利用の導線（占いの選択で、新しい注文を作らずに入力画面へ進んだ）を表す URL の値 */
export const EXISTING_ENTITLEMENT_PARAM = "entitlement";
export const EXISTING_ENTITLEMENT_VALUE = "existing";
export const EXISTING_ENTITLEMENT_PATH = `/fortune/input?${EXISTING_ENTITLEMENT_PARAM}=${EXISTING_ENTITLEMENT_VALUE}`;

export type EntitlementNotice = "payment_completed" | "existing_entitlement";

export const EXISTING_ENTITLEMENT_TITLE = "購入済みの占い権利があります";
export const EXISTING_ENTITLEMENT_BODY = "以前のお支払いで取得した未使用の占い権利を利用できます。今回は新しいお支払いは発生しません。";

export function entitlementNoticeFor(input: {
  /** 権利の作成時刻（決済の確定の時刻。サーバーの記録）。不明なら null */
  paidAt: Date | null;
  /** 運営が戻した権利（返金で止めた権利の復旧など） */
  restored: boolean;
  /** 既存の権利の再利用の導線から来た（URL の値。表示を下げる方向にだけ使う） */
  reuseHint: boolean;
  now: Date;
}): EntitlementNotice {
  if (input.reuseHint || input.restored || !input.paidAt) return "existing_entitlement";
  const age = input.now.getTime() - input.paidAt.getTime();
  // 時計のずれで少し未来の時刻になっていても、直後の支払いとして扱う（1分まで）
  if (age < -60_000 || age > PAYMENT_NOTICE_WINDOW_MS) return "existing_entitlement";
  return "payment_completed";
}

/** URL の値（searchParams の1項目）が、既存の権利の再利用の導線を表すか */
export function isExistingEntitlementHint(v: unknown): boolean {
  const s = Array.isArray(v) ? v[0] : v;
  return s === EXISTING_ENTITLEMENT_VALUE;
}
