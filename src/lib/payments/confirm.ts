import "server-only";
import { isFirestore } from "@/lib/data-provider";
import * as fsPay from "@/lib/firestore/payments";
import { and, eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { checkouts, fortuneSessions, stores, transactions, webhookEvents } from "@/lib/db/schema";
import { CURRENCY, defaultFeeRateBps, FORTUNE_SESSION_TTL_MS } from "@/config/pricing";
import { calcFee, splitRevenue } from "@/lib/money";
import { getProvider } from "./index";
import type { ProviderId } from "./types";

export type ConfirmOutcome =
  | { status: "confirmed"; transactionId: string }
  | { status: "duplicate"; transactionId: string | null }
  | { status: "not_paid" }
  | { status: "rejected"; reason: string };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * 決済成功を確定し、売上(Transaction)と占い権利(FortuneSession)を発行する。
 *
 * - 引数の chargeId 以外は一切信用せず、必ず決済代行APIから Charge を取得し直して検証する
 * - transactions の UNIQUE(payment_provider, provider_payment_id) / UNIQUE(checkout_id) と
 *   ON CONFLICT DO NOTHING により、Webhook の重複・同時到着でも二重計上しない
 */
export async function confirmCharge(providerId: ProviderId, chargeId: string): Promise<ConfirmOutcome> {
  if (isFirestore()) return fsPay.confirmCharge(providerId, chargeId);
  const provider = getProvider(providerId);
  const charge = await provider.retrieveCharge(chargeId);
  if (!charge) return { status: "rejected", reason: "charge_not_found" };
  if (!charge.paid || !charge.captured || charge.refunded) return { status: "not_paid" };
  if (charge.currency !== CURRENCY) return { status: "rejected", reason: "currency_mismatch" };

  const checkoutId = charge.metadata.checkoutId ?? "";
  if (!UUID_RE.test(checkoutId)) return { status: "rejected", reason: "missing_checkout" };

  return db().transaction(async (tx) => {
    // checkout を行ロックして状態遷移を直列化
    const [checkout] = await tx
      .select()
      .from(checkouts)
      .where(eq(checkouts.id, checkoutId))
      .for("update")
      .limit(1);
    if (!checkout) return { status: "rejected", reason: "unknown_checkout" } as const;
    if (checkout.provider !== providerId) return { status: "rejected", reason: "provider_mismatch" } as const;
    if (checkout.providerPaymentId && checkout.providerPaymentId !== charge.id) {
      // 同一checkoutに別のChargeがある = 想定外（要返金対応）。計上はしない
      console.error("[payment] charge/checkout mismatch", { checkoutId, chargeId: charge.id });
      return { status: "rejected", reason: "charge_mismatch" } as const;
    }
    // 金額・店舗はDB上の checkout を正とし、Charge と一致することを確認
    if (charge.amount !== checkout.amount) return { status: "rejected", reason: "amount_mismatch" } as const;
    if (charge.metadata.storeId !== checkout.storeId) return { status: "rejected", reason: "store_mismatch" } as const;

    const [store] = await tx.select({ shareBps: stores.storeShareBps }).from(stores).where(eq(stores.id, checkout.storeId));
    if (!store) return { status: "rejected", reason: "store_not_found" } as const;

    const { storeShare, operatorShare } = splitRevenue(checkout.amount, store.shareBps);
    const paymentFee = calcFee(checkout.amount, charge.feeRateBps ?? defaultFeeRateBps());

    const inserted = await tx
      .insert(transactions)
      .values({
        checkoutId: checkout.id,
        paymentProvider: providerId,
        providerPaymentId: charge.id,
        storeId: checkout.storeId,
        fortuneType: checkout.fortuneType,
        amount: checkout.amount,
        storeShare,
        operatorShare,
        paymentFee,
        storeShareBps: store.shareBps,
        livemode: charge.livemode,
        paidAt: charge.createdAt,
      })
      .onConflictDoNothing()
      .returning({ id: transactions.id });

    if (inserted.length === 0) {
      const [existing] = await tx
        .select({ id: transactions.id })
        .from(transactions)
        .where(and(eq(transactions.paymentProvider, providerId), eq(transactions.providerPaymentId, charge.id)));
      return { status: "duplicate", transactionId: existing?.id ?? null } as const;
    }

    const transactionId = inserted[0].id;
    await tx.insert(fortuneSessions).values({
      transactionId,
      storeId: checkout.storeId,
      fortuneType: checkout.fortuneType,
      // checkout 作成時にブラウザへ渡した HttpOnly Cookie のトークン（ハッシュ）を権利に紐づける
      tokenHash: checkout.accessTokenHash,
      status: "PAID",
      expiresAt: new Date(Date.now() + FORTUNE_SESSION_TTL_MS),
    });
    await tx
      .update(checkouts)
      .set({ status: "SUCCEEDED", providerPaymentId: charge.id, failureCode: null })
      .where(eq(checkouts.id, checkout.id));

    return { status: "confirmed", transactionId } as const;
  });
}

/**
 * 決済失敗: Charge を取得し直して未決済を確認できた場合のみ、対応する処理中の checkout を FAILED にして再試行可能にする
 */
export async function markChargeFailed(providerId: ProviderId, chargeId: string): Promise<boolean> {
  if (isFirestore()) return fsPay.markChargeFailed(providerId, chargeId);
  const charge = await getProvider(providerId).retrieveCharge(chargeId);
  if (!charge || charge.paid) return false;
  const updated = await db()
    .update(checkouts)
    .set({ status: "FAILED", failureCode: "charge_failed" })
    .where(and(eq(checkouts.provider, providerId), eq(checkouts.providerPaymentId, chargeId), eq(checkouts.status, "PROCESSING")))
    .returning({ id: checkouts.id });
  return updated.length > 0;
}

/** 返金: 売上集計から除外し、未使用の占い権利を失効させる */
export async function markRefunded(providerId: ProviderId, chargeId: string): Promise<boolean> {
  if (isFirestore()) return fsPay.markRefunded(providerId, chargeId);
  const charge = await getProvider(providerId).retrieveCharge(chargeId);
  if (!charge || !charge.refunded) return false;
  return db().transaction(async (tx) => {
    const updated = await tx
      .update(transactions)
      .set({ paymentStatus: "REFUNDED", refundedAt: new Date() })
      .where(
        and(
          eq(transactions.paymentProvider, providerId),
          eq(transactions.providerPaymentId, chargeId),
          eq(transactions.paymentStatus, "SUCCEEDED"),
        ),
      )
      .returning({ id: transactions.id });
    if (updated[0]) {
      await tx
        .update(fortuneSessions)
        .set({ status: "EXPIRED" })
        .where(and(eq(fortuneSessions.transactionId, updated[0].id), eq(fortuneSessions.status, "PAID")));
    }
    return updated.length > 0;
  });
}

/**
 * Webhookイベント単位の冪等性。処理済みなら false を返す。
 */
export async function beginWebhookEvent(provider: ProviderId, eventId: string, type: string): Promise<boolean> {
  if (isFirestore()) return fsPay.beginWebhookEvent(provider, eventId, type);
  await db().insert(webhookEvents).values({ provider, eventId, type }).onConflictDoNothing();
  const [row] = await db()
    .select({ processedAt: webhookEvents.processedAt })
    .from(webhookEvents)
    .where(and(eq(webhookEvents.provider, provider), eq(webhookEvents.eventId, eventId)));
  return !row?.processedAt;
}

export async function finishWebhookEvent(provider: ProviderId, eventId: string): Promise<void> {
  if (isFirestore()) return fsPay.finishWebhookEvent(provider, eventId);
  await db()
    .update(webhookEvents)
    .set({ processedAt: sql`now()` })
    .where(and(eq(webhookEvents.provider, provider), eq(webhookEvents.eventId, eventId)));
}
