import "server-only";
import { FieldValue } from "firebase-admin/firestore";
import { PRICE_JPY, FORTUNE_SESSION_TTL_MS } from "@/config/pricing";
import { splitRevenue, calcFee } from "@/lib/money";
import { C, fsdb, mustDate, safeId } from "@/lib/firestore/admin";
import { salesKeys } from "@/lib/firestore/shared";
import { retrieveStripeCheckoutSession } from "./stripe-checkout";

/**
 * Stripe Checkout sandbox の確定処理。
 * Stripe API の実データだけを信用し、注文・店舗・金額・通貨を照合。
 * Firestore transaction で売上と占い権利を同時作成する。
 * Webhook への接続は別段階で行う。
 */
export async function confirmStripeTestCheckout(sessionId: string) {
  if (process.env.VERCEL_ENV !== "preview") throw new Error("Preview only");
  const session = await retrieveStripeCheckoutSession(sessionId);
  if (session.livemode || session.status !== "complete" || session.payment_status !== "paid") {
    return { status: "not_paid" } as const;
  }
  if (session.currency !== "jpy" || session.amount_total !== PRICE_JPY) {
    return { status: "rejected", reason: "invalid_amount" } as const;
  }
  const checkoutId = session.metadata?.checkoutId ?? "";
  const storeId = session.metadata?.storeId ?? "";
  const fortuneType = session.metadata?.fortuneType ?? "";
  if (!/^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(checkoutId) || !storeId) {
    return { status: "rejected", reason: "invalid_metadata" } as const;
  }
  const txRef = fsdb().collection(C.transactions).doc(safeId("stripe", session.id));
  const coRef = fsdb().collection(C.checkouts).doc(checkoutId);
  const storeRef = fsdb().collection(C.stores).doc(storeId);
  const entitlementRef = fsdb().collection(C.fortuneSessions).doc(txRef.id);
  return fsdb().runTransaction(async (tx) => {
    const [coSnap, existing, stSnap] = await Promise.all([
      tx.get(coRef), tx.get(txRef), tx.get(storeRef),
    ]);
    if (existing.exists) return { status: "duplicate", transactionId: txRef.id } as const;
    if (!coSnap.exists || !stSnap.exists) return { status: "rejected", reason: "missing_record" } as const;
    const co = coSnap.data()!;
    if (co.provider !== "stripe" || co.storeId !== storeId || co.fortuneType !== fortuneType ||
        Number(co.amount) !== session.amount_total ||
        (co.providerPaymentId && co.providerPaymentId !== session.id) ||
        co.status === "SUCCEEDED") {
      return { status: "rejected", reason: "checkout_mismatch" } as const;
    }
    const shareBps = Number(stSnap.get("storeShareBps"));
    if (!Number.isInteger(shareBps) || shareBps < 0 || shareBps > 10000) {
      return { status: "rejected", reason: "invalid_share" } as const;
    }
    const { storeShare, operatorShare } = splitRevenue(Number(co.amount), shareBps);
    const paidAt = new Date();
    tx.create(txRef, {
      checkoutId, paymentProvider: "stripe", providerPaymentId: session.id,
      storeId, fortuneType, amount: Number(co.amount), storeShare, operatorShare,
      paymentFee: calcFee(Number(co.amount), 0), storeShareBps: shareBps,
      paymentStatus: "SUCCEEDED", fortuneStatus: "PENDING", livemode: false,
      paidAt, refundedAt: null,
      ...salesKeys(storeId, "stripe", "SUCCEEDED", paidAt, false),
      createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp(),
    });
    tx.create(entitlementRef, {
      transactionId: txRef.id, storeId, fortuneType,
      tokenHash: String(co.accessTokenHash), status: "PAID",
      expiresAt: new Date(Date.now() + FORTUNE_SESSION_TTL_MS),
      usedAt: null, createdAt: FieldValue.serverTimestamp(),
    });
    tx.update(coRef, {
      status: "SUCCEEDED", providerPaymentId: session.id,
      providerPaymentKey: txRef.id, failureCode: null,
      updatedAt: FieldValue.serverTimestamp(),
    });
    return { status: "confirmed", transactionId: txRef.id } as const;
  });
}
