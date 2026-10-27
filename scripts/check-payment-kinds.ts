/**
 * 【読み取り専用】既存の決済データの種類（本番決済・テスト決済・疑似決済・判定不可）と、
 * テスト決済などを含んだまま作られた月次精算を一覧にする。データの書き込み・削除は一切しない。
 *
 * 決済代行のテスト決済（livemode=false。Stripe の Sandbox・過去の PAY.JP のテストキーなど）は売上・精算から除外するようにしたため、
 * それ以前に作られた精算に含まれていないかを確認するために使う。
 *  - 未払い（UNPAID）の精算 … 運営画面の「精算を作成」をもう一度実行すれば、本番決済だけの金額に更新される
 *  - 処理中・支払済の精算 … 自動では変更しない。差額をこの一覧で確認し、人の判断で調整する
 *
 *   npm run check:payments            （.env / 環境変数の接続先を読み取るだけ）
 *
 * 出力には店舗名・件数・金額だけを出し、決済ID・口座情報・個人情報は出さない。
 */
import "dotenv/config";
import { isFirestore } from "@/lib/data-provider";
import { isSettlementPayment, paymentKind, type PaymentKind } from "@/lib/payments/kind";
import { jstYearMonth } from "@/lib/time";

type Tx = { storeId: string; yearMonth: string; provider: string; livemode: unknown; status: string; amount: number; storeShare: number };
type Set = { storeId: string; yearMonth: string; status: string; transactionCount: number; grossSales: number; storeShare: number };

async function load(): Promise<{ txs: Tx[]; sets: Set[]; names: Map<string, string> }> {
  if (isFirestore()) {
    const { C, fsdb, mustDate } = await import("@/lib/firestore/admin");
    const [t, s, st] = await Promise.all([
      fsdb().collection(C.transactions).select("storeId", "paidAt", "paymentProvider", "livemode", "paymentStatus", "amount", "storeShare").get(),
      fsdb().collection(C.settlements).select("storeId", "yearMonth", "status", "transactionCount", "grossSales", "storeShare").get(),
      fsdb().collection(C.stores).select("name").get(),
    ]);
    return {
      txs: t.docs.map((d) => ({
        storeId: String(d.get("storeId")),
        yearMonth: jstYearMonth(mustDate(d.get("paidAt"))),
        provider: String(d.get("paymentProvider")),
        livemode: d.get("livemode"),
        status: String(d.get("paymentStatus")),
        amount: Number(d.get("amount") ?? 0),
        storeShare: Number(d.get("storeShare") ?? 0),
      })),
      sets: s.docs.map((d) => ({
        storeId: String(d.get("storeId")),
        yearMonth: String(d.get("yearMonth")),
        status: String(d.get("status")),
        transactionCount: Number(d.get("transactionCount") ?? 0),
        grossSales: Number(d.get("grossSales") ?? 0),
        storeShare: Number(d.get("storeShare") ?? 0),
      })),
      names: new Map(st.docs.map((d) => [d.id, String(d.get("name"))])),
    };
  }
  const { db } = await import("@/lib/db");
  const { settlements, stores, transactions } = await import("@/lib/db/schema");
  const [t, s, st] = await Promise.all([
    db()
      .select({ storeId: transactions.storeId, paidAt: transactions.paidAt, provider: transactions.paymentProvider, livemode: transactions.livemode, status: transactions.paymentStatus, amount: transactions.amount, storeShare: transactions.storeShare })
      .from(transactions),
    db().select().from(settlements),
    db().select({ id: stores.id, name: stores.name }).from(stores),
  ]);
  return {
    txs: t.map((r) => ({ ...r, yearMonth: jstYearMonth(r.paidAt) })),
    sets: s.map((r) => ({ storeId: r.storeId, yearMonth: r.yearMonth, status: r.status, transactionCount: r.transactionCount, grossSales: r.grossSales, storeShare: r.storeShare })),
    names: new Map(st.map((r) => [r.id, r.name])),
  };
}

async function main() {
  const { txs, sets, names } = await load();
  const name = (id: string) => names.get(id) ?? `(不明な店舗 ${id.slice(0, 8)})`;

  // 1. 決済の種類ごとの件数（決済成功のもの）
  const byKind = new Map<PaymentKind, number>();
  for (const t of txs) if (t.status === "SUCCEEDED") byKind.set(paymentKind(t.provider, t.livemode), (byKind.get(paymentKind(t.provider, t.livemode)) ?? 0) + 1);
  console.log("■ 決済成功の件数（種類別）");
  for (const k of ["live", "test", "mock", "unknown"] as PaymentKind[]) console.log(`  ${k.padEnd(8)} ${byKind.get(k) ?? 0}件`);

  // 2. 精算と、本番決済だけで計算し直した金額の差
  const live = new Map<string, { cnt: number; gross: number; share: number }>();
  for (const t of txs) {
    if (t.status !== "SUCCEEDED" || !isSettlementPayment(t.provider, t.livemode)) continue;
    const k = `${t.storeId}_${t.yearMonth}`;
    const a = live.get(k) ?? { cnt: 0, gross: 0, share: 0 };
    a.cnt += 1;
    a.gross += t.amount;
    a.share += t.storeShare;
    live.set(k, a);
  }
  const diffs = sets
    .map((s) => ({ s, l: live.get(`${s.storeId}_${s.yearMonth}`) ?? { cnt: 0, gross: 0, share: 0 } }))
    .filter(({ s, l }) => s.transactionCount !== l.cnt || s.grossSales !== l.gross || s.storeShare !== l.share)
    .sort((a, b) => a.s.yearMonth.localeCompare(b.s.yearMonth));
  console.log(`\n■ 本番決済だけの金額と一致しない月次精算: ${diffs.length}件`);
  for (const { s, l } of diffs) {
    const action = s.status === "UNPAID" ? "→ 精算を作成し直すと更新されます" : "→ 自動では変更しません。差額の扱いを判断してください";
    console.log(
      `  ${s.yearMonth} ${name(s.storeId)} [${s.status}] 精算: ${s.transactionCount}件 店舗取り分${s.storeShare}円 / 本番決済のみ: ${l.cnt}件 ${l.share}円（差額 ${s.storeShare - l.share}円） ${action}`,
    );
  }
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error("CHECK FAILED:", (e as Error).message);
    process.exit(1);
  },
);
