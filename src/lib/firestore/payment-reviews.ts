import "server-only";
import type { DocumentData, DocumentSnapshot, Transaction } from "firebase-admin/firestore";
import { createHash } from "node:crypto";
import { C, fsdb, safeId, toDate } from "./admin";
import { writeAudit } from "./audit";
import { upsertDedupedRecord, upsertDedupedRecordInTx } from "./deduped-record";
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
  | "legacy_settlement_mismatch"
  | "paid_payment_method_not_allowed"
  | "paid_checkout_unconfirmable";

export const PAYMENT_REVIEW_LABEL: Record<PaymentReviewKind, string> = {
  charge_mismatch: "Stripe の決済と記録が一致しない（返金・異議申し立てを反映していません）",
  dispute_amount_invalid: "異議申し立ての金額・通貨が決済と合わない（反映していません）",
  transaction_not_found: "このアプリの注文の決済だが、決済記録が見つからない",
  mode_mismatch: "本番とテストの取り違え（受け付けていません）",
  multiple_disputes: "同じ決済に別の異議申し立てが届いた（反映していません）",
  dispute_state_regressed: "結果が出た異議申し立てが、対応中に戻った（反映していません）",
  legacy_settlement_change: "以前に確定した精算の月の取引が、後から返金・異議申し立てで変わった（支払った額が不明なため、調整していません）",
  legacy_settlement_mismatch: "以前に確定した精算の金額と、今の集計が一致しない（調整していません）",
  paid_payment_method_not_allowed: "Stripe では支払い済みだが、許可していない支払い方法のため、決済を確定せず占いの権利も付与していない（返金などの対応が必要。自動では返金しません）",
  paid_checkout_unconfirmable:
    "Stripe では支払い済みだが、アプリの注文・店舗の記録と照合できないため、決済を確定せず占いの権利も付与していない（注文・店舗の記録を確認し、復旧するか返金などの対応が必要。自動では返金しません）",
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
  /** 注文の ID（paid_payment_method_not_allowed など、注文と Stripe の決済を結び付けて確認する記録だけ） */
  checkoutId?: string | null;
  /** Stripe の Checkout Session の ID（同上） */
  sessionId?: string | null;
  /** 支払い方法の種類の名前（例：link・card:samsung_pay。カードの番号・名前などは含めない） */
  paymentMethodType?: string | null;
};

export type PaymentReview = PaymentReviewInput & { id: string; status: PaymentReviewStatus; occurrences: number; firstSeenAt: Date | null; lastSeenAt: Date | null; resolvedAt: Date | null; resolvedBy: string | null };

const col = () => fsdb().collection(C.paymentReviews);
const ID_RE = /^[A-Za-z0-9_:.-]{1,200}$/;
const clean = (v: unknown) => (typeof v === "string" && ID_RE.test(v) ? v : null);

export const paymentReviewId = (kind: PaymentReviewKind, objectId: string) => safeId(kind, createHash("sha256").update(objectId).digest("hex").slice(0, 40));

/** 記録を待つ上限（Firestore に接続できないときに、Webhook の応答が止まらないように）。失敗しても止めない記録（recordPaymentReview） */
export const PAYMENT_REVIEW_TIMEOUT_MS = 3000;

/**
 * 記録が必須の決済要確認（recordRequiredPaymentReview）を待つ上限。
 * 同じ記録に複数の通知が同時に届くと、Firestore の SDK がトランザクションをやり直す（最大5回。2回目以降の待ち時間は
 * 0秒・約1秒・約1.5秒・約2.25秒、それぞれ ±50%）。3秒では3回目以降のやり直しが収まらず、不要な 500 になっていた。
 * 6秒なら4回目までがおおむね収まる。長くしすぎると、関数の実行時間の上限（Webhook の maxDuration＝300秒）の中で、
 * Stripe API の呼び出しと合わせて上限を超えるおそれがあるため、10秒にはしない（docs/preview-verification.md §11）。
 */
export const REQUIRED_PAYMENT_REVIEW_TIMEOUT_MS = 6000;

/**
 * 記録する（同じ種類・対象なら回数を増やすだけ）。失敗・時間切れでも決済の処理は止めない。
 * 記録できなかったときは、サーバーのログに "[payment-review] record failed"（種類・対象の種類・エラーの名前だけ）を残す。
 */
export async function recordPaymentReview(input: PaymentReviewInput): Promise<void> {
  const objectId = clean(input.objectId) ?? "invalid";
  let r: { ok: true } | { ok: false; error: string; unknown?: boolean };
  try {
    const { ref, fields, causeKey } = reviewWrite(input); // Firestore に接続できない設定でも例外にしない（参照の作成も含める）
    r = await upsertDedupedRecord(ref, fields, { causeKey, reopen: "on_change", timeoutMs: PAYMENT_REVIEW_TIMEOUT_MS });
  } catch (e) {
    r = { ok: false, error: (e as Error)?.name ?? "Error" };
  }
  if (!r.ok) {
    console.error("[payment-review] record failed", { kind: input.kind, objectType: input.objectType, error: r.error });
    // 決済監視にも残す（こちらも失敗したらサーバーのログだけ）
    await recordPaymentAlert({ kind: "payment_review_record_failed", objectType: "review", objectId: `${input.kind}:${objectId}`, mode: alertModeOf(input.livemode), transactionId: input.transactionId ?? null, storeId: input.storeId ?? null, errorName: r.error });
  }
}

/**
 * 記録が必須の異常で使う（決済記録が無い・照合できないなど、記録だけが運営に異常を知らせる手段のとき）。
 * 記録できなかったときは例外。呼び出し側（Webhook）は処理済みにせず 500 を返し、Stripe の再送で記録し直す。
 *  - PaymentReviewRecordError        … 書き込みが失敗した（保存されていない）
 *  - PaymentReviewRecordUnknownError … 待つのをやめた（REQUIRED_PAYMENT_REVIEW_TIMEOUT_MS）。保存されたかは不明で、
 *                                      裏で書き込みが続き後で保存されることがある（再送では通知の印で二重に数えない）
 * 異常の内容の検証の失敗（Stripe API の失敗など）は、この関数を呼ぶ前の別の例外になる。
 * webhookEvent（Webhook の通知）を渡すと、同じ通知では1回だけ数える：記録の更新と同じトランザクションで、
 * webhookEvents/{決済会社_通知ID}.recordedReviewIds に記録の ID を加え、すでにあれば何も書かない（回数・確認済みの状態を変えない）。
 * 以前の方式（記録の recentOccurrenceKeys に "event:<通知ID>"）で記録済みのものも、二重に数えない（新しくは追記しない）。
 * 通知の文書が無い（通常は beginWebhookEvent が処理の前に作るので無い）ときは、回数を増やさず PaymentReviewRecordError
 * （Webhook は 500。Stripe の再送で beginWebhookEvent が文書を作り直すので、次の処理で記録される）。
 * webhookEvent が無い（決済確定の後の再確認・運営の復旧など、同じ観測を見分ける手がかりが無い）ときは、記録が無ければ回数1で作り、
 * あれば回数を増やさない（最後の日時・内容の更新と、内容が変わったときの未確認への戻しは今までどおり。最初の日時・既存の回数は変えない）。
 * ID・重複のまとめ方・確認済みの扱い・内容が変わったときに未確認へ戻す規則は recordPaymentReview と同じ。
 */
export async function recordRequiredPaymentReview(
  input: PaymentReviewInput,
  opts: { webhookEvent?: { provider: string; eventId: string }; /** 自動テスト用（既定は REQUIRED_PAYMENT_REVIEW_TIMEOUT_MS） */ timeoutMs?: number } = {},
): Promise<void> {
  let r: { ok: true } | { ok: false; error: string; unknown: boolean };
  try {
    const { ref, fields, causeKey } = reviewWrite(input);
    r = await upsertDedupedRecord(ref, fields, {
      causeKey,
      reopen: "on_change",
      timeoutMs: opts.timeoutMs ?? REQUIRED_PAYMENT_REVIEW_TIMEOUT_MS,
      ...(opts.webhookEvent
        ? { occurrenceMarker: { ref: fsdb().collection(C.webhookEvents).doc(safeId(opts.webhookEvent.provider, opts.webhookEvent.eventId)), field: "recordedReviewIds", id: ref.id, legacyKey: `event:${opts.webhookEvent.eventId}` } }
        : { countRepeat: false }),
      onSettledAfterTimeout: (result) => console.warn("[payment-review] required record settled after the wait ended", { kind: input.kind, objectType: input.objectType, result }),
    });
  } catch (e) {
    r = { ok: false, error: (e as Error)?.name ?? "Error", unknown: false };
  }
  if (!r.ok) {
    console.error(r.unknown ? "[payment-review] required record result unknown (wait ended)" : "[payment-review] required record failed", { kind: input.kind, objectType: input.objectType, error: r.error });
    throw Object.assign(new Error(r.unknown ? "payment review record result is unknown" : "payment review could not be recorded"), {
      name: r.unknown ? "PaymentReviewRecordUnknownError" : "PaymentReviewRecordError",
      cause: r.error,
    });
  }
}

/** 記録の参照（種類と対象から決まる。トランザクションの中で、書き込みの前に読むために使う） */
export const paymentReviewRef = (kind: PaymentReviewKind, objectId: string) => col().doc(paymentReviewId(kind, clean(objectId) ?? "invalid"));

/**
 * 呼び出し側のトランザクションの中で記録する（決済記録・精算の更新と不可分にする）。
 * cur は同じトランザクションで、書き込みの前に読んだ記録（tx.get(paymentReviewRef(...))）。
 * ID・重複のまとめ方・確認済みの扱い・内容が変わったときに未確認へ戻す規則は recordPaymentReview と同じ。
 * 書き込みはトランザクションの確定と一緒にだけ反映される（やり直しで回数は増えない。失敗はトランザクション全体の失敗）。
 */
export function recordPaymentReviewInTx(tx: Transaction, cur: DocumentSnapshot, input: PaymentReviewInput): void {
  const { ref, fields, causeKey } = reviewWrite(input);
  upsertDedupedRecordInTx(tx, ref, cur, fields, { causeKey, reopen: "on_change" });
}

/** 記録の内容（ID・保存する項目・内容の判定のキー） */
function reviewWrite(input: PaymentReviewInput) {
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
    // 注文と Stripe の決済を結び付ける項目は、渡されたときだけ保存する（既存の種類の記録の内容は変えない）
    ...(input.checkoutId !== undefined ? { checkoutId: clean(input.checkoutId) } : {}),
    ...(input.sessionId !== undefined ? { sessionId: clean(input.sessionId) } : {}),
    ...(input.paymentMethodType !== undefined
      ? { paymentMethodType: typeof input.paymentMethodType === "string" && /^[a-z][a-z0-9_]{0,29}(:[a-z][a-z0-9_]{0,29})?$/.test(input.paymentMethodType) ? input.paymentMethodType : null }
      : {}),
  };
  // 内容が変わったか（食い違った項目・金額）。通知の種類や回数の違いでは変わらない
  const causeKey = JSON.stringify([fields.kind, fields.mismatches, fields.amount]);
  return { ref: col().doc(paymentReviewId(input.kind, objectId)), fields, causeKey };
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
    checkoutId: d.checkoutId ?? null,
    sessionId: d.sessionId ?? null,
    paymentMethodType: d.paymentMethodType ?? null,
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
