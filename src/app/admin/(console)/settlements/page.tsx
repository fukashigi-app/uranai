import Link from "next/link";
import { Card, PageHeader, StatusBadge, Table } from "@/components/console/shell";
import { MonthPicker } from "@/components/console/month-picker";
import { ActionForm } from "@/components/console/form";
import { SettlementRowForm } from "@/components/console/admin-forms";
import { one } from "@/components/console/pagination";
import { requireOperator } from "@/lib/auth/session";
import { listSettlements, type SettlementStatus } from "@/lib/services/settlements";
import { formatDateJa, formatDateTimeJa, formatYearMonthJa, isValidYearMonth, jstYearMonth } from "@/lib/time";
import { BANK_CHANGE_WARNING_DAYS, listRecentBankChanges, type BankChange } from "@/lib/services/bank-changes";
import { getStoresByIds } from "@/lib/services/stores";
import { formatYen } from "@/lib/money";
import { maskAccountNumber } from "@/lib/services/stores";
import { generateSettlementsAction, updateSettlementAction } from "../../actions";

export const metadata = { title: "月次精算" };

export default async function AdminSettlementsPage(props: PageProps<"/admin/settlements">) {
  await requireOperator();
  const sp = await props.searchParams;
  const ymP = one(sp.ym);
  const ym = ymP && isValidYearMonth(ymP) && ymP <= jstYearMonth() ? ymP : jstYearMonth();
  const statusP = one(sp.status);
  const status = (["UNPAID", "PROCESSING", "PAID"] as const).includes(statusP as SettlementStatus) ? (statusP as SettlementStatus) : undefined;
  const [rows, bankChanges] = await Promise.all([listSettlements({ yearMonth: ym, status }), listRecentBankChanges()]);
  const changeStoreNames = new Map((await getStoresByIds([...new Set(bankChanges.map((c) => c.storeId))])).map((st) => [st.id, st.name]));
  // 店舗ごとの最新の「変更」（新規登録は警告の対象外）
  const latestChange = new Map<string, BankChange>();
  for (const c of bankChanges) if (c.kind === "change" && !latestChange.has(c.storeId)) latestChange.set(c.storeId, c);
  const sum = rows.reduce((a, { s }) => ({ count: a.count + s.transactionCount, gross: a.gross + s.grossSales, share: a.share + s.storeShare, unpaid: a.unpaid + (s.status !== "PAID" ? s.storeShare : 0) }), { count: 0, gross: 0, share: 0, unpaid: 0 });

  return (
    <>
      <PageHeader
        title="月次精算"
        description="月末締め後に各月の精算を作成します。店舗への振込は原則として3か月ごとにまとめて行い、振込が済んだ月の精算を「支払済」へ変更してください。"
        actions={<MonthPicker value={ym} makeHref={(v) => `/admin/settlements?ym=${v <= jstYearMonth() ? v : jstYearMonth()}`} />}
      />
      <BankChangeNotice changes={bankChanges} names={changeStoreNames} />
      <div className="mb-4 grid gap-4 lg:grid-cols-[1fr_1.4fr]">
        <Card title={`${formatYearMonthJa(ym)}の精算を作成・更新`}>
          <p className="text-[13px] leading-relaxed text-ink-muted">決済成功（返金除外）の取引を店舗ごとに集計します。「未払い」の行は最新の集計で上書きされ、「処理中」「支払済」の行は変更されません。</p>
          {ym < jstYearMonth() ? (
  <ActionForm
    action={generateSettlementsAction}
    submitLabel="集計して精算を作成"
    confirmMessage={`${formatYearMonthJa(ym)}の精算を作成/更新します。よろしいですか？`}
  >
    <input type="hidden" name="yearMonth" value={ym} />
  </ActionForm>
) : (
  <p className="mt-4 text-sm text-ink-muted">
    当月の精算は月末締め後に作成できます。
  </p>
)}
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
              <td className={bankLast4 ? "text-ink-muted" : "text-danger"}>
                {maskAccountNumber(bankLast4)}
                {latestChange.has(s.storeId) ? (
                  <span className="mt-1 block whitespace-nowrap rounded-full border border-danger/40 bg-danger/10 px-2 py-0.5 text-[11px] text-danger" data-bank-changed>
                    ⚠ 振込先変更 {formatDateJa(latestChange.get(s.storeId)!.at)}
                  </span>
                ) : null}
              </td>
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

const ACTOR = { STORE: "店舗アカウント", OPERATOR: "運営", SYSTEM: "システム" } as const;

/**
 * 振込先の登録・変更の警告（直近の監査ログから）。口座番号・名義などは表示しない。
 *  - 変更 … 振込前に、店舗へ心当たりがあるか確認してもらうため目立つ色で表示
 *  - 新規登録 … 参考として表示
 */
function BankChangeNotice({ changes, names }: { changes: BankChange[]; names: Map<string, string> }) {
  if (changes.length === 0) return null;
  const changed = changes.filter((c) => c.kind === "change");
  const added = changes.filter((c) => c.kind === "new");
  const item = (c: BankChange) => (
    <li key={`${c.storeId}-${c.at.getTime()}`} className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 py-1.5">
      <Link href={`/admin/stores/${c.storeId}`} className="font-bold underline-offset-4 hover:underline">
        {names.get(c.storeId) ?? "（削除された店舗）"}
      </Link>
      <span className="tabular-nums text-ink-muted">{formatDateTimeJa(c.at)}</span>
      <span className="text-[11px] text-ink-faint">操作：{ACTOR[c.actorRole]}</span>
    </li>
  );
  return (
    <section className="mb-4 space-y-3" aria-label="振込先の登録・変更">
      {changed.length ? (
        <div role="alert" className="rounded-2xl border border-danger/50 bg-danger/10 p-5" data-bank-change-alert>
          <p className="font-bold text-danger">⚠ 振込先が変更された店舗があります（直近{BANK_CHANGE_WARNING_DAYS}日・{changed.length}件）</p>
          <p className="mt-1 text-[12px] leading-relaxed text-ink-muted">
            振込の前に、店舗の担当者へ変更に心当たりがあるか（電話など別の方法で）確認してください。不正に変更された可能性がある場合は、振込を止めて店舗アカウントのパスワードを再発行してください。
          </p>
          <ul className="mt-2 divide-y divide-white/5 text-[13px]">{changed.map(item)}</ul>
        </div>
      ) : null}
      {added.length ? (
        <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-5" data-bank-new-notice>
          <p className="text-[13px] font-bold text-ink">振込先の新規登録（直近{BANK_CHANGE_WARNING_DAYS}日・{added.length}件）</p>
          <ul className="mt-1 divide-y divide-white/5 text-[13px]">{added.map(item)}</ul>
        </div>
      ) : null}
    </section>
  );
}
