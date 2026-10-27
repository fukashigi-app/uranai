import "server-only";
import type { DocumentData } from "firebase-admin/firestore";
import { createHash } from "node:crypto";
import { C, fsdb, safeId, toDate } from "./admin";
import { writeAudit } from "./audit";
import { upsertDedupedRecord } from "./deduped-record";
import { recordPaymentAlert } from "./payment-alerts";
import { alertModeOf } from "@/lib/payments/monitor-rules";

/**
 * 決済要確認（Firestore 版）。運営が確認すべき決済の食い違いを記録する。
 *  paymentReviews/{種類_対象ID} … 種類と対象（Stripe の通知の対象・取引・精算）ごとに1件
 *
 * 記録するのは、署名を確認できた Stripe の通知の処理と、精算の確認で見つかったものだけ。署名が不正な通知は信用せず、記録しない。
 * 同じ種類・同じ対象の記録は1件にまとめ、回数（occurrences）と最後の日時だけを更新する（通知の再送で無制限に増えない）。
 * 確認済みにした後、内容（causeKey）が変わったら「未確認」に戻す。同じ内容のくり返しでは戻さない。
 * 保存するのは ID・金額・食い違った項目名だけ。秘密情報・カード情報・通知の本文は保存しない。
 */

export type PaymentReviewKind =
  | "charge_mismatch"
  | "dispute_amount_invalid"
  | "transaction_not_found"
  | "mode_mismatch"
  | "multiple_disputes"
  | "dispute_state_regressed"
  | "legacy_settlement_change"
  | "legacy_settlement_mismatch";

export const PAYMENT_REVIEW_LABEL: Record<PaymentReviewKind, string> = {
  charge_mismatch: "Stripe の決済と記録が一致しない（返金・異議申し立てを反映していません）",
  dispute_amount_invalid: "異議申し立ての金額・通貨が決済と合わない（反映していません）",
  transaction_not_found: "このアプリの注文の決済だが、決済記録が見つからない",
  mode_mismatch: "本番とテストの取り違え（受け付けていません）",
  multiple_disputes: "同じ決済に別の異議申し立てが届いた（反映していません）",
  dispute_state_regressed: "結果が出た異議申し立てが、対応中に戻った（反映していません）",
  legacy_settlement_change: "以前に確定した精算の月の取引が、後から返金・異議申し立てで変わった（支払った額が不明なため、調整していません）",
  legacy_settlement_mismatch: "以前に確定した精算の金額と、今の集計が一致しない（調整していません）",
};

export type PaymentReviewStatus = "OPEN" | "RESOLVED";

export type PaymentReviewInput = {
  kind: PaymentReviewKind;
  /** 対象の種類と ID（例：dispute dp_…、charge ch_…、transaction stripe_pi_…、settlement 店舗ID_年月） */
  objectType: "dispute" | "charge" | "refund" | "event" | "transaction" | "settlement";
  objectId: string;
  eventType?: string | null;
  transactionId?: string | null;
  storeId?: string | null;
  chargeId?: string | null;
  paymentIntentId?: string | null;
  settlementId?: string | null;
  yearMonth?: string | null;
  /** 食い違った項目名（例：store・amount） */
  mismatches?: string[];
  /** 関係する金額（円。例：取り分の変化・申し立ての額） */
  amount?: number | null;
  livemode?: boolean | null;
};

export type PaymentReview = PaymentReviewInput & { id: string; status: PaymentReviewStatus; occurrences: number; firstSeenAt: Date | null; lastSeenAt: Date | null; resolvedAt: Date | null; resolvedBy: string | null };

const col = () => fsdb().collection(C.paymentReviews);
const ID_RE = /^[A-Za-z0-9_:.-]{1,200}$/;
const clean = (v: unknown) => (typeof v === "string" && ID_RE.test(v) ? v : null);

export const paymentReviewId = (kind: PaymentReviewKind, objectId: string) => safeId(kind, createHash("sha256").update(objectId).digest("hex").slice(0, 40));

/** 記録を待つ上限（Firestore に接続できないときに、Webhook の応答が止まらないように） */
export const PAYMENT_REVIEW_TIMEOUT_MS = 3000;

/**
 * 記録する（同じ種類・対象なら回数を増やすだけ）。失敗・時間切れでも決済の処理は止めない。
 * 記録できなかったときは、サーバーのログに "[payment-review] record failed"（種類・対象の種類・エラーの名前だけ）を残す。
 */
export async function recordPaymentReview(input: PaymentReviewInput): Promise<void> {
  const objectId = clean(input.objectId) ?? "invalid";
  const fields = {
    kind: input.kind,
    objectType: input.objectType,
    objectId,
    eventType: clean(input.eventType),
    transactionId: clean(input.transactionId),
    storeId: clean(input.storeId),
    chargeId: clean(input.chargeId),
    paymentIntentId: clean(input.paymentIntentId),
    settlementId: clean(input.settlementId),
    yearMonth: typeof input.yearMonth === "string" && /^\d{4}-\d{2}$/.test(input.yearMonth) ? input.yearMonth : null,
    mismatches: (input.mismatches ?? []).filter((m) => /^[a-z_]{1,40}$/.test(m)).slice(0, 10),
    amount: Number.isSafeInteger(input.amount) ? input.amount : null,
    livemode: typeof input.livemode === "boolean" ? input.livemode : null,
  };
  // 内容が変わったか（食い違った項目・金額）。通知の種類や回数の違いでは変わらない
  const causeKey = JSON.stringify([fields.kind, fields.mismatches, fields.amount]);
  let r: { ok: true } | { ok: false; error: string };
  try {
    r = await upsertDedupedRecord(col().doc(paymentReviewId(input.kind, objectId)), fields, { causeKey, reopen: "on_change", timeoutMs: PAYMENT_REVIEW_TIMEOUT_MS });
  } catch (e) {
    r = { ok: false, error: (e as Error)?.name ?? "Error" };
  }
  if (!r.ok) {
    console.error("[payment-review] record failed", { kind: input.kind, objectType: input.objectType, error: r.error });
    // 決済監視にも残す（こちらも失敗したらサーバーのログだけ）
    await recordPaymentAlert({ kind: "payment_review_record_failed", objectType: "review", objectId: `${input.kind}:${objectId}`, mode: alertModeOf(input.livemode), transactionId: input.transactionId ?? null, storeId: input.storeId ?? null, errorName: r.error });
  }
}

function toReview(id: string, d: DocumentData): PaymentReview {
  return {
    id,
    kind: d.kind,
    objectType: d.objectType,
    objectId: String(d.objectId),
    eventType: d.eventType ?? null,
    transactionId: d.transactionId ?? null,
    storeId: d.storeId ?? null,
    chargeId: d.chargeId ?? null,
    paymentIntentId: d.paymentIntentId ?? null,
    settlementId: d.settlementId ?? null,
    yearMonth: d.yearMonth ?? null,
    mismatches: Array.isArray(d.mismatches) ? d.mismatches.map(String) : [],
    amount: typeof d.amount === "number" ? d.amount : null,
    livemode: typeof d.livemode === "boolean" ? d.livemode : null,
    status: d.status === "RESOLVED" ? "RESOLVED" : "OPEN",
    occurrences: Number(d.occurrences ?? 1),
    firstSeenAt: toDate(d.firstSeenAt),
    lastSeenAt: toDate(d.lastSeenAt),
    resolvedAt: toDate(d.resolvedAt),
    resolvedBy: d.resolvedBy ?? null,
  };
}

/** 一覧（未確認を先に、新しい順） */
export async function listPaymentReviews(opts: { status?: PaymentReviewStatus; limit?: number } = {}): Promise<PaymentReview[]> {
  const snap = await (opts.status ? col().where("status", "==", opts.status) : col()).get();
  return snap.docs
    .map((d) => toReview(d.id, d.data()))
    .sort((a, b) => (a.status === b.status ? (b.lastSeenAt?.getTime() ?? 0) - (a.lastSeenAt?.getTime() ?? 0) : a.status === "OPEN" ? -1 : 1))
    .slice(0, opts.limit ?? 200);
}

/** 確認済みにする（運営の操作。監査ログに残す） */
export async function resolvePaymentReview(id: string, actor: { userId: string; role: "OPERATOR" }): Promise<boolean> {
  if (!/^[A-Za-z0-9_]{1,120}$/.test(id)) return false;
  const ref = col().doc(id);
  return fsdb().runTransaction(async (tx) => {
    const cur = await tx.get(ref);
    if (!cur.exists || cur.get("status") !== "OPEN") return false;
    tx.update(ref, { status: "RESOLVED", resolvedAt: new Date(), resolvedBy: actor.userId });
    await writeAudit({ actorUserId: actor.userId, actorRole: actor.role, action: "payment_review.resolved", targetType: "payment_review", targetId: id, storeId: cur.get("storeId") ?? undefined, before: { kind: cur.get("kind") }, after: null }, tx);
    return true;
  });
}

export async function countOpenPaymentReviews(): Promise<number> {
  return (await col().where("status", "==", "OPEN").count().get()).data().count;
}
