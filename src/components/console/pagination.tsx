import Link from "next/link";

export function Pagination({ page, perPage, total, makeHref }: { page: number; perPage: number; total: number; makeHref: (page: number) => string }) {
  const pages = Math.max(1, Math.ceil(total / perPage));
  if (pages <= 1) return <p className="mt-4 text-[12px] text-ink-faint">全{total.toLocaleString("ja-JP")}件</p>;
  const cls = "rounded-lg border border-white/10 px-3 py-1.5 text-[12px]";
  return (
    <nav className="mt-4 flex items-center justify-between gap-2 text-[12px] text-ink-muted" aria-label="ページ送り">
      <span>
        全{total.toLocaleString("ja-JP")}件 ／ {page} / {pages}ページ
      </span>
      <span className="flex gap-2">
        {page > 1 ? <Link className={cls} href={makeHref(page - 1)}>前へ</Link> : <span className={`${cls} opacity-40`}>前へ</span>}
        {page < pages ? <Link className={cls} href={makeHref(page + 1)}>次へ</Link> : <span className={`${cls} opacity-40`}>次へ</span>}
      </span>
    </nav>
  );
}

export function parsePage(v: string | string[] | undefined): number {
  const n = Number(Array.isArray(v) ? v[0] : v);
  return Number.isInteger(n) && n >= 1 && n <= 100000 ? n : 1;
}

export function one(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}
