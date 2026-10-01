import Link from "next/link";
import { Card, PageHeader, StatusBadge, Table } from "@/components/console/shell";
import { Pagination, one, parsePage } from "@/components/console/pagination";
import { requireOperator } from "@/lib/auth/session";
import { isStoreSort, listStores, type StoreSort } from "@/lib/services/reports";
import { formatDateTimeJa } from "@/lib/time";
import { formatYen } from "@/lib/money";

export const metadata = { title: "店舗一覧" };

const COLS: { key: StoreSort | null; label: string }[] = [
  { key: "name", label: "店舗名" },
  { key: null, label: "ステータス" },
  { key: "monthCount", label: "今月利用回数" },
  { key: "totalGross", label: "総売上" },
  { key: null, label: "店舗報酬（累計）" },
  { key: "lastUsedAt", label: "最終利用日時" },
];

export default async function AdminStoresPage(props: PageProps<"/admin/stores">) {
  await requireOperator();
  const sp = await props.searchParams;
  const q = (one(sp.q) ?? "").slice(0, 100);
  const statusParam = one(sp.status);
  const status = statusParam === "ACTIVE" || statusParam === "SUSPENDED" ? statusParam : undefined;
  const sortParam = one(sp.sort) ?? "createdAt";
  const sort: StoreSort = isStoreSort(sortParam) ? sortParam : "createdAt";
  const dir = one(sp.dir) === "asc" ? "asc" : "desc";
  const page = parsePage(sp.page);
  const perPage = 20;
  const { rows, total } = await listStores({ q, status, sort, dir, page, perPage });

  const href = (o: Record<string, string | number | undefined>) => {
    const p = new URLSearchParams();
    const merged = { q, status, sort, dir, page, ...o };
    for (const [k, v] of Object.entries(merged)) if (v !== undefined && v !== "") p.set(k, String(v));
    return `/admin/stores?${p}`;
  };

  return (
    <>
      <PageHeader
        title="店舗"
        description="店舗をクリックすると詳細を表示します。"
        actions={
          <Link href="/admin/stores/new" className="btn-gold inline-flex h-10 items-center rounded-xl px-4 text-sm font-bold">
            ＋ 店舗を追加
          </Link>
        }
      />
      <Card>
        <form className="mb-4 flex flex-wrap gap-2" role="search">
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
        <Table
          head={COLS.map((c) =>
            c.key ? (
              <Link key={c.label} href={href({ sort: c.key, dir: sort === c.key && dir === "desc" ? "asc" : "desc", page: 1 })} className="hover:text-ink">
                {c.label}
                {sort === c.key ? (dir === "desc" ? " ▼" : " ▲") : ""}
              </Link>
            ) : (
              c.label
            ),
          )}
          empty={rows.length === 0}
        >
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
              <td className="tabular-nums">{s.monthCount.toLocaleString("ja-JP")}回</td>
              <td className="tabular-nums">{formatYen(s.totalGross)}</td>
              <td className="tabular-nums text-gold-200">{formatYen(s.totalStoreShare)}</td>
              <td className="whitespace-nowrap tabular-nums text-ink-muted">{formatDateTimeJa(s.lastUsedAt)}</td>
            </tr>
          ))}
        </Table>
        <Pagination page={page} perPage={perPage} total={total} makeHref={(p) => href({ page: p })} />
      </Card>
    </>
  );
}
