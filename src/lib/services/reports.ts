import "server-only";
import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { jstMonthRange, jstYearMonth, shiftYearMonth } from "@/lib/time";

/** 集計は payment_status = 'SUCCEEDED'（返金除外）、JST で日/月を区切る */

export type Totals = { count: number; gross: number; storeShare: number; operatorShare: number; fee: number };

const num = (v: unknown) => Number(v ?? 0);

function toTotals(r: Record<string, unknown> | undefined): Totals {
  return { count: num(r?.count), gross: num(r?.gross), storeShare: num(r?.store_share), operatorShare: num(r?.operator_share), fee: num(r?.fee) };
}

const totalsSelect = sql`count(*)::int AS count, coalesce(sum(amount),0)::int AS gross, coalesce(sum(store_share),0)::int AS store_share,
  coalesce(sum(operator_share),0)::int AS operator_share, coalesce(sum(payment_fee),0)::int AS fee`;

export async function totalsBetween(start: Date, end: Date, storeId?: string): Promise<Totals> {
  const res = await db().execute(sql`
    SELECT ${totalsSelect} FROM transactions
    WHERE payment_status = 'SUCCEEDED' AND paid_at >= ${start.toISOString()} AND paid_at < ${end.toISOString()}
    ${storeId ? sql`AND store_id = ${storeId}` : sql``}`);
  return toTotals(res.rows[0]);
}

export async function monthTotals(yearMonth: string, storeId?: string): Promise<Totals> {
  const { start, end } = jstMonthRange(yearMonth);
  return totalsBetween(start, end, storeId);
}

/** 日別件数（月内の全日を0埋め） */
export async function dailySeries(yearMonth: string, storeId?: string): Promise<{ day: number; count: number; gross: number }[]> {
  const { start, end } = jstMonthRange(yearMonth);
  const res = await db().execute(sql`
    SELECT extract(day FROM paid_at AT TIME ZONE 'Asia/Tokyo')::int AS day, count(*)::int AS count, coalesce(sum(amount),0)::int AS gross
    FROM transactions
    WHERE payment_status = 'SUCCEEDED' AND paid_at >= ${start.toISOString()} AND paid_at < ${end.toISOString()}
    ${storeId ? sql`AND store_id = ${storeId}` : sql``}
    GROUP BY 1`);
  const days = Math.round((end.getTime() - start.getTime()) / 86400000);
  const map = new Map(res.rows.map((r) => [num(r.day), r]));
  return Array.from({ length: days }, (_, i) => ({ day: i + 1, count: num(map.get(i + 1)?.count), gross: num(map.get(i + 1)?.gross) }));
}

/** 直近 n ヶ月の月別集計（新しい順、0件の月も含む） */
export async function monthlySeries(months: number, storeId?: string): Promise<(Totals & { yearMonth: string })[]> {
  const current = jstYearMonth();
  const oldest = shiftYearMonth(current, -(months - 1));
  const { start } = jstMonthRange(oldest);
  const { end } = jstMonthRange(current);
  const res = await db().execute(sql`
    SELECT to_char(paid_at AT TIME ZONE 'Asia/Tokyo', 'YYYY-MM') AS ym, ${totalsSelect}
    FROM transactions
    WHERE payment_status = 'SUCCEEDED' AND paid_at >= ${start.toISOString()} AND paid_at < ${end.toISOString()}
    ${storeId ? sql`AND store_id = ${storeId}` : sql``}
    GROUP BY 1`);
  const map = new Map(res.rows.map((r) => [String(r.ym), r]));
  return Array.from({ length: months }, (_, i) => {
    const ym = shiftYearMonth(current, -i);
    return { yearMonth: ym, ...toTotals(map.get(ym)) };
  });
}

export async function countActiveStores(): Promise<{ total: number; active: number }> {
  const res = await db().execute(sql`SELECT count(*)::int AS total, count(*) FILTER (WHERE status = 'ACTIVE')::int AS active FROM stores`);
  return { total: num(res.rows[0]?.total), active: num(res.rows[0]?.active) };
}

export type StoreListRow = {
  id: string;
  name: string;
  storeCode: string;
  status: "ACTIVE" | "SUSPENDED";
  monthCount: number;
  totalGross: number;
  totalStoreShare: number;
  lastUsedAt: Date | null;
};

const SORTS = {
  name: sql`s.name`,
  monthCount: sql`month_count`,
  totalGross: sql`total_gross`,
  lastUsedAt: sql`last_used_at`,
  createdAt: sql`s.created_at`,
} as const;
export type StoreSort = keyof typeof SORTS;
export const isStoreSort = (v: string): v is StoreSort => v in SORTS;

export async function listStores(opts: { q?: string; status?: "ACTIVE" | "SUSPENDED"; sort: StoreSort; dir: "asc" | "desc"; page: number; perPage: number }) {
  const { start, end } = jstMonthRange(jstYearMonth());
  const q = opts.q?.trim();
  const where = sql`WHERE 1=1
    ${q ? sql`AND (s.name ILIKE ${"%" + q.replace(/[%_\\]/g, "\\$&") + "%"} OR s.store_code = ${q.toLowerCase()})` : sql``}
    ${opts.status ? sql`AND s.status = ${opts.status}` : sql``}`;
  const order = sql.join([SORTS[opts.sort], opts.dir === "asc" ? sql`ASC NULLS FIRST` : sql`DESC NULLS LAST`], sql` `);
  const rows = await db().execute(sql`
    SELECT s.id, s.name, s.store_code, s.status,
      coalesce(t.month_count,0)::int AS month_count, coalesce(t.total_gross,0)::int AS total_gross,
      coalesce(t.total_store_share,0)::int AS total_store_share, t.last_used_at
    FROM stores s
    LEFT JOIN LATERAL (
      SELECT count(*) FILTER (WHERE paid_at >= ${start.toISOString()} AND paid_at < ${end.toISOString()}) AS month_count,
        sum(amount) AS total_gross, sum(store_share) AS total_store_share, max(paid_at) AS last_used_at
      FROM transactions WHERE store_id = s.id AND payment_status = 'SUCCEEDED'
    ) t ON true
    ${where}
    ORDER BY ${order}, s.id
    LIMIT ${opts.perPage} OFFSET ${(opts.page - 1) * opts.perPage}`);
  const countRes = await db().execute(sql`SELECT count(*)::int AS n FROM stores s ${where}`);
  return {
    total: num(countRes.rows[0]?.n),
    rows: rows.rows.map(
      (r): StoreListRow => ({
        id: String(r.id),
        name: String(r.name),
        storeCode: String(r.store_code),
        status: r.status as StoreListRow["status"],
        monthCount: num(r.month_count),
        totalGross: num(r.total_gross),
        totalStoreShare: num(r.total_store_share),
        lastUsedAt: r.last_used_at ? new Date(String(r.last_used_at)) : null,
      }),
    ),
  };
}

export async function listTransactions(opts: { storeId?: string; yearMonth?: string; page: number; perPage: number }) {
  const range = opts.yearMonth ? jstMonthRange(opts.yearMonth) : null;
  const where = sql`WHERE 1=1
    ${opts.storeId ? sql`AND t.store_id = ${opts.storeId}` : sql``}
    ${range ? sql`AND t.paid_at >= ${range.start.toISOString()} AND t.paid_at < ${range.end.toISOString()}` : sql``}`;
  const rows = await db().execute(sql`
    SELECT t.id, t.paid_at, t.fortune_type, t.amount, t.store_share, t.operator_share, t.payment_fee, t.payment_status,
      t.fortune_status, t.payment_provider, t.provider_payment_id, s.name AS store_name, s.id AS store_id
    FROM transactions t JOIN stores s ON s.id = t.store_id
    ${where}
    ORDER BY t.paid_at DESC, t.id
    LIMIT ${opts.perPage} OFFSET ${(opts.page - 1) * opts.perPage}`);
  const c = await db().execute(sql`SELECT count(*)::int AS n FROM transactions t ${where}`);
  return {
    total: num(c.rows[0]?.n),
    rows: rows.rows.map((r) => ({
      id: String(r.id),
      paidAt: new Date(String(r.paid_at)),
      fortuneType: String(r.fortune_type) as "BIRTHDAY" | "ZODIAC" | "BLOOD",
      amount: num(r.amount),
      storeShare: num(r.store_share),
      operatorShare: num(r.operator_share),
      paymentFee: num(r.payment_fee),
      paymentStatus: String(r.payment_status),
      fortuneStatus: String(r.fortune_status),
      provider: String(r.payment_provider),
      providerPaymentId: String(r.provider_payment_id),
      storeName: String(r.store_name),
      storeId: String(r.store_id),
    })),
  };
}
