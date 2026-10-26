import { formatYen } from "@/lib/money";

/**
 * 返金・異議申し立て（チャージバック）の状況の印（決済の一覧で使う）。
 * 全額の返金・敗訴は決済の状態（返金・チャージバック）で表すので、ここでは一部返金・返金の処理中や失敗・異議申し立てを表示する。
 */
export function PaymentIssueBadge({ t }: { t: { paymentStatus: string; amount: number; amountRefunded?: number; refundStatus?: string | null; disputeStatus?: string | null } }) {
  const items: [string, string][] = [];
  const refunded = t.amountRefunded ?? 0;
  if (t.paymentStatus === "SUCCEEDED" && refunded > 0 && refunded < t.amount) items.push([`一部返金 ${formatYen(refunded)}`, "text-danger"]);
  if (t.refundStatus === "pending") items.push(["返金の処理中", "text-gold-200"]);
  if (t.refundStatus === "failed") items.push(["返金失敗", "text-danger"]);
  if (t.disputeStatus === "open") items.push(["異議申し立て対応中（精算保留）", "text-danger"]);
  if (t.disputeStatus === "won") items.push(["異議申し立て勝訴", "text-success"]);
  if (t.disputeStatus === "lost" && t.paymentStatus !== "CHARGEBACK") items.push(["異議申し立て敗訴", "text-danger"]);
  if (!items.length) return null;
  return (
    <span className="mt-1 flex flex-col gap-0.5">
      {items.map(([label, cls]) => (
        <span key={label} className={`whitespace-nowrap text-[11px] ${cls}`}>
          {label}
        </span>
      ))}
    </span>
  );
}
