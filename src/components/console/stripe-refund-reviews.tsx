import { Card, Table } from "@/components/console/shell";
import { ActionButton } from "@/components/console/admin-forms";
import { dismissStripeRefundReviewAction, restoreStripeEntitlementAction } from "@/app/admin/actions";
import { isFirestore } from "@/lib/data-provider";
import { FORTUNE_CATALOG } from "@/lib/fortune/catalog";
import { formatDateTimeJa } from "@/lib/time";
import { formatYen } from "@/lib/money";

const METHOD_LABEL: Record<string, string> = { card: "カード", apple_pay: "Apple Pay", google_pay: "Google Pay", paypay: "PayPay" };
const REFUND_LABEL: Record<string, string> = { failed: "返金失敗", partial: "一部返金" };
const ENTITLEMENT_LABEL = { suspended: "返金で停止中", used: "使用済み", active: "有効", expired: "期限切れ", missing: "なし" } as const;

/**
 * Stripe のテスト決済で、返金が失敗・一部だけ成功したもの（管理者の確認が必要）。Firestore を使うときだけ表示する。
 * 「占い権利を戻す」は、返金で止めた未使用の権利だけを戻せる（サーバー側で Stripe API の返金の状態を取り直して確認する）。
 */
export async function StripeRefundReviews() {
  if (!isFirestore()) return null;
  const { listStripeRefundReviews } = await import("@/lib/payments/stripe-confirm");
  const rows = await listStripeRefundReviews().catch((e: Error) => {
    console.error("[admin] stripe refund reviews failed", e.name);
    return null;
  });
  if (rows === null || rows.length === 0) return null;
  return (
    <Card>
      <h2 className="mb-1 text-sm font-bold text-danger">返金の確認が必要なテスト決済（{rows.length}件）</h2>
      <p className="mb-3 text-[12px] text-ink-faint">
        Stripe の返金が失敗した、または一部だけ成功した決済です。Stripe のダッシュボードで状況を確認し、必要なら占い権利を戻してください（返金で止めた未使用の権利だけ戻せます）。
      </p>
      <Table head={["決済日時", "占い", "支払い方法", "金額", "返金済み", "返金", "占い権利", "操作"]} empty={false}>
        {rows.map((r) => (
          <tr key={r.transactionId}>
            <td className="whitespace-nowrap tabular-nums">{formatDateTimeJa(r.paidAt)}</td>
            <td>{FORTUNE_CATALOG[r.fortuneType as keyof typeof FORTUNE_CATALOG]?.short ?? r.fortuneType}</td>
            <td>{r.paymentMethod ? (METHOD_LABEL[r.paymentMethod] ?? r.paymentMethod) : "—"}</td>
            <td className="tabular-nums">{formatYen(r.amount)}</td>
            <td className="tabular-nums">{formatYen(r.amountRefunded)}</td>
            <td>{REFUND_LABEL[r.refundStatus] ?? r.refundStatus}</td>
            <td>{ENTITLEMENT_LABEL[r.entitlement]}</td>
            <td>
              <div className="flex flex-wrap gap-2">
                {r.refundStatus === "failed" && r.entitlement === "suspended" ? (
                  <ActionButton action={restoreStripeEntitlementAction.bind(null, r.transactionId)} label="占い権利を戻す" variant="gold" confirmMessage="返金が失敗した決済の占い権利を戻しますか？（有効期限は今から24時間）" />
                ) : null}
                <ActionButton action={dismissStripeRefundReviewAction.bind(null, r.transactionId)} label="確認済みにする" confirmMessage="占い権利は戻さずに、確認済みにしますか？" />
              </div>
            </td>
          </tr>
        ))}
      </Table>
    </Card>
  );
}
