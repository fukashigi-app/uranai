import { Card, Table } from "@/components/console/shell";
import { ActionButton } from "@/components/console/admin-forms";
import { PaymentKindBadge } from "@/components/console/payment-kind-badge";
import { dismissStripeDisputeReviewAction } from "@/app/admin/actions";
import { isFirestore } from "@/lib/data-provider";
import { getStoresByIds } from "@/lib/services/stores";
import { formatDateTimeJa } from "@/lib/time";
import { formatYen } from "@/lib/money";

const STATE_LABEL = { open: "対応中（精算を保留）", won: "勝訴", lost: "敗訴（売上から除外）" } as const;

/**
 * 異議申し立て（チャージバック）の確認が必要な決済。Firestore を使うときだけ表示する。
 * 対応（証拠の提出など）は Stripe のダッシュボードで行う。精算の保留・調整は状態から自動で決まる。
 */
export async function StripeDisputeReviews() {
  if (!isFirestore()) return null;
  const { listStripeDisputeReviews } = await import("@/lib/payments/stripe-confirm");
  const rows = await listStripeDisputeReviews().catch((e: Error) => {
    console.error("[admin] stripe dispute reviews failed", e.name);
    return null;
  });
  if (rows === null || rows.length === 0) return null;
  const names = new Map((await getStoresByIds([...new Set(rows.map((r) => r.storeId))])).map((s) => [s.id, s.name]));
  return (
    <Card>
      <h2 className="mb-1 text-sm font-bold text-danger">異議申し立て（チャージバック）の確認が必要な決済（{rows.length}件）</h2>
      <p className="mb-3 text-[12px] text-ink-faint">
        対応中の決済は精算を保留しています（振込済みの月なら、次回の精算から差し引きます）。Stripe のダッシュボードで期限までに対応してください。勝訴すると保留を解除し、敗訴すると売上から除きます。
      </p>
      <Table head={["決済日時", "店舗", "決済", "金額", "申し立て額", "状態", "理由", "操作"]} empty={false}>
        {rows.map((r) => (
          <tr key={r.transactionId}>
            <td className="whitespace-nowrap tabular-nums">{formatDateTimeJa(r.paidAt)}</td>
            <td className="max-w-40 truncate">{names.get(r.storeId) ?? "—"}</td>
            <td>
              <PaymentKindBadge kind={r.livemode ? "live" : "test"} />
            </td>
            <td className="tabular-nums">{formatYen(r.amount)}</td>
            <td className="tabular-nums">{formatYen(r.disputeAmount)}</td>
            <td className={r.disputeStatus === "won" ? "text-success" : "text-danger"}>
              {STATE_LABEL[r.disputeStatus]}
              <span className="block text-[11px] text-ink-faint">{r.disputeStripeStatus}</span>
            </td>
            <td className="text-[12px] text-ink-muted">{r.disputeReason || "—"}</td>
            <td>{r.disputeStatus !== "open" ? <ActionButton action={dismissStripeDisputeReviewAction.bind(null, r.transactionId)} label="確認済みにする" confirmMessage="確認済みにしますか？" /> : <span className="text-[12px] text-ink-faint">結果待ち</span>}</td>
          </tr>
        ))}
      </Table>
    </Card>
  );
}
