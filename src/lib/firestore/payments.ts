import "server-only";
import { randomUUID } from "node:crypto";
import { FieldValue, type DocumentData } from "firebase-admin/firestore";
import type { checkouts, FortuneTypeValue } from "@/lib/db/schema";
import { CHECKOUT_TTL_MS, CURRENCY, defaultFeeRateBps, FORTUNE_SESSION_TTL_MS, PRICE_JPY } from "@/config/pricing";
import { siteConfig } from "@/config/site";
import { calcFee, splitRevenue } from "@/lib/money";
import { getProvider, isProviderId } from "@/lib/payments";
import type { ProviderId } from "@/lib/payments/types";
import type { ConfirmOutcome } from "@/lib/payments/confirm";
import type { CheckoutStatus, PayResult } from "@/lib/services/checkout";
import { FORTUNE_CATALOG } from "@/lib/fortune/catalog";
import { randomToken, sha256Hex } from "@/lib/security/crypto";
import { CheckoutError, PAID_FLOW_BLOCKED_STORE_CODES, providerOrThrow } from "@/lib/errors";
import { C, fsdb, mustDate, safeId, toDate } from "./admin";
import { isAlreadyExists, salesKeys } from "./shared";
import { findStoreByCode } from "./stores";

/**
 * 決済（Firestore 版）。ロジックは PostgreSQL 版（services/checkout.ts・payments/confirm.ts）と同じ。
 *
 *  checkouts/{checkoutId}               … 支払い前の注文
 *  transactions/{決済会社_決済ID}         … 決済履歴（売上集計の元データ）。IDが決済IDなので二重計上できない
 *  fortuneSessions/{transactionId}       … 占い権利（1決済につき1件）
 *  webhookEvents/{決済会社_イベントID}     … Webhook の処理済み記録
 */

type Checkout = typeof checkouts.$inferSelect;

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
    expiresAt: mustDate(d.expiresAt),
    processingStartedAt: toDate(d.processingStartedAt),
    createdAt: mustDate(d.createdAt),
    updatedAt: mustDate(d.updatedAt),
  };
}

// ---------- 注文 ----------

export async function createCheckout(storeCode: string | null, fortuneType: FortuneTypeValue) {
  if (!storeCode) throw new CheckoutError("no_store", "店舗のQRコードを読み込んでからご利用ください。");
  const store = await findStoreByCode(storeCode);
  if (!store) throw new CheckoutError("store_not_found", "店舗情報が見つかりません。お店のQRコードをもう一度読み込んでください。", 404);
  if (store.status !== "ACTIVE" || PAID_FLOW_BLOCKED_STORE_CODES.has(store.storeCode)) {
    throw new CheckoutError("store_suspended", "こちらの店舗では現在ご利用いただけません。", 403);
  }
  const provider = providerOrThrow();
  const token = randomToken(32);
  const id = randomUUID();
  await checkoutRef(id).set({
    storeId: store.id,
    fortuneType,
    amount: PRICE_JPY, // 金額はサーバーの固定価格のみ
    status: "CREATED",
    provider: provider.id,
    providerPaymentId: null,
    providerPaymentKey: null,
    accessTokenHash: sha256Hex(token),
    attemptCount: 0,
    failureCode: null,
    expiresAt: new Date(Date.now() + CHECKOUT_TTL_MS),
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

  const provider = providerOrThrow();
  if (provider.id !== checkout.provider) throw new CheckoutError("provider_changed", "決済方法が変更されました。占いの選択からやり直してください。", 409);
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

export async function getCheckoutStatus(token: string | null): Promise<{ status: CheckoutStatus; failureCode?: string | null }> {
  const found = await getCheckoutByToken(token);
  if (!found) return { status: "expired" };
  const { checkout } = found;
  switch (checkout.status) {
    case "SUCCEEDED":
      return { status: "succeeded" };
    case "FAILED":
      return { status: "failed", failureCode: checkout.failureCode };
    case "EXPIRED":
      return { status: "expired" };
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

      const shareBps = Number(st.get("storeShareBps"));
      // 決済時点の取り分を保存（後で取り分率を変えても過去の取引は変わらない）
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
        ...salesKeys(co.storeId, providerId, "SUCCEEDED", paidAt),
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
      const lastUsed = toDate(st.get("lastUsedAt"));
      if (!lastUsed || lastUsed < paidAt) tx.update(stRef, { lastUsedAt: paidAt });
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
  return fsdb().runTransaction(async (tx) => {
    const [t, s] = await Promise.all([tx.get(txRef), tx.get(sessionRef)]);
    if (!t.exists || t.get("paymentStatus") !== "SUCCEEDED") return false;
    tx.update(txRef, {
      paymentStatus: "REFUNDED",
      refundedAt: new Date(),
      ...salesKeys(String(t.get("storeId")), providerId, "REFUNDED", mustDate(t.get("paidAt"))),
      updatedAt: FieldValue.serverTimestamp(),
    });
    if (s.exists && s.get("status") === "PAID") tx.update(sessionRef, { status: "EXPIRED" });
    return true;
  });
}

// ---------- Webhook の冪等性 ----------

export async function beginWebhookEvent(provider: ProviderId, eventId: string, type: string): Promise<boolean> {
  const ref = fsdb().collection(C.webhookEvents).doc(safeId(provider, eventId));
  try {
    await ref.create({ provider, eventId, type, processedAt: null, createdAt: FieldValue.serverTimestamp() });
  } catch (e) {
    if (!isAlreadyExists(e)) throw e;
  }
  const snap = await ref.get();
  return !snap.get("processedAt");
}

export async function finishWebhookEvent(provider: ProviderId, eventId: string): Promise<void> {
  await fsdb().collection(C.webhookEvents).doc(safeId(provider, eventId)).update({ processedAt: FieldValue.serverTimestamp() });
}
