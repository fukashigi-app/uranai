import { describe, expect, it } from "vitest";
import { feeKeys, salesKeys } from "@/lib/firestore/shared";
import { feeTotalsOf } from "@/lib/firestore/reports";

// 決済手数料の集計（返金・チャージバックの後も手数料は運営の負担のまま。Firestore には接続しない）
const PAID = new Date("2026-10-15T03:00:00Z"); // 日本時間 2026-10-15 12:00
const doc = (id: string, f: Record<string, unknown>) => ({ id, get: (k: string) => f[k] });
const live = (over: Record<string, unknown> = {}) => ({ paymentProvider: "stripe", livemode: true, paymentFee: 4, feeEstimated: false, ...feeKeys("st_1", "stripe", PAID, true), ...over });

describe("手数料の集計用のキー（feeKeys）", () => {
  it("本番の決済：決済日時（日本時間）の年月・日付・店舗。決済の状態に関係しない", () => {
    expect(feeKeys("st_1", "stripe", PAID, true)).toEqual({ feeCountable: true, feeYm: "2026-10", feeDate: "2026-10-15", feeStore: "st_1", feeStoreYm: "st_1_2026-10" });
    // 月末の深夜（日本時間では翌月）
    expect(feeKeys("st_1", "stripe", new Date("2026-10-31T15:30:00Z"), true)).toMatchObject({ feeYm: "2026-11", feeDate: "2026-11-01" });
  });

  it("テスト決済・判定不可は手数料の集計に入れない（キーは null）", () => {
    for (const lm of [false, undefined, null, "true"]) {
      expect(feeKeys("st_1", "stripe", PAID, lm)).toEqual({ feeCountable: false, feeYm: null, feeDate: null, feeStore: null, feeStoreYm: null });
    }
  });

  it("売上のキーとは別：返金・チャージバックで売上の対象外（countable=false）になっても、手数料のキーは変わらない", () => {
    for (const status of ["SUCCEEDED", "REFUNDED", "CHARGEBACK"]) {
      expect(feeKeys("st_1", "stripe", PAID, true)).toMatchObject({ feeCountable: true, feeYm: "2026-10" });
      expect(salesKeys("st_1", "stripe", status, PAID, true).countable).toBe(status === "SUCCEEDED");
    }
  });
});

describe("手数料の合計（feeTotalsOf）", () => {
  it("正常・全額返金・一部返金・チャージバックの決済の手数料をすべて数える。確定値と推定値を分ける", () => {
    const fees = [
      doc("a", live()),
      doc("b", live({ paymentStatus: "REFUNDED" })),
      doc("c", live({ paymentStatus: "SUCCEEDED", amountRefunded: 30 })),
      doc("d", live({ paymentStatus: "CHARGEBACK" })),
      doc("e", live({ paymentFee: 5, feeEstimated: true })),
    ];
    expect(feeTotalsOf(fees, [])).toEqual({ fee: 21, feeEstimated: 5 });
  });

  it("同じ決済記録は1回だけ（手数料のキーと売上の両方で読んでも・同じ記録が重複しても）", () => {
    const a = doc("a", live());
    expect(feeTotalsOf([a, a], [a])).toEqual({ fee: 4, feeEstimated: 0 });
  });

  it("テスト決済（Sandbox）は数えない（以前の判定で countable=true の記録も）", () => {
    const t = doc("t", { paymentProvider: "stripe", livemode: false, paymentFee: 4, feeEstimated: false, feeCountable: false });
    const legacyTest = doc("lt", { paymentProvider: "stripe", livemode: false, paymentFee: 4, countable: true });
    expect(feeTotalsOf([t], [legacyTest])).toEqual({ fee: 0, feeEstimated: 0 });
  });

  it("キーの無い以前の決済記録は、売上の対象のものだけ今までどおり数える（Stripe 以外の以前の決済は推定値）", () => {
    const legacyStripe = doc("ls", { paymentProvider: "stripe", livemode: true, paymentFee: 4, feeEstimated: false });
    const legacyPayjp = doc("lp", { paymentProvider: "payjp", livemode: true, paymentFee: 4 });
    expect(feeTotalsOf([], [legacyStripe, legacyPayjp])).toEqual({ fee: 8, feeEstimated: 4 });
    // キーがある記録は、売上の側からは数えない（手数料のキーの側で数える。月をまたぐなどで二重にならない）
    expect(feeTotalsOf([], [doc("k", live())])).toEqual({ fee: 0, feeEstimated: 0 });
  });
});

describe("新旧の決済記録が混在するとき（手数料の集計用のキーの有無）", () => {
  // 新しい記録：手数料のキーがある（手数料のキーの検索と、売上の対象なら売上の検索の両方で読まれる）
  const newOk = doc("n1", live({ paymentStatus: "SUCCEEDED" }));
  const newRefunded = doc("n2", live({ paymentStatus: "REFUNDED" })); // 売上の検索には出ない
  const newChargeback = doc("n3", live({ paymentStatus: "CHARGEBACK" }));
  // 以前の記録：手数料のキーが無い（売上の検索だけで読まれる。返金済みは売上の検索に出ない）
  const oldOk = doc("o1", { paymentProvider: "stripe", livemode: true, paymentFee: 4, feeEstimated: false, paymentStatus: "SUCCEEDED" });
  const oldEstimated = doc("o2", { paymentProvider: "stripe", livemode: true, paymentFee: 5, feeEstimated: true, paymentStatus: "SUCCEEDED" });

  it("新しい記録は手数料のキーの側で1回、以前の記録は売上の側で1回だけ数える（両方の検索に同じ記録があっても）", () => {
    const feeDocs = [newOk, newRefunded, newChargeback];
    const salesDocs = [newOk, oldOk, oldEstimated]; // 売上の検索の結果（成功した決済だけ）
    expect(feeTotalsOf(feeDocs, salesDocs)).toEqual({ fee: 4 + 4 + 4 + 4 + 5, feeEstimated: 5 });
  });

  it("並び順・重複・検索の結果の入れ替わりに関係なく同じ結果", () => {
    const want = { fee: 21, feeEstimated: 5 };
    expect(feeTotalsOf([newChargeback, newOk, newRefunded, newOk], [oldEstimated, newOk, oldOk, newOk, oldOk])).toEqual(want);
    // 新しい記録が売上の側にしか無い（検索の上限などで手数料の側に無い）ときは、売上の側からは数えない（二重を避ける。数え漏れは手数料の側の検索で防ぐ）
    expect(feeTotalsOf([], [newOk])).toEqual({ fee: 0, feeEstimated: 0 });
  });

  it("日・店舗ごとに分けて数えた合計は、まとめて数えた合計と一致（同じ記録が2つの単位に入らない）", () => {
    const all = feeTotalsOf([newOk, newRefunded, newChargeback], [newOk, oldOk, oldEstimated]);
    const part1 = feeTotalsOf([newOk, newRefunded], [newOk, oldOk]);
    const part2 = feeTotalsOf([newChargeback], [oldEstimated]);
    expect({ fee: part1.fee + part2.fee, feeEstimated: part1.feeEstimated + part2.feeEstimated }).toEqual(all);
  });
});
