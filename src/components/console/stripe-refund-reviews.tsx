import { Card, Table } from "@/components/console/shell";
import { ActionButton, RestoreEntitlementForm } from "@/components/console/admin-forms";
import { dismissStripeRefundReviewAction, restoreStripeEntitlementAction } from "@/app/admin/actions";
import { isFirestore } from "@/lib/data-provider";
import { FORTUNE_CATALOG } from "@/lib/fortune/catalog";
import { formatDateTimeJa } from "@/lib/time";
import { formatYen } from "@/lib/money";
import { RESTORE_OUTCOME_MESSAGE, RESTORE_REASON_MAX } from "@/lib/payments/stripe-sync-rules";

const METHOD_LABEL: Record<string, string> = { card: "カード", apple_pay: "Apple Pay", google_pay: "Google Pay", paypay: "PayPay" };
const REFUND_LABEL: Record<string, string> = { failed: "返金失敗", partial: "一部返金" };
const ENTITLEMENT_LABEL = { suspended: "返金で停止中", suspended_by_dispute: "異議申し立てで停止中", used: "使用済み", active: "有効", expired: "期限切れ", missing: "なし" } as const;

/**
 * Stripe の決済で、返金が失敗・一部だけ成功したもの（管理者の確認が必要）。Firestore を使うときだけ表示する。
 * 「占い権利を戻す」は、返金がすべて失敗・一部の返金の決済で、返金で止めた未使用の権利だけ（理由の入力が必須）。
 * 異議申し立ての対応中・敗訴、返金の処理中・全額の返金では戻せない（理由を表示する）。最終の判断はサーバーで、Stripe の最新の状態で行う。
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
      <h2 className="mb-1 text-sm font-bold text-danger">返金の確認が必要な決済（{rows.length}件）</h2>
      <p className="mb-3 text-[12px] text-ink-faint">
        Stripe の返金が失敗した、または一部だけ成功した決済です。Stripe のダッシュボードで状況を確認し、必要なら理由を入力して占い権利を戻してください（返金で止めた未使用の権利だけ戻せます。理由は監査ログに残ります）。
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
                {r.restoreBlocked === null ? (
                  <RestoreEntitlementForm action={restoreStripeEntitlementAction.bind(null, r.transactionId)} maxLength={RESTORE_REASON_MAX} />
                ) : (
                  <p className="max-w-56 text-[12px] text-ink-faint" data-restore-blocked={r.restoreBlocked}>
                    {RESTORE_OUTCOME_MESSAGE[r.restoreBlocked]}
                  </p>
                )}
                <ActionButton action={dismissStripeRefundReviewAction.bind(null, r.transactionId)} label="確認済みにする" confirmMessage="占い権利は戻さずに、確認済みにしますか？" />
              </div>
            </td>
          </tr>
        ))}
      </Table>
    </Card>
  );
}
