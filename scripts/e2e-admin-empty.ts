/**
 * 運営管理画面の売上集計の回帰テスト（Firestore Emulator 上でのみ実行。本番 Firestore には接続しない）。
 *  1. 初回の運営アカウント作成「直後」（店舗・決済・精算が0件）でも、管理画面のデータ取得がすべて動く
 *  2. 売上集計（通常の読み取り＋サーバー側の合計）が、独立に計算した値・Firestore の SUM 集計の値と一致する
 *     （本番 Firestore では SUM 集計が FAILED_PRECONDITION で失敗したため、集計はサーバー側で行っている）
 *   FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 FIREBASE_PROJECT_ID=demo-uranai-admin-empty npm run e2e:admin
 */
import "dotenv/config";
import assert from "node:assert/strict";
import { authenticate } from "@/lib/auth/login";
import { createInitialOperator, isInitialSetupDone } from "@/lib/services/setup";
import { countActiveStores, dailySeries, listStores, listTransactions, monthTotals, totalsBetween, totalsForRange } from "@/lib/services/reports";
import { generateSettlements, listSettlements } from "@/lib/services/settlements";
import { jstDateString, jstMonthRange, jstYearMonth, shiftYearMonth } from "@/lib/time";
import { AggregateField } from "firebase-admin/firestore";
import { C, fsdb } from "@/lib/firestore/admin";
import { salesKeys } from "@/lib/firestore/shared";
import { createStore } from "@/lib/services/stores";

const host = process.env.FIRESTORE_EMULATOR_HOST;
const project = process.env.FIREBASE_PROJECT_ID;

let n = 0;
const ok = (msg: string) => console.log(`✔ ${++n}. ${msg}`);

/** 各画面と同じ呼び出しを1つずつ実行し、どこで失敗したかを分かるようにする */
async function check<T>(label: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    const err = e as { code?: unknown; name?: string; message?: string };
    throw new Error(`${label} で失敗: code=${String(err.code ?? "-")} ${err.name ?? ""}: ${(err.message ?? "").split("\n")[0].slice(0, 200)}`);
  }
}

async function main() {
  if (!host || !project?.startsWith("demo-")) throw new Error("Firestore Emulator（demo- プロジェクト）でのみ実行できます");
  // 本番と同じ条件（テスト用の疑似決済は売上に数えない）。.env の PAYMENT_PROVIDER=mock を無効にする
  delete process.env.PAYMENT_PROVIDER;
  // このテスト専用のプロジェクト名前空間だけを空にする（他のテストのデータには触れない）
  const res = await fetch(`http://${host}/emulator/v1/projects/${project}/databases/(default)/documents`, { method: "DELETE" });
  assert.equal(res.status, 200);

  const password = `Op${Math.random().toString(36).slice(2, 10)}9x`;
  assert.equal(await createInitialOperator({ name: "運営管理者", email: "first-op@example.test", password }), "created");
  assert.equal(await isInitialSetupDone(), true);
  const login = await authenticate("first-op@example.test", password, "OPERATOR");
  assert.equal(login.ok, true);
  ok("初回の運営アカウント作成 → ログインできる（店舗・決済は0件）");

  const ym = jstYearMonth();
  const today = jstDateString();
  const todayStart = new Date(`${today}T00:00:00+09:00`);
  // /admin（ダッシュボード）と同じ呼び出し
  const stores = await check("countActiveStores", () => countActiveStores());
  const todayT = await check("totalsBetween(本日)", () => totalsBetween(todayStart, new Date(todayStart.getTime() + 86_400_000)));
  const month = await check("monthTotals(今月)", () => monthTotals(ym));
  const daily = await check("dailySeries(今月)", () => dailySeries(ym));
  const top = await check("listStores(今月・上位5)", () => listStores({ range: jstMonthRange(ym), sort: "count", dir: "desc", page: 1, perPage: 5 }));
  assert.deepEqual(stores, { total: 0, active: 0 });
  assert.equal(todayT.count, 0);
  assert.deepEqual(month, { count: 0, gross: 0, storeShare: 0, operatorShare: 0, fee: 0 });
  assert.ok(daily.length >= 28 && daily.every((d) => d.count === 0));
  assert.deepEqual(top.rows, []);
  ok("/admin ダッシュボードのデータ取得（店舗数・本日・今月・日別・上位店舗）が0件でも動く");

  // /admin/stores・/admin/transactions・/admin/settlements と同じ呼び出し
  await check("listStores(全期間)", () => listStores({ range: null, sort: "count", dir: "desc", page: 1, perPage: 20 }));
  await check("totalsForRange(全期間)", () => totalsForRange(null));
  await check("listTransactions(今月)", () => listTransactions({ yearMonth: ym, page: 1, perPage: 50, audience: "operator" }));
  await check("listSettlements(今月)", () => listSettlements({ yearMonth: ym }));
  ok("店舗一覧・決済履歴・月次精算のデータ取得も0件で動く");

  // ---- 2. 集計結果が以前（Firestore の SUM 集計）と一致する ----
  const SYSTEM = { userId: null, role: "SYSTEM" as const };
  const store = (name: string) => createStore({ name, contactName: "", postalCode: "", address: "", phone: "", email: "" }, SYSTEM);
  const [sa, sb] = [await store("集計テストA"), await store("集計テストB")];
  const lastYm = shiftYearMonth(ym, -1);
  const at = (yearMonth: string, day: number, hour = 12) => new Date(`${yearMonth}-${String(day).padStart(2, "0")}T${String(hour).padStart(2, "0")}:00:00+09:00`);
  // 100円 → 店舗30円・運営70円・手数料4円。返金・失敗・テスト用の疑似決済は数えない
  const seed: { store: string; paidAt: Date; status: string; provider: string }[] = [
    { store: sa.id, paidAt: at(ym, 1, 0), status: "SUCCEEDED", provider: "payjp" }, // 月初 0:00 JST
    { store: sa.id, paidAt: at(ym, 2), status: "SUCCEEDED", provider: "payjp" },
    { store: sa.id, paidAt: at(ym, 2, 23), status: "REFUNDED", provider: "payjp" }, // 返金は除外
    { store: sb.id, paidAt: at(ym, 3), status: "SUCCEEDED", provider: "payjp" },
    { store: sb.id, paidAt: at(ym, 3), status: "FAILED", provider: "payjp" }, // 失敗は除外
    { store: sb.id, paidAt: at(ym, 4), status: "SUCCEEDED", provider: "mock" }, // テスト用の疑似決済は除外
    { store: sa.id, paidAt: at(lastYm, 28, 23), status: "SUCCEEDED", provider: "payjp" }, // 先月末
    { store: sb.id, paidAt: at(lastYm, 15), status: "SUCCEEDED", provider: "payjp" },
  ];
  const batch = fsdb().batch();
  seed.forEach((t, i) => {
    batch.set(fsdb().collection(C.transactions).doc(`agg-test-${i}`), {
      storeId: t.store,
      amount: 100,
      storeShare: 30,
      operatorShare: 70,
      paymentFee: 4,
      paymentStatus: t.status,
      paymentProvider: t.provider,
      fortuneStatus: "PENDING",
      fortuneType: "ZODIAC",
      providerPaymentId: `agg-${i}`,
      livemode: t.provider !== "mock", // 決済代行の本番環境の決済（疑似決済は false）
      paidAt: t.paidAt,
      ...salesKeys(t.store, t.provider, t.status, t.paidAt, t.provider !== "mock"),
    });
  });
  await batch.commit();

  // 独立に計算した期待値
  const expected = (pred: (t: (typeof seed)[number]) => boolean) => {
    const n = seed.filter((t) => t.status === "SUCCEEDED" && t.provider !== "mock" && pred(t)).length;
    return { count: n, gross: 100 * n, storeShare: 30 * n, operatorShare: 70 * n, fee: 4 * n };
  };
  // 以前の方式（Firestore の SUM 集計。Emulator では動く）
  const firestoreSum = async (field: string, value: string | boolean) => {
    const d = (
      await fsdb()
        .collection(C.transactions)
        .where(field, "==", value)
        .aggregate({ count: AggregateField.count(), gross: AggregateField.sum("amount"), storeShare: AggregateField.sum("storeShare"), operatorShare: AggregateField.sum("operatorShare"), fee: AggregateField.sum("paymentFee") })
        .get()
    ).data();
    return { count: Number(d.count), gross: Number(d.gross), storeShare: Number(d.storeShare), operatorShare: Number(d.operatorShare), fee: Number(d.fee) };
  };
  const inYm = (y: string) => (t: (typeof seed)[number]) => jstYearMonth(t.paidAt) === y;
  const cases: [string, () => Promise<unknown>, () => Promise<unknown>, ReturnType<typeof expected>][] = [
    ["今月・全店舗", () => monthTotals(ym), () => firestoreSum("cYm", ym), expected(inYm(ym))],
    ["先月・全店舗", () => monthTotals(lastYm), () => firestoreSum("cYm", lastYm), expected(inYm(lastYm))],
    ["今月・店舗A", () => monthTotals(ym, sa.id), () => firestoreSum("cStoreYm", `${sa.id}_${ym}`), expected((t) => inYm(ym)(t) && t.store === sa.id)],
    ["今月・店舗B", () => monthTotals(ym, sb.id), () => firestoreSum("cStoreYm", `${sb.id}_${ym}`), expected((t) => inYm(ym)(t) && t.store === sb.id)],
    ["全期間・全店舗", () => totalsForRange(null), () => firestoreSum("countable", true), expected(() => true)],
  ];
  for (const [label, now, before, exp] of cases) {
    const a = await check(label, now);
    assert.deepEqual(a, exp, `${label}: 期待値と一致しない`);
    assert.deepEqual(a, await before(), `${label}: 以前の SUM 集計と一致しない`);
  }
  // 店舗一覧（今月）も同じ値・店舗取り分は30%・運営取り分は70%
  const list = await listStores({ range: jstMonthRange(ym), sort: "count", dir: "desc", page: 1, perPage: 20 });
  const rowA = list.rows.find((r) => r.id === sa.id)!;
  assert.deepEqual([rowA.count, rowA.gross, rowA.storeShare, rowA.operatorShare], [2, 200, 60, 140]);
  assert.equal(rowA.storeShare / rowA.gross, 0.3);
  assert.equal(rowA.operatorShare / rowA.gross, 0.7);
  // 日別（今月）：1日・2日に1件ずつ、3日に1件（返金・失敗・疑似決済は数えない）
  const days = await dailySeries(ym);
  assert.deepEqual(days.slice(0, 4).map((d) => d.count), [1, 1, 1, 0]);
  ok("集計（件数・売上・店舗30%・運営70%・手数料・返金/失敗/疑似決済の除外・月別・店舗別・全期間）が以前の SUM 集計と一致");

  // ---- 3. 決済代行のテスト決済（PAY.JP のテストキー）は売上・取り分・精算に含めない ----
  const [sc, sd] = [await store("テスト決済確認C"), await store("精算済み確認D")];
  const testDocs: [string, Record<string, unknown>][] = [];
  const base = (storeId: string, i: number, paidAt: Date) => ({
    storeId,
    amount: 100,
    storeShare: 30,
    operatorShare: 70,
    paymentFee: 4,
    paymentStatus: "SUCCEEDED",
    paymentProvider: "payjp",
    fortuneStatus: "COMPLETED",
    fortuneType: "ZODIAC",
    providerPaymentId: `kind-${i}`,
    paidAt,
  });
  for (const [storeId, ym2] of [
    [sc.id, ym],
    [sc.id, lastYm],
    [sd.id, lastYm],
  ] as const) {
    const paidAt = at(ym2, 5);
    const i = testDocs.length;
    // 本番環境の決済（数える）
    testDocs.push([`kind-live-${i}`, { ...base(storeId, i, paidAt), livemode: true, ...salesKeys(storeId, "payjp", "SUCCEEDED", paidAt, true) }]);
    // 今回の修正後に記録されるテスト決済（countable=false で保存される）
    testDocs.push([`kind-test-${i}`, { ...base(storeId, i + 1, paidAt), livemode: false, ...salesKeys(storeId, "payjp", "SUCCEEDED", paidAt, false) }]);
    // 修正前に記録されたテスト決済（以前の判定で countable=true のまま保存されている）
    testDocs.push([`kind-legacy-test-${i}`, { ...base(storeId, i + 2, paidAt), livemode: false, ...salesKeys(storeId, "payjp", "SUCCEEDED", paidAt, true) }]);
    // livemode が記録されていない（本番の決済と判定できない）
    testDocs.push([`kind-unknown-${i}`, { ...base(storeId, i + 3, paidAt), ...salesKeys(storeId, "payjp", "SUCCEEDED", paidAt, true) }]);
  }
  // 店舗Dの先月分は、テスト決済を含んだ金額で「支払済」になっている精算（自動では変更しない）
  const paidSettlement = { storeId: sd.id, yearMonth: lastYm, transactionCount: 4, grossSales: 400, storeShare: 120, status: "PAID", paidAt: new Date(), note: "", createdAt: new Date(), updatedAt: new Date() };
  const b2 = fsdb().batch();
  for (const [id, doc] of testDocs) b2.set(fsdb().collection(C.transactions).doc(id), doc);
  b2.set(fsdb().collection(C.settlements).doc(`${sd.id}_${lastYm}`), paidSettlement);
  await b2.commit();

  const one = { count: 1, gross: 100, storeShare: 30, operatorShare: 70, fee: 4 };
  assert.deepEqual(await monthTotals(ym, sc.id), one, "今月・店舗C: テスト決済・判定不可を数えている");
  assert.deepEqual(await monthTotals(lastYm, sc.id), one);
  assert.deepEqual(await totalsForRange(null, sc.id), { count: 2, gross: 200, storeShare: 60, operatorShare: 140, fee: 8 });
  assert.deepEqual(await totalsBetween(at(ym, 5, 0), at(ym, 6, 0), sc.id), one);
  assert.equal((await dailySeries(ym, sc.id))[4].count, 1);
  const scRow = (await listStores({ range: jstMonthRange(ym), sort: "count", dir: "desc", page: 1, perPage: 50 })).rows.find((r) => r.id === sc.id)!;
  assert.deepEqual([scRow.count, scRow.storeShare], [1, 30]);
  ok("テスト決済（新旧の記録とも）・livemode が無い決済は、売上・店舗取り分・日別・店舗一覧に数えない");

  // 店舗の売上画面には本番の決済だけ、運営の決済履歴にはテスト決済も種類つきで表示
  const storeList = await listTransactions({ storeId: sc.id, yearMonth: ym, page: 1, perPage: 50, audience: "store" });
  assert.deepEqual(storeList.rows.map((r) => r.kind), ["live"]);
  const opList = await listTransactions({ storeId: sc.id, yearMonth: ym, page: 1, perPage: 50, audience: "operator" });
  assert.deepEqual(opList.rows.map((r) => r.kind).sort(), ["live", "test", "test", "unknown"]);
  ok("店舗の売上画面はテスト決済を表示しない。運営の決済履歴はテスト決済・判定不可も種類つきで確認できる");

  // 月次精算：先月分を作成 → 店舗Cは本番の決済1件だけ。支払済の店舗Dは変更しない
  await generateSettlements(lastYm, SYSTEM);
  const sets = (await listSettlements({ yearMonth: lastYm })).map((x) => x.s);
  const setC = sets.find((x) => x.storeId === sc.id)!;
  assert.deepEqual([setC.transactionCount, setC.grossSales, setC.storeShare, setC.status], [1, 100, 30, "UNPAID"]);
  const setD = sets.find((x) => x.storeId === sd.id)!;
  assert.deepEqual([setD.transactionCount, setD.grossSales, setD.storeShare, setD.status], [4, 400, 120, "PAID"]);
  ok("月次精算はテスト決済を含めない（店舗C=1件30円）。支払済の精算は自動で書き換えない（店舗D）");
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error("ADMIN EMPTY E2E FAILED:", (e as Error).message);
    process.exit(1);
  },
);
