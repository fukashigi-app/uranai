/**
 * 返金済み・チャージバックの注文（注文の状態 REFUNDED）の理由と、お客さんへの案内。
 * サーバーの画面と、確認中の画面（クライアント）の両方で使う（サーバー専用の処理を読み込まない）。
 * REFUNDED の注文では占い権利を付与しない（占いを開始できない）。「請求は発生していません」とは案内しない（支払いは発生している）。
 */
export type CheckoutRefundReason = "refund" | "chargeback";

export const isCheckoutRefundReason = (v: unknown): v is CheckoutRefundReason => v === "refund" || v === "chargeback";

export function refundedNotice(reason: CheckoutRefundReason | null | undefined): { title: string; body: string } {
  if (reason === "chargeback") {
    return {
      title: "このご注文では占いを開始できません",
      body: "このご注文のお支払いは、カード会社などへの異議申し立て（チャージバック）により取り消されたため、占いを開始できません。ご不明な点は運営までお問い合わせください。",
    };
  }
  // 理由の記録が無いときも返金として案内する（占いを開始できないことは同じ）
  return {
    title: "このご注文は返金済みです",
    body: "このご注文のお支払いは返金済み（または返金の手続き中）のため、占いを開始できません。返金はお支払いに使った方法に戻ります。ご不明な点は運営までお問い合わせください。",
  };
}
