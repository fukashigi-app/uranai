import Link from "next/link";
import { Card, PageHeader, StatusBadge, Table } from "@/components/console/shell";
import { MonthPicker } from "@/components/console/month-picker";
import { ActionForm } from "@/components/console/form";
import { SettlementRowForm } from "@/components/console/admin-forms";
import { one } from "@/components/console/pagination";
import { requireOperator } from "@/lib/auth/session";
import { listSettlements, type SettlementStatus } from "@/lib/services/settlements";
import { formatDateJa, formatYearMonthJa, isValidYearMonth, jstYearMonth, shiftYearMonth } from "@/lib/time";
import { formatYen } from "@/lib/money";
import { maskAccountNumber } from "@/lib/services/stores";
import { generateSettlementsAction, updateSettlementAction } from "../../actions";

export const metadata = { title: "月次精算" };

export default async function AdminSettlementsPage(props: PageProps<"/admin/settlements">) {
  await requireOperator();
  const sp = await props.searchParams;
  const ymP = one(sp.ym);
  const lastMonth = shiftYearMonth(jstYearMonth(), -1);
  const ym = ymP && isValidYearMonth(ymP) && ymP < jstYearMonth() ? ymP : lastMonth;
  const statusP = one(sp.status);
  const status = (["UNPAID", "PROCESSING", "PAID"] as const).includes(statusP as SettlementStatus) ? (statusP as SettlementStatus) : undefined;
  const rows = await listSettlements({ yearMonth: ym, status });
  const sum = rows.reduce((a, { s }) => ({ count: a.count + s.transactionCount, gross: a.gross + s.grossSales, share: a.share + s.storeShare, unpaid: a.unpaid + (s.status !== "PAID" ? s.storeShare : 0) }), { count: 0, gross: 0, share: 0, unpaid: 0 });

  return (
    <>
      <PageHeader
        title="月次精算"
        description="月末締め後に精算を作成し、振込完了後に「支払済」へ変更してください。"
        actions={<MonthPicker value={ym} makeHref={(v) => `/admin/settlements?ym=${v < jstYearMonth() ? v : lastMonth}`} />}
      />
      <div className="mb-4 grid gap-4 lg:grid-cols-[1fr_1.4fr]">
        <Card title={`${formatYearMonthJa(ym)}の精算を作成・更新`}>
          <p className="text-[13px] leading-relaxed text-ink-muted">決済成功（返金除外）の取引を店舗ごとに集計します。「未払い」の行は最新の集計で上書きされ、「処理中」「支払済」の行は変更されません。</p>
          <ActionForm action={generateSettlementsAction} submitLabel="集計して精算を作成" confirmMessage={`${formatYearMonthJa(ym)}の精算を作成/更新します。よろしいですか？`}>
            <input type="hidden" name="yearMonth" value={ym} />
          </ActionForm>
        </Card>
        <Card title="合計">
          <dl className="grid grid-cols-2 gap-3 text-[13px] sm:grid-cols-4">
            {[
              ["対象店舗", `${rows.length}店`],
              ["利用回数", `${sum.count.toLocaleString("ja-JP")}件`],
              ["店舗報酬合計", formatYen(sum.share)],
              ["未払い残高", formatYen(sum.unpaid)],
            ].map(([k, v]) => (
              <div key={k}>
                <dt className="text-[11px] text-ink-faint">{k}</dt>
                <dd className="mt-0.5 text-lg font-bold tabular-nums">{v}</dd>
              </div>
            ))}
          </dl>
          <a href={`/api/admin/settlements?ym=${ym}`} className="btn-ghost mt-4 inline-flex h-10 items-center rounded-xl px-4 text-[13px]">
            振込用CSVをダウンロード（口座情報含む）
          </a>
        </Card>
      </div>
      <Card>
        <div className="mb-3 flex gap-2 text-[12px]">
          {[undefined, "UNPAID", "PROCESSING", "PAID"].map((s) => (
            <Link key={s ?? "all"} href={`/admin/settlements?ym=${ym}${s ? `&status=${s}` : ""}`} className={`rounded-full border px-3 py-1 ${status === s ? "border-gold-300/60 text-gold-200" : "border-white/10 text-ink-muted"}`}>
              {s ? { UNPAID: "未払い", PROCESSING: "処理中", PAID: "支払済" }[s] : "すべて"}
            </Link>
          ))}
        </div>
        <Table head={["店舗", "件数", "総売上", "店舗報酬", "口座", "状況", "支払日", "変更"]} empty={rows.length === 0}>
          {rows.map(({ s, storeName, bankLast4 }) => (
            <tr key={s.id}>
              <td className="max-w-44 truncate">
                <Link href={`/admin/stores/${s.storeId}`} className="hover:text-gold-200">
                  {storeName}
                </Link>
              </td>
              <td className="tabular-nums">{s.transactionCount}件</td>
              <td className="tabular-nums">{formatYen(s.grossSales)}</td>
              <td className="tabular-nums font-bold text-gold-200">{formatYen(s.storeShare)}</td>
              <td className={bankLast4 ? "text-ink-muted" : "text-danger"}>{maskAccountNumber(bankLast4)}</td>
              <td>
                <StatusBadge status={s.status} />
              </td>
              <td className="whitespace-nowrap text-ink-muted">{s.paidAt ? formatDateJa(s.paidAt) : "—"}</td>
              <td>
                <SettlementRowForm action={updateSettlementAction.bind(null, s.id)} status={s.status} note={s.note} />
              </td>
            </tr>
          ))}
        </Table>
      </Card>
    </>
  );
}
