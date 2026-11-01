import { RESTORE_SUCCESS_NOTICE } from "@/lib/payments/stripe-sync-rules";

/**
 * 運営の決済履歴の画面の上部に出す、操作の成功の通知（固定の文言だけ。決済ID・理由・個人情報は含めない）。
 * 操作が成功して対象が一覧から消える（行の中のメッセージも消える）ときに、決済履歴の画面に移動して表示する。
 * クエリの notice は表示する文言を選ぶだけで、権限の確認・成功の判定・データの更新には使わない。知らない値は表示しない。
 */
export const ADMIN_TX_NOTICES = {
  entitlement_restored: RESTORE_SUCCESS_NOTICE,
  refund_reviewed: "返金の確認を完了しました",
  dispute_reviewed: "異議申し立ての確認を完了しました",
} as const;

export type AdminTxNotice = keyof typeof ADMIN_TX_NOTICES;

export const adminTxNoticeOf = (v: unknown): AdminTxNotice | null => (typeof v === "string" && Object.hasOwn(ADMIN_TX_NOTICES, v) ? (v as AdminTxNotice) : null);

export const adminTxNoticeUrl = (n: AdminTxNotice) => `/admin/transactions?notice=${n}`;
