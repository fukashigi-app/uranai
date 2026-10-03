import "server-only";
import { AggregateField, type Query } from "firebase-admin/firestore";
import type { Range, StoreListRow, StoreSort, Totals } from "@/lib/services/reports";
import { jstDateString, jstMonthRange, jstYearMonth, shiftYearMonth } from "@/lib/time";
import { C, fsdb, mustDate } from "./admin";
import { isRealPayment } from "./shared";
import { listAllStores } from "./stores";

/**
 * 売上集計（Firestore 版）。すべて transactions の決済成功分（返金除外・テスト決済除外）から計算する。
 * 金額・店舗取り分・運営取り分は決済時に保存した値を合計するだけ（再計算しない）。
 *
 * 検索条件はすべて「1つの等価条件」にしてあるため、Firestore の自動インデックスだけで動作する
 * （複合インデックスの手動作成が不要）。
 *   cYm == 年月 / cStoreYm == 店舗_年月 / cStore == 店舗 / countable == true / cDate == 日付
 */

const tx = () => fsdb().collection(C.transactions);
const ZERO: Totals = { count: 0, gross: 0, storeShare: 0, operatorShare: 0, fee: 0 };

async function aggregate(q: Query): Promise<Totals> {
  const snap = await q
    .aggregate({
      count: AggregateField.count(),
      gross: AggregateField.sum("amount"),
      storeShare: AggregateField.sum("storeShare"),
      operatorShare: AggregateField.sum("operatorShare"),
      fee: AggregateField.sum("paymentFee"),
    })
    .get();
  const d = snap.data();
  return { count: Number(d.count ?? 0), gross: Number(d.gross ?? 0), storeShare: Number(d.storeShare ?? 0), operatorShare: Number(d.operatorShare ?? 0), fee: Number(d.fee ?? 0) };
}

function monthQuery(yearMonth: string, storeId?: string): Query {
  return storeId ? tx().where("cStoreYm", "==", `${storeId}_${yearMonth}`) : tx().where("cYm", "==", yearMonth);
}

function allTimeQuery(storeId?: string): Query {
  return storeId ? tx().where("cStore", "==", storeId) : tx().where("countable", "==", true);
}

/** range がちょうど1か月（JST）なら、その年月を返す */
function wholeMonth(range: { start: Date; end: Date }): string | null {
  const ym = jstYearMonth(range.start);
  const r = jstMonthRange(ym);
  return r.start.getTime() === range.start.getTime() && r.end.getTime() === range.end.getTime() ? ym : null;
}

export async function monthTotals(yearMonth: string, storeId?: string): Promise<Totals> {
  return aggregate(monthQuery(yearMonth, storeId));
}

/** 任意の期間（日単位）の合計。運営ダッシュボードの「本日」などで使う */
export async function totalsBetween(start: Date, end: Date, storeId?: string): Promise<Totals> {
  const ym = wholeMonth({ start, end });
  if (ym) return monthTotals(ym, storeId);
  const total: Totals = { ...ZERO };
  for (let t = start.getTime(); t < end.getTime(); t += 86_400_000) {
    const day = jstDateString(new Date(t));
    const q = await tx().where("cDate", "==", day).get();
    for (const d of q.docs) {
      const paidAt = mustDate(d.get("paidAt"));
      if (paidAt < start || paidAt >= end || (storeId && d.get("storeId") !== storeId)) continue;
      total.count += 1;
      total.gross += Number(d.get("amount"));
      total.storeShare += Number(d.get("storeShare"));
      total.operatorShare += Number(d.get("operatorShare"));
      total.fee += Number(d.get("paymentFee"));
    }
  }
  return total;
}

export async function totalsForRange(range: Range, storeId?: string): Promise<Totals> {
  if (!range) return aggregate(allTimeQuery(storeId));
  return totalsBetween(range.start, range.end, storeId);
}

export async function dailySeries(yearMonth: string, storeId?: string): Promise<{ day: number; count: number; gross: number }[]> {
  const { start, end } = jstMonthRange(yearMonth);
  const days = Math.round((end.getTime() - start.getTime()) / 86_400_000);
  const out = Array.from({ length: days }, (_, i) => ({ day: i + 1, count: 0, gross: 0 }));
  const snap = await monthQuery(yearMonth, storeId).select("paidDate", "amount").get();
  for (const d of snap.docs) {
    const day = Number(String(d.get("paidDate")).slice(8, 10));
    if (day >= 1 && day <= days) {
      out[day - 1].count += 1;
      out[day - 1].gross += Number(d.get("amount"));
    }
  }
  return out;
}

export async function monthlySeries(months: number, storeId?: string): Promise<(Totals & { yearMonth: string })[]> {
  const current = jstYearMonth();
  return Promise.all(
    Array.from({ length: months }, async (_, i) => {
      const ym = shiftYearMonth(current, -i);
      return { yearMonth: ym, ...(await monthTotals(ym, storeId)) };
    }),
  );
}

export async function countActiveStores(): Promise<{ total: number; active: number }> {
  const stores = await listAllStores();
  return { total: stores.length, active: stores.filter((s) => s.status === "ACTIVE").length };
}

export async function listStores(opts: {
  q?: string;
  status?: "ACTIVE" | "SUSPENDED";
  range: Range;
  sort: StoreSort;
  dir: "asc" | "desc";
  page: number;
  perPage: number;
}): Promise<{ total: number; rows: StoreListRow[] }> {
  const q = opts.q?.trim().toLowerCase();
  let stores = await listAllStores();
  if (q) stores = stores.filter((s) => s.name.toLowerCase().includes(q) || s.storeCode === q);
  if (opts.status) stores = stores.filter((s) => s.status === opts.status);

  // 店舗ごとに同じ期間で集計（件数・総売上・店舗取り分・運営取り分）
  const ym = opts.range ? wholeMonth(opts.range) : null;
  const rows: (StoreListRow & { createdAt: Date })[] = await Promise.all(
    stores.map(async (s) => {
      const t = opts.range ? (ym ? await monthTotals(ym, s.id) : await totalsBetween(opts.range.start, opts.range.end, s.id)) : await aggregate(allTimeQuery(s.id));
      return {
        id: s.id,
        name: s.name,
        storeCode: s.storeCode,
        status: s.status,
        count: t.count,
        gross: t.gross,
        storeShare: t.storeShare,
        operatorShare: t.operatorShare,
        lastUsedAt: s.lastUsedAt,
        createdAt: s.createdAt,
      };
    }),
  );

  const key = (r: (typeof rows)[number]): string | number | null => {
    switch (opts.sort) {
      case "name":
        return r.name;
      case "lastUsedAt":
        return r.lastUsedAt?.getTime() ?? null;
      case "createdAt":
        return r.createdAt.getTime();
      default:
        return r[opts.sort];
    }
  };
  const sign = opts.dir === "asc" ? 1 : -1;
  rows.sort((a, b) => {
    const ka = key(a);
    const kb = key(b);
    if (ka === null || kb === null) {
      if (ka === kb) return a.id.localeCompare(b.id);
      // PostgreSQL 版と同じ: 昇順は空を先頭、降順は空を末尾
      return ka === null ? (opts.dir === "asc" ? -1 : 1) : opts.dir === "asc" ? 1 : -1;
    }
    const c = typeof ka === "string" ? ka.localeCompare(String(kb), "ja") : ka - (kb as number);
    return c !== 0 ? c * sign : a.id.localeCompare(b.id);
  });
  const start = (opts.page - 1) * opts.perPage;
  return {
    total: rows.length,
    rows: rows.slice(start, start + opts.perPage).map(({ createdAt: _c, ...r }) => r),
  };
}

export async function listTransactions(opts: { storeId?: string; yearMonth?: string; page: number; perPage: number }) {
  let q: Query = tx();
  if (opts.storeId && opts.yearMonth) q = tx().where("storeYm", "==", `${opts.storeId}_${opts.yearMonth}`);
  else if (opts.yearMonth) q = tx().where("yearMonth", "==", opts.yearMonth);
  else if (opts.storeId) q = tx().where("storeId", "==", opts.storeId);
  const snap = await q.get();
  const docs = snap.docs
    .filter((d) => isRealPayment(String(d.get("paymentProvider"))))
    .map((d) => ({ d, paidAt: mustDate(d.get("paidAt")) }))
    .sort((a, b) => b.paidAt.getTime() - a.paidAt.getTime() || a.d.id.localeCompare(b.d.id));
  const pageDocs = docs.slice((opts.page - 1) * opts.perPage, opts.page * opts.perPage);
  const storeIds = [...new Set(pageDocs.map(({ d }) => String(d.get("storeId"))))];
  const names = new Map<string, string>();
  if (storeIds.length) {
    const snaps = await fsdb().getAll(...storeIds.map((id) => fsdb().collection(C.stores).doc(id)));
    for (const s of snaps) if (s.exists) names.set(s.id, String(s.get("name")));
  }
  return {
    total: docs.length,
    rows: pageDocs.map(({ d, paidAt }) => ({
      id: d.id,
      paidAt,
      fortuneType: d.get("fortuneType") as "BIRTHDAY" | "ZODIAC" | "BLOOD",
      amount: Number(d.get("amount")),
      storeShare: Number(d.get("storeShare")),
      operatorShare: Number(d.get("operatorShare")),
      paymentFee: Number(d.get("paymentFee")),
      paymentStatus: String(d.get("paymentStatus")),
      fortuneStatus: String(d.get("fortuneStatus")),
      provider: String(d.get("paymentProvider")),
      providerPaymentId: String(d.get("providerPaymentId")),
      storeName: names.get(String(d.get("storeId"))) ?? "",
      storeId: String(d.get("storeId")),
    })),
  };
}
