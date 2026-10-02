import Link from "next/link";
import { Card, PageHeader, StatusBadge } from "@/components/console/shell";
import { Pagination, one, parsePage } from "@/components/console/pagination";
import { PeriodPicker } from "@/components/console/period-picker";
import { requireOperator } from "@/lib/auth/session";
import { isStoreSort, listStores, totalsForRange, type StoreSort } from "@/lib/services/reports";
import { periodQuery, resolvePeriod } from "@/lib/period";
import { formatDateTimeJa } from "@/lib/time";
import { formatYen } from "@/lib/money";

export const metadata = { title: "店舗一覧" };

const COLS: { key: StoreSort | null; label: string; num?: boolean }[] = [
  { key: "name", label: "店舗名" },
  { key: null, label: "ステータス" },
  { key: "count", label: "利用件数", num: true },
  { key: "gross", label: "総売上", num: true },
  { key: "storeShare", label: "店舗取り分", num: true },
  { key: "operatorShare", label: "運営取り分", num: true },
  { key: "lastUsedAt", label: "最終利用日時" },
];

const count = (n: number) => `${n.toLocaleString("ja-JP")}件`;

export default async function AdminStoresPage(props: PageProps<"/admin/stores">) {
  await requireOperator();
  const sp = await props.searchParams;
  const period = resolvePeriod(one(sp.period), one(sp.ym));
  const q = (one(sp.q) ?? "").slice(0, 100);
  const statusParam = one(sp.status);
  const status = statusParam === "ACTIVE" || statusParam === "SUSPENDED" ? statusParam : undefined;
  const sortParam = one(sp.sort) ?? "gross";
  const sort: StoreSort = isStoreSort(sortParam) ? sortParam : "gross";
  const dir = one(sp.dir) === "asc" ? "asc" : "desc";
  const page = parsePage(sp.page);
  const perPage = 20;

  // 一覧と全店舗合計は同じ期間（period.range）で集計する
  const [{ rows, total }, grand] = await Promise.all([
    listStores({ q, status, range: period.range, sort, dir, page, perPage }),
    totalsForRange(period.range),
  ]);

  const base = { ...periodQuery(period), q: q || undefined, status };
  const href = (o: Record<string, string | number | undefined>) => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries({ ...base, sort, dir, page, ...o })) if (v !== undefined && v !== "") p.set(k, String(v));
    return `/admin/stores?${p}`;
  };

  return (
    <>
      <PageHeader
        title="店舗"
        description="金額は決済履歴（決済成功分・返金除外）から自動集計しています。店舗をクリックすると詳細を表示します。"
        actions={
          <Link href="/admin/stores/new" className="btn-gold inline-flex h-10 items-center rounded-xl px-4 text-sm font-bold">
            ＋ 店舗を追加
          </Link>
        }
      />

      <div className="mb-4 flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <PeriodPicker period={period} basePath="/admin/stores" keep={{ q: q || undefined, status, sort, dir }} />
        <p className="text-[13px] text-ink-muted">
          集計期間：<span className="font-bold text-gold-200">{period.label}</span>
        </p>
      </div>

      <Card>
        <form className="mb-4 flex flex-wrap gap-2" role="search">
          {Object.entries(periodQuery(period)).map(([k, v]) => (
            <input key={k} type="hidden" name={k} value={v} />
          ))}
          <input name="q" defaultValue={q} placeholder="店舗名・店舗コードで検索" className="field !w-64 max-w-full !py-2" />
          <select name="status" defaultValue={status ?? ""} className="field !w-36 !py-2">
            <option value="">すべて</option>
            <option value="ACTIVE">稼働中</option>
            <option value="SUSPENDED">停止中</option>
          </select>
          <input type="hidden" name="sort" value={sort} />
          <input type="hidden" name="dir" value={dir} />
          <button className="btn-ghost h-[42px] rounded-xl px-5 text-sm">検索</button>
        </form>

        {/* PC: 表 */}
        <div className="-mx-5 hidden overflow-x-auto px-5 md:block">
          <table className="w-full min-w-[760px] text-left text-[13px]" data-testid="store-table">
            <thead>
              <tr className="border-b border-white/10 text-[11px] text-ink-faint">
                {COLS.map((c) => (
                  <th key={c.label} className={`whitespace-nowrap px-2 py-2 font-normal ${c.num ? "text-right" : ""}`}>
                    {c.key ? (
                      <Link href={href({ sort: c.key, dir: sort === c.key && dir === "desc" ? "asc" : "desc", page: 1 })} className="hover:text-ink">
                        {c.label}
                        {sort === c.key ? (dir === "desc" ? " ▼" : " ▲") : ""}
                      </Link>
                    ) : (
                      c.label
                    )}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="[&_td]:px-2 [&_td]:py-2.5 [&_tr]:border-b [&_tr]:border-white/5">
              {rows.map((s) => (
                <tr key={s.id} className="hover:bg-white/[0.03]">
                  <td>
                    <Link href={`/admin/stores/${s.id}`} className="font-bold hover:text-gold-200">
                      {s.name}
                    </Link>
                    <span className="block font-mono text-[11px] text-ink-faint">{s.storeCode}</span>
                  </td>
                  <td>
                    <StatusBadge status={s.status} />
                  </td>
                  <td className="text-right tabular-nums">{count(s.count)}</td>
                  <td className="text-right tabular-nums">{formatYen(s.gross)}</td>
                  <td className="text-right tabular-nums text-gold-200">{formatYen(s.storeShare)}</td>
                  <td className="text-right tabular-nums">{formatYen(s.operatorShare)}</td>
                  <td className="whitespace-nowrap tabular-nums text-ink-muted">{formatDateTimeJa(s.lastUsedAt)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="border-t-2 border-gold-300/40 bg-gold-300/[0.06] font-bold" data-testid="grand-total">
                <td className="px-2 py-3" colSpan={2}>
                  全店舗合計
                  <span className="block text-[11px] font-normal text-ink-faint">{period.label}・全{total.toLocaleString("ja-JP")}店舗{q || status ? "（検索条件に関係なく全店舗）" : ""}</span>
                </td>
                <td className="px-2 py-3 text-right tabular-nums">{count(grand.count)}</td>
                <td className="px-2 py-3 text-right tabular-nums">{formatYen(grand.gross)}</td>
                <td className="px-2 py-3 text-right tabular-nums text-gold-200">{formatYen(grand.storeShare)}</td>
                <td className="px-2 py-3 text-right tabular-nums">{formatYen(grand.operatorShare)}</td>
                <td className="px-2 py-3" />
              </tr>
            </tfoot>
          </table>
          {rows.length === 0 ? <p className="py-8 text-center text-[13px] text-ink-faint">店舗がありません</p> : null}
        </div>

        {/* スマートフォン: カード */}
        <ul className="space-y-2.5 md:hidden">
          {rows.map((s) => (
            <li key={s.id} className="rounded-2xl border border-white/10 bg-night-950/30 p-4">
              <div className="flex items-start justify-between gap-2">
                <Link href={`/admin/stores/${s.id}`} className="min-w-0 font-bold hover:text-gold-200">
                  <span className="block truncate">{s.name}</span>
                </Link>
                <StatusBadge status={s.status} />
              </div>
              <MoneyGrid count={s.count} gross={s.gross} storeShare={s.storeShare} operatorShare={s.operatorShare} />
            </li>
          ))}
          {rows.length === 0 ? <li className="py-6 text-center text-[13px] text-ink-faint">店舗がありません</li> : null}
          <li className="rounded-2xl border-2 border-gold-300/40 bg-gold-300/[0.06] p-4">
            <p className="font-bold">全店舗合計</p>
            <p className="text-[11px] text-ink-faint">{period.label}</p>
            <MoneyGrid count={grand.count} gross={grand.gross} storeShare={grand.storeShare} operatorShare={grand.operatorShare} />
          </li>
        </ul>

        <Pagination page={page} perPage={perPage} total={total} makeHref={(p) => href({ page: p })} />
      </Card>
    </>
  );
}

function MoneyGrid({ count: c, gross, storeShare, operatorShare }: { count: number; gross: number; storeShare: number; operatorShare: number }) {
  const items: [string, string, string?][] = [
    ["利用件数", count(c)],
    ["総売上", formatYen(gross)],
    ["店舗取り分", formatYen(storeShare), "text-gold-200"],
    ["運営取り分", formatYen(operatorShare)],
  ];
  return (
    <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 text-[13px]">
      {items.map(([k, v, cls]) => (
        <div key={k}>
          <dt className="text-[11px] text-ink-faint">{k}</dt>
          <dd className={`font-bold tabular-nums ${cls ?? ""}`}>{v}</dd>
        </div>
      ))}
    </dl>
  );
}
