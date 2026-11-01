/**
 * 運営の「決済要確認」「決済監視」の画面の、確認済みにする操作の成功の通知と、移動先の URL（固定の文言だけ。ID・個人情報・エラーの詳細は含めない）。
 * 確認済みにした項目は未確認の一覧から消える（行の中のメッセージも消える）ので、元の画面に移動して上部に通知を出す。
 * 絞り込みは決まった値だけを引き継ぐ（それ以外は既定の絞り込みにする）。クエリは表示だけに使い、権限の確認・成功の判定・データの更新には使わない。
 */
export const REVIEW_RESOLVED_NOTICE = "決済要確認を確認済みにしました";
export const ALERT_RESOLVED_NOTICE = "決済監視の異常を確認済みにしました";

/** 通知を出すクエリの値 */
export const LIST_NOTICE = { review: "review_resolved", alert: "alert_resolved" } as const;

const statusOf = (v: unknown): "RESOLVED" | "all" | null => (v === "RESOLVED" || v === "all" ? v : null);
const modeOf = (v: unknown): "live" | "test" | "unknown" | null => (v === "live" || v === "test" || v === "unknown" ? v : null);
const field = (f: unknown, k: string) => (f && typeof f === "object" ? (f as Record<string, unknown>)[k] : undefined);

/** 決済要確認の画面の URL（絞り込みの status は RESOLVED・all だけ引き継ぐ。未確認は既定） */
export function paymentReviewsUrl(filter: unknown, notice: boolean): string {
  const p = new URLSearchParams();
  const status = statusOf(field(filter, "status"));
  if (status) p.set("status", status);
  if (notice) p.set("notice", LIST_NOTICE.review);
  const q = p.toString();
  return `/admin/payment-reviews${q ? `?${q}` : ""}`;
}

/** 決済監視の画面の URL（絞り込みの status・mode を引き継ぐ。status は OPEN も明示されていれば残す） */
export function paymentMonitorUrl(filter: unknown, notice: boolean): string {
  const p = new URLSearchParams();
  const rawStatus = field(filter, "status");
  const status = rawStatus === "OPEN" ? "OPEN" : statusOf(rawStatus);
  if (status) p.set("status", status);
  const mode = modeOf(field(filter, "mode"));
  if (mode) p.set("mode", mode);
  if (notice) p.set("notice", LIST_NOTICE.alert);
  const q = p.toString();
  return `/admin/payment-monitor${q ? `?${q}` : ""}`;
}
