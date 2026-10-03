import "server-only";
import { jstDateString, jstYearMonth } from "@/lib/time";

/**
 * 売上集計用のフィールド（決済記録時に日本時間で計算して保存）。
 * Firestore は「1つの等価条件」の検索なら自動インデックスだけで動くため、
 * 集計で使う組み合わせ（年月・店舗・店舗×年月・日付）をあらかじめ1つの値にしておく。
 *
 * countable … 売上に数えるか（決済成功 かつ テスト用の疑似決済ではない）。返金されたら false にする。
 *             PostgreSQL 版と同じく、PAYMENT_PROVIDER=mock を明示した自動テスト環境だけ疑似決済も数える。
 */
export function salesKeys(storeId: string, provider: string, paymentStatus: string, paidAt: Date) {
  const yearMonth = jstYearMonth(paidAt);
  const paidDate = jstDateString(paidAt);
  const countable = paymentStatus === "SUCCEEDED" && (provider !== "mock" || process.env.PAYMENT_PROVIDER === "mock");
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

/** 一覧表示でテスト用の疑似決済を除外するか（PostgreSQL 版の realPaymentsOnly と同じ判定） */
export function isRealPayment(provider: string): boolean {
  return provider !== "mock" || process.env.PAYMENT_PROVIDER === "mock";
}

/** Firestore の「既に存在する」エラー */
export function isAlreadyExists(e: unknown): boolean {
  const code = (e as { code?: unknown })?.code;
  return code === 6 || code === "already-exists" || /ALREADY_EXISTS/.test(String((e as Error)?.message));
}
