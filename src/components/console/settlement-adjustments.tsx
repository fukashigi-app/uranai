import { Table } from "@/components/console/shell";
import { formatDateJa, formatYearMonthJa } from "@/lib/time";
import { formatYen } from "@/lib/money";
import { ADJUSTMENT_REASON_LABEL, ADJUSTMENT_STATUS_LABEL } from "@/lib/payments/settlement-rules";
import type { Adjustment } from "@/lib/firestore/settlement-adjustments";

/**
 * 精算の調整の一覧（振込後の返金・異議申し立て・締め後に確定した決済・繰越）。
 * マイナスは次回の精算から差し引き、プラスは加算する。運営画面では元の決済IDと反映先の精算も表示する。
 */
export function SettlementAdjustmentsTable({ rows, storeNames, audience }: { rows: Adjustment[]; storeNames?: Map<string, string>; audience: "operator" | "store" }) {
  const head = audience === "operator" ? ["発生日", "店舗", "対象月", "理由", "調整額", "状態", "元の決済ID", "反映先"] : ["発生日", "対象月", "理由", "調整額", "状態"];
  return (
    <Table head={head} empty={rows.length === 0}>
      {rows.map((a) => (
        <tr key={a.id}>
          <td className="whitespace-nowrap tabular-nums">{a.createdAt.getTime() > 0 ? formatDateJa(a.createdAt) : "—"}</td>
          {audience === "operator" ? <td className="max-w-40 truncate">{storeNames?.get(a.storeId) ?? "—"}</td> : null}
          <td className="whitespace-nowrap">{formatYearMonthJa(a.yearMonth)}</td>
          <td>{ADJUSTMENT_REASON_LABEL[a.reason] ?? a.reason}</td>
          <td className={`tabular-nums font-bold ${a.amount < 0 ? "text-danger" : "text-success"}`}>{a.amount > 0 ? `+${formatYen(a.amount)}` : formatYen(a.amount)}</td>
          <td className={a.status === "OPEN" ? "text-gold-200" : "text-ink-muted"}>{ADJUSTMENT_STATUS_LABEL[a.status]}</td>
          {audience === "operator" ? (
            <>
              <td className="max-w-36 truncate font-mono text-[11px] text-ink-faint" title={a.providerPaymentId ?? ""}>
                {a.providerPaymentId ?? "—"}
              </td>
              <td className="whitespace-nowrap text-[12px] text-ink-muted">{a.appliedSettlementId ? formatYearMonthJa(a.appliedSettlementId.slice(-7)) : "—"}</td>
            </>
          ) : null}
        </tr>
      ))}
    </Table>
  );
}
