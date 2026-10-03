import Link from "next/link";
import { Card, PageHeader, StatusBadge, Table } from "@/components/console/shell";
import { MonthPicker } from "@/components/console/month-picker";
import { Pagination, one, parsePage } from "@/components/console/pagination";
import { requireOperator } from "@/lib/auth/session";
import { getStoreById } from "@/lib/services/stores";
import { listTransactions, monthTotals } from "@/lib/services/reports";
import { FORTUNE_CATALOG } from "@/lib/fortune/catalog";
import { formatDateTimeJa, isValidYearMonth, jstYearMonth } from "@/lib/time";
import { formatYen } from "@/lib/money";

export const metadata = { title: "決済履歴" };

export default async function AdminTransactionsPage(props: PageProps<"/admin/transactions">) {
  await requireOperator();
  const sp = await props.searchParams;
  const ymP = one(sp.ym);
  const ym = ymP && isValidYearMonth(ymP) && ymP <= jstYearMonth() ? ymP : jstYearMonth();
  const storeIdP = one(sp.storeId);
  const storeId = storeIdP && /^[0-9a-f-]{36}$/.test(storeIdP) ? storeIdP : undefined;
  const page = parsePage(sp.page);
  const perPage = 50;
  const [data, totals, storeRow] = await Promise.all([
    listTransactions({ storeId, yearMonth: ym, page, perPage }),
    monthTotals(ym, storeId),
    storeId ? getStoreById(storeId).then((s) => (s ? [{ name: s.name }] : [])) : Promise.resolve([]),
  ]);
  const q = (o: Record<string, string | number>) => {
    const p = new URLSearchParams({ ym, ...(storeId ? { storeId } : {}) });
    for (const [k, v] of Object.entries(o)) p.set(k, String(v));
    return `/admin/transactions?${p}`;
  };

  return (
    <>
      <PageHeader
        title="決済履歴"
        description={
          storeId ? (
            <>
              店舗: {storeRow[0]?.name ?? "—"}{" "}
              <Link href={`/admin/transactions?ym=${ym}`} className="underline underline-offset-4">
                絞り込み解除
              </Link>
            </>
          ) : (
            "Webhookで決済成功を確認した取引のみが計上されます。"
          )
        }
        actions={<MonthPicker value={ym} makeHref={(v) => q({ ym: v, page: 1 })} />}
      />
      <div className="mb-4 grid grid-cols-2 gap-2 text-[13px] sm:grid-cols-5">
        {[
          ["件数", `${totals.count.toLocaleString("ja-JP")}件`],
          ["売上", formatYen(totals.gross)],
          ["店舗取り分", formatYen(totals.storeShare)],
          ["運営取り分", formatYen(totals.operatorShare)],
          ["手数料(推定)", formatYen(totals.fee)],
        ].map(([k, v]) => (
          <div key={k} className="glass rounded-xl px-3 py-2">
            <p className="text-[11px] text-ink-faint">{k}</p>
            <p className="font-bold tabular-nums">{v}</p>
          </div>
        ))}
      </div>
      <Card>
        <Table head={["日時", "店舗", "占い", "金額", "店舗取り分", "運営取り分", "手数料", "決済", "占い", "決済ID"]} empty={data.rows.length === 0}>
          {data.rows.map((t) => (
            <tr key={t.id}>
              <td className="whitespace-nowrap tabular-nums">{formatDateTimeJa(t.paidAt)}</td>
              <td className="max-w-40 truncate">
                <Link href={`/admin/stores/${t.storeId}`} className="hover:text-gold-200">
                  {t.storeName}
                </Link>
              </td>
              <td>{FORTUNE_CATALOG[t.fortuneType].short}</td>
              <td className="tabular-nums">{formatYen(t.amount)}</td>
              <td className="tabular-nums text-gold-200">{formatYen(t.storeShare)}</td>
              <td className="tabular-nums">{formatYen(t.operatorShare)}</td>
              <td className="tabular-nums">{formatYen(t.paymentFee)}</td>
              <td>
                <StatusBadge status={t.paymentStatus} />
                {t.provider === "mock" ? <span className="ml-1 rounded-full border border-violet-400/40 px-1.5 text-[10px] text-violet-300">テスト</span> : null}
              </td>
              <td>
                <StatusBadge status={t.fortuneStatus} />
              </td>
              <td className="max-w-36 truncate font-mono text-[11px] text-ink-faint" title={t.providerPaymentId}>
                {t.provider}:{t.providerPaymentId}
              </td>
            </tr>
          ))}
        </Table>
        <Pagination page={page} perPage={perPage} total={data.total} makeHref={(p) => q({ page: p })} />
      </Card>
    </>
  );
}
