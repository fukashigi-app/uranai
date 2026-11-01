import "server-only";
import { isSalesPayment } from "@/lib/payments/kind";
import { jstDateString, jstYearMonth } from "@/lib/time";

/**
 * 売上集計用のフィールド（決済記録時に日本時間で計算して保存）。
 * Firestore は「1つの等価条件」の検索なら自動インデックスだけで動くため、
 * 集計で使う組み合わせ（年月・店舗・店舗×年月・日付）をあらかじめ1つの値にしておく。
 *
 * countable … 売上に数えるか（決済成功 かつ 本番環境の決済。返金されたら false にする）。
 *             テスト決済（livemode=false）・疑似決済は数えない（自動テスト環境の疑似決済だけ例外。lib/payments/kind.ts）。
 * 以前に保存したデータは countable が古い判定のままなので、集計の読み取り時にも isSalesPayment で必ず確認する。
 */
export function salesKeys(storeId: string, provider: string, paymentStatus: string, paidAt: Date, livemode: unknown) {
  const yearMonth = jstYearMonth(paidAt);
  const paidDate = jstDateString(paidAt);
  const countable = paymentStatus === "SUCCEEDED" && isSalesPayment(provider, livemode);
  return {
    yearMonth,
    paidDate,
    storeYm: `${storeId}_${yearMonth}`,
    countable,
    cYm: countable ? yearMonth : null,
    cDate: countable ? paidDate : null,
    cStore: countable ? storeId : null,
    cStoreYm: countable ? `${storeId}_${yearMonth}` : null,
  };
}

/**
 * 手数料の集計用のフィールド（決済記録の作成時に1回だけ保存し、返金・異議申し立てでは変えない）。
 * 決済手数料は返金・チャージバックの後も返されない（Stripe は返金しても手数料を返さない。運営の負担のまま）ので、
 * 売上の集計（countable。返金・敗訴で false になる）とは分けて、決済の状態に関係なく数える。
 * 対象は売上と同じく本番の決済（自動テスト環境の疑似決済を含む。lib/payments/kind.ts）だけ。テスト決済は null。
 * 年月・日付は決済日時（日本時間）。手数料は決済の時点で発生するため。
 */
export function feeKeys(storeId: string, provider: string, paidAt: Date, livemode: unknown) {
  const yearMonth = jstYearMonth(paidAt);
  const ok = isSalesPayment(provider, livemode);
  return {
    feeCountable: ok,
    feeYm: ok ? yearMonth : null,
    feeDate: ok ? jstDateString(paidAt) : null,
    feeStore: ok ? storeId : null,
    feeStoreYm: ok ? `${storeId}_${yearMonth}` : null,
  };
}

/** 集計の読み取り時の確認（以前の判定で countable=true になっているテスト決済などを除く） */
export function isSalesDoc(d: { get(field: string): unknown }): boolean {
  return isSalesPayment(String(d.get("paymentProvider")), d.get("livemode"));
}

/** Firestore の「既に存在する」エラー */
export function isAlreadyExists(e: unknown): boolean {
  const code = (e as { code?: unknown })?.code;
  return code === 6 || code === "already-exists" || /ALREADY_EXISTS/.test(String((e as Error)?.message));
}
