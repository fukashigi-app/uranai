import "server-only";
import { randomUUID } from "node:crypto";
import { FieldPath, FieldValue, Timestamp, type DocumentData } from "firebase-admin/firestore";
import type { checkouts, FortuneTypeValue } from "@/lib/db/schema";
import { CHECKOUT_TTL_MS, CURRENCY, defaultFeeRateBps, FORTUNE_SESSION_TTL_MS, PRICE_JPY, STORE_SHARE_BPS } from "@/config/pricing";
import { siteConfig } from "@/config/site";
import { calcFee, splitRevenue } from "@/lib/money";
import { getProvider, isProviderId } from "@/lib/payments";
import type { ProviderId } from "@/lib/payments/types";
import type { ConfirmOutcome } from "@/lib/payments/confirm";
import type { CheckoutStatusResult, PayResult } from "@/lib/services/checkout";
import { isCheckoutRefundReason, type CheckoutRefundReason } from "@/lib/payments/refunded-notice";
import { FORTUNE_CATALOG } from "@/lib/fortune/catalog";
import { randomToken, sha256Hex } from "@/lib/security/crypto";
import { CheckoutError, PAID_FLOW_BLOCKED_STORE_CODES, providerOrThrow } from "@/lib/errors";
import { C, fsdb, mustDate, safeId, toDate } from "./admin";
import { feeKeys, isAlreadyExists, salesKeys } from "./shared";
import { reconcileTransactionInTx, settlementRefForTx } from "./settlement-adjustments";
import { paymentReviewRef, recordPaymentReview, recordPaymentReviewInTx, type PaymentReviewInput } from "./payment-reviews";
import { isSalesPayment } from "@/lib/payments/kind";
import { findStoreByCode } from "./stores";
import { decodeWebhookEventCursor, encodeWebhookEventCursor, isStaleUnfinished, webhookEventStateOf, type StripeEventMeta, type WebhookEventState } from "@/lib/payments/webhook-event-state";

/**
 * 決済（Firestore 版）。ロジックは PostgreSQL 版（services/checkout.ts・payments/confirm.ts）と同じ。
 *
 *  checkouts/{checkoutId}               … 支払い前の注文
 *  transactions/{決済会社_決済ID}         … 決済履歴（売上集計の元データ）。IDが決済IDなので二重計上できない
 *  fortuneSessions/{transactionId}       … 占い権利（1決済につき1件）
 *  webhookEvents/{決済会社_イベントID}     … Webhook の処理済み記録
 */

type PgCheckout = typeof checkouts.$inferSelect;
/**
 * Firestore の注文。PostgreSQL の状態に加えて REFUNDED がある（Stripe の決済だけ。返金・チャージバックで占い権利を付与しない注文。
 * refundReason で返金か異議申し立ての敗訴かを区別する）。REFUNDED の注文は期限切れの処理・削除の対象にしない
 */
export type Checkout = Omit<PgCheckout, "status"> & { status: PgCheckout["status"] | "REFUNDED"; refundReason: CheckoutRefundReason | null };

const checkoutRef = (id: string) => fsdb().collection(C.checkouts).doc(id);
export const transactionDocId = (provider: string, paymentId: string) => safeId(provider, paymentId);
const transactionRef = (provider: string, paymentId: string) => fsdb().collection(C.transactions).doc(transactionDocId(provider, paymentId));

function toCheckout(id: string, d: DocumentData): Checkout {
  return {
    id,
    storeId: String(d.storeId),
    fortuneType: d.fortuneType,
    amount: Number(d.amount),
    status: d.status,
    provider: String(d.provider),
    providerPaymentId: d.providerPaymentId ?? null,
    accessTokenHash: String(d.accessTokenHash),
    attemptCount: Number(d.attemptCount ?? 0),
    failureCode: d.failureCode ?? null,
    refundReason: isCheckoutRefundReason(d.refundReason) ? d.refundReason : null,
    expiresAt: mustDate(d.expiresAt),
    processingStartedAt: toDate(d.processingStartedAt),
    createdAt: mustDate(d.createdAt),
    updatedAt: mustDate(d.updatedAt),
  };
}

// ---------- 注文 ----------

/**
 * 注文を作る。opts.provider = "stripe" のときは Stripe Checkout のテスト決済用（呼び出し側でテスト決済の条件と運営アカウントを確認済み）。
 * 有効期限は Stripe の Checkout Session と同じにする（opts.ttlMs）。
 */
export async function createCheckout(storeCode: string | null, fortuneType: FortuneTypeValue, opts: { provider?: "stripe"; ttlMs?: number } = {}) {
  if (!storeCode) throw new CheckoutError("no_store", "店舗のQRコードを読み込んでからご利用ください。");
  const store = await findStoreByCode(storeCode);
  if (!store) throw new CheckoutError("store_not_found", "店舗情報が見つかりません。お店のQRコードをもう一度読み込んでください。", 404);
  if (store.status !== "ACTIVE" || PAID_FLOW_BLOCKED_STORE_CODES.has(store.storeCode)) {
    throw new CheckoutError("store_suspended", "こちらの店舗では現在ご利用いただけません。", 403);
  }
  const providerId = opts.provider ?? providerOrThrow().id;
  const token = randomToken(32);
  const id = randomUUID();
  await checkoutRef(id).set({
    storeId: store.id,
    fortuneType,
    amount: PRICE_JPY, // 金額はサーバーの固定価格のみ
    status: "CREATED",
    provider: providerId,
    providerPaymentId: null,
    providerPaymentKey: null,
    accessTokenHash: sha256Hex(token),
    attemptCount: 0,
    failureCode: null,
    expiresAt: new Date(Date.now() + (opts.ttlMs ?? CHECKOUT_TTL_MS)),
    processingStartedAt: null,
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  });
  return { checkoutId: id, accessToken: token };
}

export async function getCheckoutByToken(token: string | null) {
  if (!token) return null;
  const q = await fsdb().collection(C.checkouts).where("accessTokenHash", "==", sha256Hex(token)).limit(1).get();
  if (q.empty) return null;
  const checkout = toCheckout(q.docs[0].id, q.docs[0].data());
  const st = await fsdb().collection(C.stores).doc(checkout.storeId).get();
  if (!st.exists) return null;
  return { checkout, storeName: String(st.get("name")), storeStatus: (st.get("status") === "SUSPENDED" ? "SUSPENDED" : "ACTIVE") as "ACTIVE" | "SUSPENDED" };
}

async function updateIf(id: string, pred: (d: DocumentData) => boolean, patch: Record<string, unknown>): Promise<boolean> {
  return fsdb().runTransaction(async (tx) => {
    const snap = await tx.get(checkoutRef(id));
    if (!snap.exists || !pred(snap.data()!)) return false;
    tx.update(checkoutRef(id), { ...patch, updatedAt: FieldValue.serverTimestamp() });
    return true;
  });
}

export async function payCheckout(token: string | null, cardToken: string): Promise<PayResult> {
  const found = await getCheckoutByToken(token);
  if (!found) throw new CheckoutError("not_found", "お支払い情報が見つかりません。お店のQRコードから再度お試しください。", 404);
  const { checkout } = found;
  if (checkout.status === "SUCCEEDED") return { status: "succeeded" };
  if (found.storeStatus !== "ACTIVE") throw new CheckoutError("store_suspended", "こちらの店舗では現在ご利用いただけません。", 403);
  // 決済方法の確認は状態を変える前に行う（Stripe の注文などを疑似決済の処理で PROCESSING にしない）
  const provider = providerOrThrow();
  if (checkout.provider === "stripe" || provider.id !== checkout.provider) throw new CheckoutError("provider_changed", "決済方法が変更されました。占いの選択からやり直してください。", 409);

  // CREATED/FAILED → PROCESSING を原子的に遷移（連打・同時リクエストによる二重課金防止）
  const attempt = await fsdb().runTransaction(async (tx) => {
    const snap = await tx.get(checkoutRef(checkout.id));
    const d = snap.data();
    if (!d || !["CREATED", "FAILED"].includes(d.status) || mustDate(d.expiresAt) <= new Date() || Number(d.attemptCount) >= 5) return null;
    const next = Number(d.attemptCount) + 1;
    tx.update(checkoutRef(checkout.id), { status: "PROCESSING", attemptCount: next, processingStartedAt: new Date(), failureCode: null, updatedAt: FieldValue.serverTimestamp() });
    return next;
  });

  if (attempt === null) {
    const cur = (await checkoutRef(checkout.id).get()).get("status");
    if (cur === "PROCESSING") return { status: "processing" };
    if (cur === "SUCCEEDED") return { status: "succeeded" };
    if (checkout.expiresAt <= new Date()) throw new CheckoutError("expired", "お支払いの有効期限が切れました。お手数ですが占いの選択からやり直してください。", 410);
    throw new CheckoutError("too_many_attempts", "お支払いの試行回数が上限に達しました。占いの選択からやり直してください。", 429);
  }

  const input = {
    amount: checkout.amount,
    currency: CURRENCY,
    cardToken,
    description: `${siteConfig.name} ${FORTUNE_CATALOG[checkout.fortuneType].label}`,
    metadata: { checkoutId: checkout.id, storeId: checkout.storeId, fortuneType: checkout.fortuneType },
    idempotencyKey: `${checkout.id}-${attempt}`,
  };
  let result = await provider.createCharge(input);
  if (!result.ok && result.ambiguous) result = await provider.createCharge(input); // 同じ冪等キーで再送

  if (!result.ok && result.ambiguous) {
    // 課金されたか不明 → FAILED にせず保留（別キーでの再課金を防ぐ）
    await updateIf(checkout.id, (d) => d.status === "PROCESSING", { failureCode: result.code.slice(0, 100) });
    return { status: "processing" };
  }
  if (!result.ok) {
    await updateIf(checkout.id, (d) => d.status === "PROCESSING", { status: "FAILED", failureCode: result.code.slice(0, 100) });
    return { status: "failed", message: result.userMessage };
  }
  await updateIf(checkout.id, (d) => !d.providerPaymentId, { providerPaymentId: result.charge.id, providerPaymentKey: transactionDocId(provider.id, result.charge.id) });

  if (provider.id === "mock") {
    const outcome = await confirmCharge("mock", result.charge.id);
    if (outcome.status === "confirmed" || outcome.status === "duplicate") return { status: "succeeded" };
  }
  return { status: "processing" };
}

const RECONCILE_AFTER_MS = 5_000;
const STALE_UNKNOWN_CHARGE_MS = 15 * 60 * 1000;

export async function getCheckoutStatus(token: string | null): Promise<CheckoutStatusResult> {
  const found = await getCheckoutByToken(token);
  if (!found) return { status: "expired" };
  const { checkout } = found;
  if (checkout.provider === "stripe") {
    const { stripeCheckoutStatus } = await import("@/lib/payments/stripe-confirm");
    return stripeCheckoutStatus(checkout);
  }
  switch (checkout.status) {
    case "SUCCEEDED":
      return { status: "succeeded" };
    case "FAILED":
      return { status: "failed", failureCode: checkout.failureCode };
    case "EXPIRED":
      return { status: "expired" };
    case "REFUNDED":
      // 返金済み・チャージバック（Stripe の注文だけ。ここに来るのは Stripe 以外の注文なので、通常は起きない）
      return { status: "refunded", refundReason: checkout.refundReason };
    case "CREATED":
      return { status: checkout.expiresAt > new Date() ? "created" : "expired" };
    case "PROCESSING": {
      const started = checkout.processingStartedAt?.getTime() ?? 0;
      if (!checkout.providerPaymentId && Date.now() - started > STALE_UNKNOWN_CHARGE_MS) {
        const failed = await updateIf(checkout.id, (d) => d.status === "PROCESSING" && !d.providerPaymentId, { status: "FAILED", failureCode: "stale_processing" });
        if (failed) return { status: "failed", failureCode: "stale_processing" };
      }
      if (checkout.providerPaymentId && isProviderId(checkout.provider) && Date.now() - started > RECONCILE_AFTER_MS) {
        try {
          const outcome = await confirmCharge(checkout.provider, checkout.providerPaymentId);
          if (outcome.status === "confirmed" || outcome.status === "duplicate") return { status: "succeeded" };
          if (outcome.status === "not_paid" && (await markChargeFailed(checkout.provider, checkout.providerPaymentId))) return { status: "failed", failureCode: "charge_failed" };
        } catch (e) {
          console.error("[checkout] reconcile failed", { checkoutId: checkout.id, error: (e as Error).message });
        }
      }
      return { status: "processing" };
    }
  }
}

// ---------- 決済確定（Webhook・照合から呼ばれる） ----------

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * 決済成功を確定し、売上（transactions）と占い権利（fortuneSessions）を発行する。
 * - chargeId 以外は信用せず、決済代行APIから Charge を取り直して検証
 * - transactions のドキュメントIDを「決済会社_決済ID」にし、トランザクション内で存在確認 → 二重計上しない
 */
export async function confirmCharge(providerId: ProviderId, chargeId: string): Promise<ConfirmOutcome> {
  const charge = await getProvider(providerId).retrieveCharge(chargeId);
  if (!charge) return { status: "rejected", reason: "charge_not_found" };
  if (!charge.paid || !charge.captured || charge.refunded) return { status: "not_paid" };
  if (charge.currency !== CURRENCY) return { status: "rejected", reason: "currency_mismatch" };
  const checkoutId = charge.metadata.checkoutId ?? "";
  if (!UUID_RE.test(checkoutId)) return { status: "rejected", reason: "missing_checkout" };

  const txRef = transactionRef(providerId, charge.id);
  try {
    return await fsdb().runTransaction(async (tx) => {
      // 読み込み（Firestore のトランザクションは読み→書きの順）
      const [coSnap, existing] = await Promise.all([tx.get(checkoutRef(checkoutId)), tx.get(txRef)]);
      if (existing.exists) return { status: "duplicate", transactionId: txRef.id } as const;
      if (!coSnap.exists) return { status: "rejected", reason: "unknown_checkout" } as const;
      const co = toCheckout(coSnap.id, coSnap.data()!);
      if (co.provider !== providerId) return { status: "rejected", reason: "provider_mismatch" } as const;
      if (co.providerPaymentId && co.providerPaymentId !== charge.id) {
        console.error("[payment] charge/checkout mismatch", { checkoutId, chargeId: charge.id });
        return { status: "rejected", reason: "charge_mismatch" } as const;
      }
      if (co.status === "SUCCEEDED") return { status: "duplicate", transactionId: null } as const; // 1注文につき1売上
      if (charge.amount !== co.amount) return { status: "rejected", reason: "amount_mismatch" } as const;
      if (charge.metadata.storeId !== co.storeId) return { status: "rejected", reason: "store_mismatch" } as const;
      const stRef = fsdb().collection(C.stores).doc(co.storeId);
      const st = await tx.get(stRef);
      if (!st.exists) return { status: "rejected", reason: "store_not_found" } as const;

      // 店舗の取り分は全店舗一律（店舗のデータの率は使わない）。決済時点の取り分を保存する
      const shareBps = STORE_SHARE_BPS;
      const { storeShare, operatorShare } = splitRevenue(co.amount, shareBps);
      const paymentFee = calcFee(co.amount, charge.feeRateBps ?? defaultFeeRateBps());
      const paidAt = charge.createdAt;

      tx.create(txRef, {
        checkoutId: co.id,
        paymentProvider: providerId,
        providerPaymentId: charge.id,
        storeId: co.storeId,
        fortuneType: co.fortuneType,
        amount: co.amount,
        storeShare,
        operatorShare,
        paymentFee,
        storeShareBps: shareBps,
        paymentStatus: "SUCCEEDED",
        fortuneStatus: "PENDING",
        livemode: charge.livemode,
        paidAt,
        refundedAt: null,
        ...salesKeys(co.storeId, providerId, "SUCCEEDED", paidAt, charge.livemode),
        ...feeKeys(co.storeId, providerId, paidAt, charge.livemode),
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      });
      tx.create(fsdb().collection(C.fortuneSessions).doc(txRef.id), {
        transactionId: txRef.id,
        storeId: co.storeId,
        fortuneType: co.fortuneType,
        tokenHash: co.accessTokenHash,
        status: "PAID",
        expiresAt: new Date(Date.now() + FORTUNE_SESSION_TTL_MS),
        usedAt: null,
        createdAt: FieldValue.serverTimestamp(),
      });
      tx.update(checkoutRef(co.id), { status: "SUCCEEDED", providerPaymentId: charge.id, providerPaymentKey: txRef.id, failureCode: null, updatedAt: FieldValue.serverTimestamp() });
      // 最終利用日はテスト決済では更新しない（売上に数える決済だけ）
      const lastUsed = toDate(st.get("lastUsedAt"));
      if (isSalesPayment(providerId, charge.livemode) && (!lastUsed || lastUsed < paidAt)) tx.update(stRef, { lastUsedAt: paidAt });
      return { status: "confirmed", transactionId: txRef.id } as const;
    });
  } catch (e) {
    // 同時に別の処理が先に作成した場合
    if (isAlreadyExists(e)) return { status: "duplicate", transactionId: txRef.id };
    throw e;
  }
}

export async function markChargeFailed(providerId: ProviderId, chargeId: string): Promise<boolean> {
  const charge = await getProvider(providerId).retrieveCharge(chargeId);
  if (!charge || charge.paid) return false;
  const q = await fsdb().collection(C.checkouts).where("providerPaymentKey", "==", transactionDocId(providerId, chargeId)).limit(1).get();
  if (q.empty) return false;
  return updateIf(q.docs[0].id, (d) => d.status === "PROCESSING" && d.provider === providerId, { status: "FAILED", failureCode: "charge_failed" });
}

/** 返金: 売上集計から外し（countable=false）、未使用の占い権利を失効させる */
export async function markRefunded(providerId: ProviderId, chargeId: string): Promise<boolean> {
  const charge = await getProvider(providerId).retrieveCharge(chargeId);
  if (!charge || !charge.refunded) return false;
  const txRef = transactionRef(providerId, chargeId);
  const sessionRef = fsdb().collection(C.fortuneSessions).doc(txRef.id);
  let review: PaymentReviewInput | null = null;
  const done = await fsdb().runTransaction(async (tx) => {
    review = null;
    const [t, s] = await Promise.all([tx.get(txRef), tx.get(sessionRef)]);
    if (!t.exists || t.get("paymentStatus") !== "SUCCEEDED") return false;
    // 書き込みの前にすべて読む（以前の仕組みで確定した精算の月の決済要確認の記録も、返金の反映と同じトランザクションで記録する）
    const legacyRef = paymentReviewRef("legacy_settlement_change", txRef.id);
    const [st, legacySnap] = await Promise.all([tx.get(settlementRefForTx(t.data()!)), tx.get(legacyRef)]);
    const patch = {
      paymentStatus: "REFUNDED",
      refundedAt: new Date(),
      ...salesKeys(String(t.get("storeId")), providerId, "REFUNDED", mustDate(t.get("paidAt")), t.get("livemode")),
    };
    // 振込済み（確定済み）の月の取引なら、取り分の差額を調整として記録する
    const adj = reconcileTransactionInTx(tx, txRef, t.data()!, patch, "refund", chargeId, { id: st.id, data: st.data() });
    tx.update(txRef, { ...patch, ...adj.fields, updatedAt: FieldValue.serverTimestamp() });
    if (adj.review && paymentReviewRef(adj.review.kind, adj.review.objectId).path === legacyRef.path) recordPaymentReviewInTx(tx, legacySnap, adj.review);
    else review = adj.review ?? null; // 想定外の記録だけ、今までどおりトランザクションの後で記録する
    if (s.exists && s.get("status") === "PAID") tx.update(sessionRef, { status: "EXPIRED" });
    return true;
  });
  if (review) await recordPaymentReview(review);
  return done;
}

// ---------- Webhook の冪等性 ----------

/**
 * 通知の処理を始める（処理済みなら false。処理済みかどうかは今までどおり processedAt だけで判定する）。
 * 記録が無ければ RECEIVED・回数1で作る。あれば（再送・同時・途中で止まった通知の処理し直し）RECEIVED にして回数を増やす。
 * 処理済みの記録には何も書かない。meta（通知の対象の ID・モード・作成日時）は、記録に無い項目だけ書く（以前の記録にも足す）。
 * 記録に失敗したら例外（今までどおり。呼び出し側は処理を始めない＝Webhook は 500 になり、Stripe が再送する）。
 */
export async function beginWebhookEvent(provider: ProviderId | "stripe", eventId: string, type: string, meta?: StripeEventMeta): Promise<boolean> {
  const ref = fsdb().collection(C.webhookEvents).doc(safeId(provider, eventId));
  return fsdb().runTransaction(async (tx) => {
    const cur = await tx.get(ref);
    if (cur.exists && cur.get("processedAt")) return false;
    const now = new Date();
    const metaFields = meta ? { objectId: meta.objectId, chargeId: meta.chargeId, livemode: meta.livemode, eventCreatedAt: meta.eventCreatedAt } : {};
    if (!cur.exists) {
      tx.create(ref, { provider, eventId, type, processedAt: null, createdAt: FieldValue.serverTimestamp(), state: "RECEIVED", attempts: 1, lastAttemptAt: now, lastError: null, replayLeaseUntil: null, ...metaFields });
      return true;
    }
    const missing = Object.fromEntries(Object.entries(metaFields).filter(([k]) => cur.get(k) === undefined));
    tx.update(ref, { ...missing, state: "RECEIVED", attempts: FieldValue.increment(1), lastAttemptAt: now, ...(cur.get("replayLeaseUntil") === undefined ? { replayLeaseUntil: null } : {}) });
    return true;
  });
}

/** 処理の完了。processedAt と state=PROCESSED を同じ書き込みで記録する（両者が食い違わない） */
export async function finishWebhookEvent(provider: ProviderId | "stripe", eventId: string): Promise<void> {
  await fsdb().collection(C.webhookEvents).doc(safeId(provider, eventId)).update({ processedAt: FieldValue.serverTimestamp(), state: "PROCESSED" });
}

/**
 * 処理の失敗を記録する（RETRYABLE。最後のエラーの名前だけ）。処理済み・記録が無いときは何もしない。
 * 応答（500）を変えないよう、記録に失敗しても例外にしない（その場合は RECEIVED のまま残り、lastAttemptAt が古くなるので
 * 「途中で止まった通知」として見つけられる）。FAILED_PERMANENT は、安全に判定できる場合が無いので今は使わない。
 */
export async function recordWebhookEventFailure(provider: ProviderId | "stripe", eventId: string, errorName: string): Promise<boolean> {
  const ref = fsdb().collection(C.webhookEvents).doc(safeId(provider, eventId));
  try {
    return await fsdb().runTransaction(async (tx) => {
      const cur = await tx.get(ref);
      if (!cur.exists || cur.get("processedAt")) return false;
      tx.update(ref, { state: "RETRYABLE", lastError: /^[\w.\-]{1,60}$/.test(errorName) ? errorName : "Error" });
      return true;
    });
  } catch (e) {
    console.error("[webhook-event] recording the failure state failed", { provider, error: (e as Error)?.name });
    return false;
  }
}

export type UnfinishedWebhookEvent = {
  id: string;
  provider: string;
  eventId: string;
  type: string;
  state: WebhookEventState;
  attempts: number | null;
  createdAt: Date | null;
  lastAttemptAt: Date | null;
  lastError: string | null;
  objectId: string | null;
  chargeId: string | null;
  livemode: boolean | null;
};

export type UnfinishedWebhookEventsPage = {
  /** このページのうち、最後に処理を始めてから staleMs 以上たったもの（途中で止まった・失敗した通知） */
  records: UnfinishedWebhookEvent[];
  /** 次のページの位置（hasMore が false なら null）。このページのすべての記録（records に入らなかったものも含む）の後から読む */
  nextCursor: string | null;
  /** この位置より後に、処理が終わっていない記録が実際に残っているか（ページの件数＋1件を読んで確かめる） */
  hasMore: boolean;
  /** このページで読んだ、処理が終わっていない記録の件数（records の絞り込みの前） */
  scanned: number;
};

export const UNFINISHED_WEBHOOK_PAGE_MAX = 100;

/**
 * 処理が終わっていない Stripe の通知（provider == "stripe" かつ processedAt == null）を、作成の時刻・文書の ID の順に
 * 1ページずつ読む（読み取りだけ。将来の手動の復旧・点検・定期照合用。今は自動で再実行しない）。
 * 必要な複合インデックス：provider・processedAt・createdAt・__name__（firestore.indexes.json）。
 *
 *  - 並び：createdAt の昇順、同じ時刻なら文書の ID の昇順（一意で安定）。続きは最後に読んだ記録の (createdAt, ID) の後から
 *    （startAfter）。位置は値で決まるので、ページの間に記録が処理済みになって検索から外れても、他の記録を飛ばさない
 *  - 一定の時間を過ぎたかの絞り込みはページを読んだ後に行い、続きの位置は絞り込みの前の最後の記録で決める
 *    （止まった通知が新しい処理中の通知の後ろにあっても、全ページを読めば必ず含まれる）
 *  - ページの間に届いた新しい通知は作成の時刻が後なので、後のページに入る（読み終わるまでに届いた分は含まれ得る）
 *  - 次の記録は対象外：processedAt の項目が無い記録（null と等しい、の条件に一致しない）、createdAt が無い記録
 *    （並びの項目が無い記録は検索から外れる）。このアプリは作成時に必ず両方を書くので、通常はできない
 *  - 形の正しくない続きの位置は例外（推測で位置を決めない。呼び出し側は最初から読み直す）
 */
export async function listUnfinishedWebhookEvents(opts: { staleMs: number; now?: Date; cursor?: string | null; pageSize?: number }): Promise<UnfinishedWebhookEventsPage> {
  const now = opts.now ?? new Date();
  const pageSize = Math.max(1, Math.min(UNFINISHED_WEBHOOK_PAGE_MAX, Math.floor(opts.pageSize ?? UNFINISHED_WEBHOOK_PAGE_MAX)));
  let q = fsdb().collection(C.webhookEvents).where("provider", "==", "stripe").where("processedAt", "==", null).orderBy("createdAt", "asc").orderBy(FieldPath.documentId(), "asc");
  if (opts.cursor) {
    const c = decodeWebhookEventCursor(opts.cursor);
    if (!c) throw new Error("invalid webhook event cursor");
    q = q.startAfter(new Timestamp(c.seconds, c.nanoseconds), c.id);
  }
  const snap = await q.limit(pageSize + 1).get();
  const hasMore = snap.docs.length > pageSize;
  const page = snap.docs.slice(0, pageSize);
  const last = page.at(-1);
  const lastCreated = last?.get("createdAt");
  const nextCursor = hasMore && last && lastCreated instanceof Timestamp ? encodeWebhookEventCursor({ seconds: lastCreated.seconds, nanoseconds: lastCreated.nanoseconds, id: last.id }) : null;
  const records = page
    .map((d) => ({ d, lastAttemptAt: toDate(d.get("lastAttemptAt")), createdAt: toDate(d.get("createdAt")) }))
    .filter(({ d, lastAttemptAt, createdAt }) => isStaleUnfinished({ state: d.get("state"), processedAt: d.get("processedAt"), lastAttemptAt, createdAt }, now, opts.staleMs))
    .map(({ d, lastAttemptAt, createdAt }) => ({
      id: d.id,
      provider: String(d.get("provider")),
      eventId: String(d.get("eventId")),
      type: String(d.get("type")),
      state: webhookEventStateOf({ state: d.get("state"), processedAt: d.get("processedAt") }),
      attempts: typeof d.get("attempts") === "number" ? d.get("attempts") : null,
      createdAt,
      lastAttemptAt,
      lastError: d.get("lastError") ?? null,
      objectId: d.get("objectId") ?? null,
      chargeId: d.get("chargeId") ?? null,
      livemode: typeof d.get("livemode") === "boolean" ? d.get("livemode") : null,
    }));
  return { records, nextCursor, hasMore, scanned: page.length };
}
