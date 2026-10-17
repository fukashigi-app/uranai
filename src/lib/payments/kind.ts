/**
 * 決済の種類の判定（売上・店舗の取り分・月次精算に数えるかどうか）。
 *
 *  live    … 決済代行の本番環境の決済（livemode === true）。売上に数える
 *  test    … 決済代行のテスト環境の決済（PAY.JP のテストキーなど。livemode === false）。売上に数えない
 *  mock    … 自動テスト用の疑似決済。売上に数えない（例外は下記）
 *  unknown … livemode が記録されていない。本番の決済と確認できないため売上に数えない
 *
 * 例外: 自動テスト環境（PAYMENT_PROVIDER=mock を明示し、Vercel の本番ではない）では、疑似決済が唯一の決済手段なので
 *       運営・店舗の集計画面には数える。ただし月次精算（振込）には決して含めない（isSettlementPayment）。
 *
 * データベースの値は変更せず、集計・一覧の読み取り時にこの判定を使う（既存データとの互換性のため）。
 */
export type PaymentKind = "live" | "test" | "mock" | "unknown";

type Env = Record<string, string | undefined>;

export function paymentKind(provider: string, livemode: unknown): PaymentKind {
  if (provider === "mock") return "mock";
  if (livemode === true) return "live";
  if (livemode === false) return "test";
  return "unknown";
}

/** 自動テスト環境で疑似決済を集計に数えるか（Vercel の本番では常に false） */
export function mockPaymentsCountable(env: Env = process.env): boolean {
  return env.PAYMENT_PROVIDER === "mock" && env.VERCEL_ENV !== "production";
}

/** 売上の集計・店舗の売上画面に数える決済か（決済の状態は別に判定する） */
export function isSalesPayment(provider: string, livemode: unknown, env: Env = process.env): boolean {
  const kind = paymentKind(provider, livemode);
  return kind === "live" || (kind === "mock" && mockPaymentsCountable(env));
}

/** 月次精算（店舗への振込）の対象になる決済か。本番環境の決済だけ（疑似決済・テスト決済・判定不可は常に除外） */
export function isSettlementPayment(provider: string, livemode: unknown): boolean {
  return paymentKind(provider, livemode) === "live";
}

export const PAYMENT_KIND_LABEL: Record<PaymentKind, string> = {
  live: "本番決済",
  test: "テスト決済",
  mock: "疑似決済",
  unknown: "判定不可",
};
