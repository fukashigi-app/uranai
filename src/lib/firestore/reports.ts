import "server-only";
import { netSalesFigures } from "@/lib/payments/settlement-rules";
import { STORE_SHARE_BPS } from "@/config/pricing";
import type { Query } from "firebase-admin/firestore";
import type { Range, StoreListRow, StoreSort, Totals } from "@/lib/services/reports";
import { jstDateString, jstMonthRange, jstYearMonth, shiftYearMonth } from "@/lib/time";
import { C, fsdb, mustDate } from "./admin";
import { isSalesDoc } from "./shared";
import { paymentKind } from "@/lib/payments/kind";
import { listAllStores } from "./stores";

/**
 * 売上集計（Firestore 版）。すべて transactions の決済成功分（返金除外・テスト決済除外）から計算する。
 * 金額・店舗取り分・運営取り分は決済時に保存した値を合計するだけ（再計算しない）。
 *
 * 検索条件はすべて「1つの等価条件」にしてあるため、Firestore の自動インデックスだけで動作する
 * （複合インデックスの手動作成が不要）。
 *   cYm == 年月 / cStoreYm == 店舗_年月 / cStore == 店舗 / countable == true / cDate == 日付
 *
 * 合計は Firestore の集計クエリ（count / sum）を使わず、通常の読み取り＋サーバー側の足し算で計算する。
 * 本番環境で集計クエリが失敗し管理画面が表示できなかったため（読み取りは /admin/settlements と同じ方式）。
 * 読むのは金額の4項目と、売上に数える決済かの判定に使う2項目だけ（select）。
 * テスト決済（livemode=false）・判定不可の決済は、保存済みの countable に関係なく読み取り時に除外する（isSalesDoc）。
 */

const tx = () => fsdb().collection(C.transactions);
const ZERO: Totals = { count: 0, gross: 0, storeShare: 0, operatorShare: 0, fee: 0 };

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);

/**
 * 売上の集計に使う金額。一部返金（Stripe 側で発生したとき）は返金後の金額にする（決済時の記録は書き換えない）。
 * 全額の返金・異議申し立ての敗訴は countable=false で、集計の対象から外れている。
 */
const NET_FIELDS = ["amount", "storeShare", "operatorShare", "storeShareBps", "amountRefunded", "disputeStatus", "disputeAmount"] as const;
function figures(d: { get(f: string): unknown }) {
  return netSalesFigures({
    amount: num(d.get("amount")),
    storeShare: num(d.get("storeShare")),
    operatorShare: num(d.get("operatorShare")),
    storeShareBps: Number.isInteger(d.get("storeShareBps")) ? Number(d.get("storeShareBps")) : STORE_SHARE_BPS,
    amountRefunded: num(d.get("amountRefunded")),
    disputeStatus: (typeof d.get("disputeStatus") === "string" ? d.get("disputeStatus") : null) as "open" | "won" | "lost" | null,
    disputeAmount: typeof d.get("disputeAmount") === "number" ? Number(d.get("disputeAmount")) : null,
  });
}

async function aggregate(q: Query): Promise<Totals> {
  const snap = await q.select(...NET_FIELDS, "paymentFee", "paymentProvider", "livemode").get();
  const total: Totals = { ...ZERO };
  for (const d of snap.docs) {
    if (!isSalesDoc(d)) continue; // 以前の判定で countable になっているテスト決済などを除く
    const f = figures(d);
    total.count += 1;
    total.gross += f.gross;
    total.storeShare += f.storeShare;
    total.operatorShare += f.operatorShare;
    total.fee += num(d.get("paymentFee"));
  }
  return total;
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
      if (paidAt < start || paidAt >= end || (storeId && d.get("storeId") !== storeId) || !isSalesDoc(d)) continue;
      const f = figures(d);
      total.count += 1;
      total.gross += f.gross;
      total.storeShare += f.storeShare;
      total.operatorShare += f.operatorShare;
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
  const snap = await monthQuery(yearMonth, storeId).select("paidDate", ...NET_FIELDS, "paymentProvider", "livemode").get();
  for (const d of snap.docs) {
    if (!isSalesDoc(d)) continue;
    const day = Number(String(d.get("paidDate")).slice(8, 10));
    if (day >= 1 && day <= days) {
      out[day - 1].count += 1;
      out[day - 1].gross += figures(d).gross;
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

/**
 * 決済の一覧。
 *  audience = "store"    … 店舗の売上画面。売上に数える決済だけ（テスト決済・疑似決済・判定不可は表示しない）
 *  audience = "operator" … 運営画面。テスト決済なども含めてすべて表示し、種類（kind）を返す
 */
export async function listTransactions(opts: { storeId?: string; yearMonth?: string; page: number; perPage: number; audience: "store" | "operator" }) {
  let q: Query = tx();
  if (opts.storeId && opts.yearMonth) q = tx().where("storeYm", "==", `${opts.storeId}_${opts.yearMonth}`);
  else if (opts.yearMonth) q = tx().where("yearMonth", "==", opts.yearMonth);
  else if (opts.storeId) q = tx().where("storeId", "==", opts.storeId);
  const snap = await q.get();
  const docs = snap.docs
    .filter((d) => opts.audience === "operator" || isSalesDoc(d))
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
      amountRefunded: num(d.get("amountRefunded")),
      // 一部返金の後の店舗の取り分（決済時の記録は書き換えない）
      netStoreShare: figures(d).storeShare,
      refundStatus: typeof d.get("refundStatus") === "string" ? String(d.get("refundStatus")) : null,
      disputeStatus: typeof d.get("disputeStatus") === "string" ? String(d.get("disputeStatus")) : null,
      fortuneStatus: String(d.get("fortuneStatus")),
      provider: String(d.get("paymentProvider")),
      kind: paymentKind(String(d.get("paymentProvider")), d.get("livemode")),
      providerPaymentId: String(d.get("providerPaymentId")),
      storeName: names.get(String(d.get("storeId"))) ?? "",
      storeId: String(d.get("storeId")),
    })),
  };
}
