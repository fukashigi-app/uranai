import { PAYMENT_KIND_LABEL, type PaymentKind } from "@/lib/payments/kind";

/** 運営画面の決済一覧で、売上・精算の対象外の決済（テスト決済・疑似決済・判定不可）に付ける印。本番決済には何も表示しない */
export function PaymentKindBadge({ kind }: { kind: PaymentKind }) {
  if (kind === "live") return null;
  return (
    <span
      data-payment-kind={kind}
      title="売上・店舗の取り分・月次精算には含めません"
      className="ml-1 whitespace-nowrap rounded-full border border-violet-400/40 px-1.5 text-[10px] text-violet-300"
    >
      {PAYMENT_KIND_LABEL[kind]}・集計外
    </span>
  );
}
