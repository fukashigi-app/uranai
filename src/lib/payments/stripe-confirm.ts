import "server-only";
import { FieldValue, type DocumentData } from "firebase-admin/firestore";
import { defaultFeeRateBps, FORTUNE_SESSION_TTL_MS, PRICE_JPY } from "@/config/pricing";
import { calcFee, splitRevenue } from "@/lib/money";
import { C, fsdb, mustDate, safeId } from "@/lib/firestore/admin";
import { isAlreadyExists, salesKeys } from "@/lib/firestore/shared";
import { sha256Hex } from "@/lib/security/crypto";
import type { CheckoutStatus } from "@/lib/services/checkout";
import { CheckoutError } from "@/lib/errors";
import { FORTUNE_CATALOG } from "@/lib/fortune/catalog";
import { siteConfig } from "@/config/site";
import { writeAudit } from "@/lib/firestore/audit";
import {
  createStripeCheckoutSession,
  feeOf,
  isStripeTestSessionId,
  listStripeRefunds,
  retrieveStripeCharge,
  retrieveStripeSession,
  STRIPE_SESSION_TTL_MS,
  stripeSessionState,
  summarizeRefunds,
  validateStripeSession,
  type StripeRefundSummary,
} from "./stripe-checkout";

/**
 * Stripe Checkout のテスト決済の Firestore 側の処理（注文と Session の紐付け・確定・期限切れ・返金・手数料の確定）。
 *
 *  checkouts/{注文ID}                  … provider: "stripe"、providerPaymentId = Checkout Session の ID（注文ごとに1つ）
 *  transactions/stripe_{PaymentIntent} … 決済記録。IDが決済ごとに決まるので、Webhook と戻り先が同時に動いても1件だけ作られる
 *  fortuneSessions/{transactionId}     … 占い権利（同じトランザクションで1回だけ作る）
 *
 * 権利は Stripe 側で支払いが確定してから付与する（PayPay など非同期の支払いは、確定の通知か照合で確定してから）。
 * 注文を失敗にするのは、Stripe が支払いの失敗を確定したとき（非同期の支払いの失敗の通知・PaymentIntent の取り消し）と、
 * Session の期限切れだけ。requires_payment_method だけでは失敗にしない（決済画面で支払い直せるため）。
 *
 * 返金は Stripe API の返金の一覧から状態を求める（処理中・成功・一部・失敗）。処理中になった時点で未使用の権利を止め、
 * 成功で決済記録を REFUNDED にする。失敗したら refundNeedsReview=true にして、管理者が確認・権利の復旧をできるようにする。
 *
 * テスト決済（livemode=false）なので、売上・店舗の売上画面・月次精算には含めない（lib/payments/kind.ts。salesKeys の countable=false）。
 * 店舗の取り分・運営の取り分は記録する（100円 → 30円・70円）。手数料は Stripe の確定値。未確定なら推定値で feeEstimated=true にして、後で確定値に直す。
 */

export const STRIPE_PROVIDER = "stripe" as const;
export const stripeTransactionId = (paymentIntentId: string) => safeId(STRIPE_PROVIDER, paymentIntentId);

export type StripeConfirmOutcome =
  | { status: "confirmed"; transactionId: string }
  | { status: "duplicate"; transactionId: string }
  | { status: "not_paid"; reason: string }
  | { status: "rejected"; reason: string };

const checkoutRef = (id: string) => fsdb().collection(C.checkouts).doc(id);

type CheckoutLike = { id: string; provider: string; status: string; providerPaymentId: string | null; expiresAt: Date; storeId: string; fortuneType: string };

/** 注文を見つける（ブラウザの Cookie の値から）。Stripe の注文でなければ null */
async function stripeCheckoutByToken(token: string | null): Promise<{ id: string; data: DocumentData } | null> {
  if (!token) return null;
  const q = await fsdb().collection(C.checkouts).where("accessTokenHash", "==", sha256Hex(token)).limit(1).get();
  if (q.empty) return null;
  const doc = q.docs[0];
  return doc.get("provider") === STRIPE_PROVIDER ? { id: doc.id, data: doc.data() } : null;
}

/**
 * 決済画面（Stripe）へ移動するための URL を返す。
 *  - 同じ注文では同じ Session（冪等キー）。注文に Session の ID を保存してから URL を返す（紐付けてから移動する）
 *  - すでに別の Session が紐付いていたら拒否する
 */
const EXPIRED_ERROR = () => new CheckoutError("expired", "お支払いの有効期限が切れました。お手数ですが占いの選択からやり直してください。", 410);
const FAILED_ERROR = () => new CheckoutError("payment_failed", "お支払いが完了しませんでした（請求は発生していません）。お手数ですが占いの選択からやり直してください。", 410);

export type StripeStartResult = { status: "redirect"; url: string } | { status: "succeeded" } | { status: "pending"; returnUrl: string };

export async function startStripeCheckout(token: string | null, origin: string): Promise<StripeStartResult> {
  const found = await stripeCheckoutByToken(token);
  if (!found) throw new CheckoutError("not_found", "お支払い情報が見つかりません。占いの選択からやり直してください。", 404);
  const d = found.data;
  if (d.status === "SUCCEEDED") return { status: "succeeded" };
  // すでに Session に移動済みなら、期限より先に支払い状況を照合する（期限の後に PayPay の支払いが確定することもあるため）
  if (isStripeTestSessionId(d.providerPaymentId)) {
    const r = await confirmStripeCheckout(d.providerPaymentId);
    if (r.status === "confirmed" || r.status === "duplicate") return { status: "succeeded" };
    if (r.status === "rejected") throw new CheckoutError("checkout_conflict", "お支払い情報を確認できませんでした。占いの選択からやり直してください。", 409);
    // すでに閉じた注文（失敗・期限切れ）は、支払いが確定していなければ選び直しを案内する
    if (d.status === "FAILED") throw FAILED_ERROR();
    if (d.status === "EXPIRED") throw EXPIRED_ERROR();
    const state = await stripeSessionStateOf(d.providerPaymentId);
    // Stripe 側で確定待ち：新しい決済画面には移動させない（二重の支払いを防ぐ）。確認中の画面へ
    if (state === "awaiting" || state === "failed_candidate") {
      return { status: "pending", returnUrl: `/payment/return?session_id=${encodeURIComponent(d.providerPaymentId)}` };
    }
    if (state === "canceled" || state === "expired") {
      await closeStripeCheckout(d.providerPaymentId);
      throw state === "canceled" ? FAILED_ERROR() : EXPIRED_ERROR();
    }
  }
  if (d.status === "FAILED") throw FAILED_ERROR();
  if (!["CREATED", "PROCESSING"].includes(d.status) || mustDate(d.expiresAt) <= new Date()) throw EXPIRED_ERROR();
  const store = await fsdb().collection(C.stores).doc(String(d.storeId)).get();
  if (!store.exists || store.get("status") !== "ACTIVE") throw new CheckoutError("store_suspended", "こちらの店舗では現在ご利用いただけません。", 403);

  const session = await createStripeCheckoutSession({
    checkoutId: found.id,
    storeId: String(d.storeId),
    fortuneType: String(d.fortuneType),
    productName: `${siteConfig.name} ${FORTUNE_CATALOG[d.fortuneType as keyof typeof FORTUNE_CATALOG]?.label ?? "占い"}（テスト決済）`,
    origin,
    expiresAt: mustDate(d.expiresAt),
  });
  const linked = await fsdb().runTransaction(async (tx) => {
    const snap = await tx.get(checkoutRef(found.id));
    const cur = snap.data();
    if (!cur || cur.provider !== STRIPE_PROVIDER) return "missing" as const;
    if (cur.providerPaymentId && cur.providerPaymentId !== session.id) return "conflict" as const;
    if (cur.status === "SUCCEEDED") return "succeeded" as const;
    if (!["CREATED", "PROCESSING"].includes(cur.status)) return "closed" as const;
    if (!cur.providerPaymentId) {
      tx.update(checkoutRef(found.id), {
        status: "PROCESSING",
        providerPaymentId: session.id,
        attemptCount: Number(cur.attemptCount ?? 0) + 1,
        processingStartedAt: new Date(),
        failureCode: null,
        updatedAt: FieldValue.serverTimestamp(),
      });
    }
    return "linked" as const;
  });
  if (linked === "succeeded") return { status: "succeeded" };
  if (linked !== "linked") {
    console.error("[stripe] checkout link failed", { checkoutId: found.id, result: linked });
    throw new CheckoutError("checkout_conflict", "お支払い情報を確認できませんでした。占いの選択からやり直してください。", 409);
  }
  return { status: "redirect", url: session.url };
}

/**
 * 決済を確定する（戻り先・Webhook・状態の確認から呼ばれる。何度呼んでも1回だけ記録する）。
 * Stripe API から Session・PaymentIntent・Charge を取り直し、注文と照合してから、
 * 決済記録・占い権利の作成と注文の更新を1つのトランザクションで行う。
 */
export async function confirmStripeCheckout(sessionId: string): Promise<StripeConfirmOutcome> {
  if (!isStripeTestSessionId(sessionId)) return { status: "rejected", reason: "invalid_session_id" };
  const v = validateStripeSession(await retrieveStripeSession(sessionId));
  if (!v.ok) {
    if (v.status === "rejected") console.error("[stripe] payment rejected", { sessionId, reason: v.reason });
    return v.status === "not_paid" ? { status: "not_paid", reason: v.reason } : { status: "rejected", reason: v.reason };
  }
  const f = v.facts;
  if (f.refunded) {
    console.error("[stripe] charge already refunded before confirmation", { sessionId });
    return { status: "rejected", reason: "already_refunded" };
  }
  const txId = stripeTransactionId(f.paymentIntentId);
  const txRef = fsdb().collection(C.transactions).doc(txId);
  const fee = f.fee ?? calcFee(f.amount, defaultFeeRateBps());
  const feeEstimated = f.fee === null;
  try {
    return await fsdb().runTransaction(async (tx) => {
      const [coSnap, existing] = await Promise.all([tx.get(checkoutRef(f.checkoutId)), tx.get(txRef)]);
      if (existing.exists) {
        // 確定済み。手数料が推定値のままで、確定値が取れていれば直す
        if (existing.get("feeEstimated") === true && f.fee !== null) {
          tx.update(txRef, { paymentFee: f.fee, feeEstimated: false, stripeBalanceTransactionId: f.balanceTransactionId, updatedAt: FieldValue.serverTimestamp() });
        }
        return { status: "duplicate", transactionId: txId } as const;
      }
      if (!coSnap.exists) return { status: "rejected", reason: "unknown_checkout" } as const;
      const co = coSnap.data()!;
      if (co.provider !== STRIPE_PROVIDER) return { status: "rejected", reason: "provider_mismatch" } as const;
      if (co.providerPaymentId !== f.sessionId) return { status: "rejected", reason: "session_not_linked" } as const;
      if (co.status === "SUCCEEDED") return { status: "rejected", reason: "checkout_already_succeeded" } as const; // 1注文につき1決済
      // 注文を閉じた後に Stripe 側で支払いが確定した場合も、支払われた以上は権利を付与する（ログで知らせる）
      if (co.status !== "PROCESSING" && co.status !== "CREATED") console.warn("[stripe] payment confirmed after the order was closed", { checkoutId: f.checkoutId, status: co.status });
      if (String(co.storeId) !== f.storeId) return { status: "rejected", reason: "store_mismatch" } as const;
      if (String(co.fortuneType) !== f.fortuneType) return { status: "rejected", reason: "fortune_type_mismatch" } as const;
      if (Number(co.amount) !== f.amount || f.amount !== PRICE_JPY) return { status: "rejected", reason: "amount_mismatch" } as const;
      const stRef = fsdb().collection(C.stores).doc(f.storeId);
      const st = await tx.get(stRef);
      if (!st.exists) return { status: "rejected", reason: "store_not_found" } as const;
      const shareBps = Number(st.get("storeShareBps"));
      if (!Number.isInteger(shareBps) || shareBps < 0 || shareBps > 10000) return { status: "rejected", reason: "invalid_share" } as const;
      const { storeShare, operatorShare } = splitRevenue(f.amount, shareBps);

      tx.create(txRef, {
        checkoutId: f.checkoutId,
        paymentProvider: STRIPE_PROVIDER,
        providerPaymentId: f.paymentIntentId,
        storeId: f.storeId,
        fortuneType: f.fortuneType,
        amount: f.amount,
        storeShare,
        operatorShare,
        paymentFee: fee,
        feeEstimated,
        storeShareBps: shareBps,
        paymentStatus: "SUCCEEDED",
        fortuneStatus: "PENDING",
        livemode: false, // テスト決済（売上・精算に含めない）
        paidAt: f.paidAt,
        refundedAt: null,
        amountRefunded: 0,
        stripeCheckoutSessionId: f.sessionId,
        stripePaymentIntentId: f.paymentIntentId,
        stripeChargeId: f.chargeId,
        stripeBalanceTransactionId: f.balanceTransactionId,
        stripePaymentMethod: f.paymentMethod,
        refundStatus: null,
        refundPendingAmount: 0,
        refundNeedsReview: false,
        ...salesKeys(f.storeId, STRIPE_PROVIDER, "SUCCEEDED", f.paidAt, false),
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      });
      tx.create(fsdb().collection(C.fortuneSessions).doc(txId), {
        transactionId: txId,
        storeId: f.storeId,
        fortuneType: f.fortuneType,
        tokenHash: String(co.accessTokenHash),
        status: "PAID",
        expiresAt: new Date(Date.now() + FORTUNE_SESSION_TTL_MS),
        usedAt: null,
        createdAt: FieldValue.serverTimestamp(),
      });
      tx.update(checkoutRef(f.checkoutId), { status: "SUCCEEDED", providerPaymentKey: txId, failureCode: null, updatedAt: FieldValue.serverTimestamp() });
      // テスト決済は店舗の最終利用日を更新しない（売上に数える決済だけ）
      return { status: "confirmed", transactionId: txId } as const;
    });
  } catch (e) {
    // 同時に別の処理（Webhook と戻り先など）が先に作成した場合
    if (isAlreadyExists(e)) return { status: "duplicate", transactionId: txId };
    throw e;
  }
}

async function stripeSessionStateOf(sessionId: string) {
  return stripeSessionState(await retrieveStripeSession(sessionId));
}

/**
 * 支払いが終わらなかった注文を閉じる（Stripe API から Session を取り直して判断する。支払い済み・確定待ちなら何もしない）。
 *  - Session の期限切れ（支払いも進んでいない）→ EXPIRED
 *  - PaymentIntent の取り消し → FAILED
 *  - 非同期の支払いの失敗：Stripe の通知（asyncFailed=true。署名を確認済み）があり、取り直した Session も
 *    「手続き済み・未払い」のときだけ FAILED。requires_payment_method だけでは失敗にしない
 */
export async function closeStripeCheckout(sessionId: string, opts: { asyncFailed?: boolean } = {}): Promise<"expired" | "failed" | false> {
  if (!isStripeTestSessionId(sessionId)) return false;
  const s = await retrieveStripeSession(sessionId);
  if (s.livemode) return false;
  const state = stripeSessionState(s);
  const next =
    state === "expired" ? ({ status: "EXPIRED", failureCode: "stripe_session_expired" } as const)
    : state === "canceled" ? ({ status: "FAILED", failureCode: "stripe_payment_canceled" } as const)
    : state === "failed_candidate" && opts.asyncFailed && s.status === "complete" ? ({ status: "FAILED", failureCode: "stripe_async_payment_failed" } as const)
    : null;
  if (!next) return false;
  const checkoutId = s.metadata?.checkoutId ?? s.client_reference_id ?? "";
  if (!checkoutId) return false;
  const closed = await fsdb().runTransaction(async (tx) => {
    const snap = await tx.get(checkoutRef(checkoutId));
    const d = snap.data();
    if (!d || d.provider !== STRIPE_PROVIDER || d.providerPaymentId !== sessionId || !["CREATED", "PROCESSING"].includes(d.status)) return false;
    tx.update(checkoutRef(checkoutId), { ...next, updatedAt: FieldValue.serverTimestamp() });
    return true;
  });
  return closed ? (next.status === "EXPIRED" ? "expired" : "failed") : false;
}

export type StripeRefundOutcome = "refund_pending" | "refunded" | "partial" | "refund_failed" | "unchanged" | "ignored";

/**
 * 返金の状態を Stripe API から取り直して、決済記録と占い権利に反映する（charge.refunded・refund.* の通知から呼ばれる）。
 * 状態は返金の一覧から毎回求め直し、変わったときだけ書き込む（通知の再送・順番の入れ替わりがあっても結果は同じ）。
 *  - 処理中 … refundStatus=pending。未使用の権利を止める（suspendedByRefund=true）
 *  - 成功   … paymentStatus=REFUNDED。未使用の権利を止める
 *  - 一部・失敗 … refundNeedsReview=true（管理者が確認する。権利の復旧は restoreStripeEntitlement）
 */
export async function syncStripeRefunds(chargeId: string): Promise<StripeRefundOutcome> {
  const charge = await retrieveStripeCharge(chargeId);
  if (charge.livemode) return "ignored";
  const piId = typeof charge.payment_intent === "string" ? charge.payment_intent : charge.payment_intent?.id;
  if (!piId) return "ignored";
  const summary = summarizeRefunds(charge.id, charge.amount, await listStripeRefunds(charge.id));
  if (summary.state === "none") return "ignored";
  const txRef = fsdb().collection(C.transactions).doc(stripeTransactionId(piId));
  const sessionRef = fsdb().collection(C.fortuneSessions).doc(txRef.id);
  const result = await fsdb().runTransaction(async (tx) => {
    const [t, fs] = await Promise.all([tx.get(txRef), tx.get(sessionRef)]);
    if (!t.exists || t.get("paymentProvider") !== STRIPE_PROVIDER || t.get("stripeChargeId") !== charge.id) return "ignored" as const;
    const refundKey = refundKeyOf(summary);
    if (t.get("refundKey") === refundKey) return "unchanged" as const; // 同じ状態はもう反映済み（再送・重複）
    const refunded = summary.state === "succeeded";
    const needsReview = summary.state === "partial" || summary.state === "failed";
    const paymentStatus = refunded ? "REFUNDED" : "SUCCEEDED"; // 成功した返金が後で失敗に変わったら SUCCEEDED に戻す
    const paidAt = mustDate(t.get("paidAt"));
    tx.update(txRef, {
      refundStatus: summary.state,
      refundKey,
      amountRefunded: summary.succeededAmount,
      refundPendingAmount: summary.pendingAmount,
      refundFailedAmount: summary.failedAmount,
      stripeRefundIds: summary.refundIds,
      refundNeedsReview: needsReview,
      refundUpdatedAt: new Date(),
      ...(t.get("paymentStatus") !== paymentStatus
        ? { paymentStatus, refundedAt: refunded ? new Date() : null, ...salesKeys(String(t.get("storeId")), STRIPE_PROVIDER, paymentStatus, paidAt, t.get("livemode")) }
        : {}),
      updatedAt: FieldValue.serverTimestamp(),
    });
    // 返金の処理中・成功：未使用の権利を止める（使用済みの権利はそのまま）
    if ((refunded || summary.state === "pending") && fs.exists && fs.get("status") === "PAID") {
      tx.update(sessionRef, { status: "EXPIRED", suspendedByRefund: true, suspendedAt: new Date() });
    }
    return refunded ? ("refunded" as const) : summary.state === "pending" ? ("refund_pending" as const) : summary.state === "partial" ? ("partial" as const) : ("refund_failed" as const);
  });
  if (result === "refund_failed") console.error("[stripe] refund failed (admin review required)", { chargeId: charge.id });
  if (result === "partial") console.warn("[stripe] partial refund recorded (admin review required)", { chargeId: charge.id });
  return result;
}

const refundKeyOf = (s: StripeRefundSummary) => `${s.state}:${s.succeededAmount}:${s.pendingAmount}:${s.failedAmount}:${s.refundIds.join(",")}`;

export type StripeRefundReview = {
  transactionId: string;
  storeId: string;
  fortuneType: string;
  amount: number;
  amountRefunded: number;
  refundStatus: string;
  paymentMethod: string | null;
  paidAt: Date;
  entitlement: "suspended" | "used" | "active" | "expired" | "missing";
};

/** 返金の確認が必要なテスト決済（管理画面） */
export async function listStripeRefundReviews(): Promise<StripeRefundReview[]> {
  const q = await fsdb().collection(C.transactions).where("refundNeedsReview", "==", true).limit(50).get();
  const docs = q.docs.filter((d) => d.get("paymentProvider") === STRIPE_PROVIDER);
  const sessions = docs.length ? await fsdb().getAll(...docs.map((d) => fsdb().collection(C.fortuneSessions).doc(d.id))) : [];
  return docs.map((d, i) => {
    const s = sessions[i];
    const entitlement = !s?.exists ? "missing" : s.get("status") === "USED" ? "used" : s.get("status") === "PAID" ? "active" : s.get("suspendedByRefund") === true ? "suspended" : "expired";
    return {
      transactionId: d.id,
      storeId: String(d.get("storeId")),
      fortuneType: String(d.get("fortuneType")),
      amount: Number(d.get("amount")),
      amountRefunded: Number(d.get("amountRefunded") ?? 0),
      refundStatus: String(d.get("refundStatus") ?? ""),
      paymentMethod: typeof d.get("stripePaymentMethod") === "string" ? d.get("stripePaymentMethod") : null,
      paidAt: mustDate(d.get("paidAt")),
      entitlement,
    };
  });
}

type Actor = { userId: string; role: "OPERATOR" };
export type RestoreOutcome = "restored" | "not_eligible" | "refund_not_failed";

/**
 * 返金に失敗した決済の占い権利を戻す（運営の操作。監査ログに残す）。
 * Stripe API で返金の状態を取り直し、返金が成功・処理中でない（すべて失敗・取り消し）ことを確かめてから、
 * 返金で止めた未使用の権利だけを PAID に戻す（有効期限は戻した時点から24時間）。2回目以降は何もしない。
 */
export async function restoreStripeEntitlement(transactionId: string, actor: Actor): Promise<RestoreOutcome> {
  if (!/^stripe_[A-Za-z0-9_]{1,200}$/.test(transactionId)) return "not_eligible";
  const txRef = fsdb().collection(C.transactions).doc(transactionId);
  const first = await txRef.get();
  const chargeId = first.get("stripeChargeId");
  if (!first.exists || first.get("paymentProvider") !== STRIPE_PROVIDER || typeof chargeId !== "string") return "not_eligible";
  await syncStripeRefunds(chargeId); // 最新の返金の状態を反映してから判断する
  const sessionRef = fsdb().collection(C.fortuneSessions).doc(transactionId);
  return fsdb().runTransaction(async (tx) => {
    const [t, fs] = await Promise.all([tx.get(txRef), tx.get(sessionRef)]);
    if (t.get("refundStatus") !== "failed" || t.get("paymentStatus") !== "SUCCEEDED") return "refund_not_failed" as const;
    if (!fs.exists || fs.get("status") !== "EXPIRED" || fs.get("suspendedByRefund") !== true || fs.get("usedAt")) return "not_eligible" as const;
    const expiresAt = new Date(Date.now() + FORTUNE_SESSION_TTL_MS);
    tx.update(sessionRef, { status: "PAID", suspendedByRefund: false, expiresAt, restoredAt: new Date(), restoredBy: actor.userId });
    tx.update(txRef, { refundNeedsReview: false, refundReviewedAt: new Date(), refundReviewResult: "entitlement_restored", updatedAt: FieldValue.serverTimestamp() });
    await writeAudit(
      {
        actorUserId: actor.userId,
        actorRole: actor.role,
        action: "stripe_test.entitlement_restored",
        targetType: "transaction",
        targetId: transactionId,
        storeId: String(t.get("storeId")),
        before: { fortuneSession: "EXPIRED", refundStatus: "failed" },
        after: { fortuneSession: "PAID", expiresAt: expiresAt.toISOString() },
      },
      tx,
    );
    return "restored" as const;
  });
}

/** 返金の確認を終える（権利は戻さない。監査ログに残す） */
export async function dismissStripeRefundReview(transactionId: string, actor: Actor): Promise<boolean> {
  if (!/^stripe_[A-Za-z0-9_]{1,200}$/.test(transactionId)) return false;
  const txRef = fsdb().collection(C.transactions).doc(transactionId);
  return fsdb().runTransaction(async (tx) => {
    const t = await tx.get(txRef);
    if (!t.exists || t.get("paymentProvider") !== STRIPE_PROVIDER || t.get("refundNeedsReview") !== true) return false;
    tx.update(txRef, { refundNeedsReview: false, refundReviewedAt: new Date(), refundReviewResult: "dismissed", updatedAt: FieldValue.serverTimestamp() });
    await writeAudit(
      { actorUserId: actor.userId, actorRole: actor.role, action: "stripe_test.refund_review_dismissed", targetType: "transaction", targetId: transactionId, storeId: String(t.get("storeId")), before: { refundStatus: t.get("refundStatus") }, after: null },
      tx,
    );
    return true;
  });
}

/** 手数料の確定値が出たら、推定値で記録した決済を更新する */
export async function refreshStripeFee(chargeId: string): Promise<boolean> {
  const charge = await retrieveStripeCharge(chargeId);
  if (charge.livemode) return false;
  const { fee, balanceTransactionId } = feeOf(charge);
  const piId = typeof charge.payment_intent === "string" ? charge.payment_intent : charge.payment_intent?.id;
  if (fee === null || !piId) return false;
  const txRef = fsdb().collection(C.transactions).doc(stripeTransactionId(piId));
  return fsdb().runTransaction(async (tx) => {
    const t = await tx.get(txRef);
    if (!t.exists || t.get("stripeChargeId") !== charge.id || t.get("feeEstimated") !== true) return false;
    tx.update(txRef, { paymentFee: fee, feeEstimated: false, stripeBalanceTransactionId: balanceTransactionId, updatedAt: FieldValue.serverTimestamp() });
    return true;
  });
}

/** 戻り先（/payment/return）：ブラウザの注文と Session が紐付いていることを確かめてから確定する */
export async function confirmStripeReturn(token: string | null, sessionId: string): Promise<StripeConfirmOutcome | { status: "not_linked" }> {
  const found = await stripeCheckoutByToken(token);
  if (!found || !isStripeTestSessionId(sessionId) || found.data.providerPaymentId !== sessionId) return { status: "not_linked" };
  return confirmStripeCheckout(sessionId);
}

const RECONCILE_AFTER_MS = 3_000;

/** 状態の確認（/api/checkout/status）。Webhook が遅れても、Stripe API で照合して進める */
export async function stripeCheckoutStatus(checkout: CheckoutLike): Promise<{ status: CheckoutStatus; failureCode?: string | null }> {
  switch (checkout.status) {
    case "SUCCEEDED":
      return { status: "succeeded" };
    case "FAILED":
      return { status: "failed", failureCode: "stripe_failed" };
    case "EXPIRED":
      return { status: "expired" };
    case "CREATED":
      return { status: checkout.expiresAt > new Date() ? "created" : "expired" };
    default: {
      if (!checkout.providerPaymentId) return { status: "processing" };
      try {
        const outcome = await confirmStripeCheckout(checkout.providerPaymentId);
        if (outcome.status === "confirmed" || outcome.status === "duplicate") return { status: "succeeded" };
        if (outcome.status === "rejected") return { status: "failed", failureCode: "stripe_rejected" };
        // 期限の後だけ、期限切れ・取り消しを確かめて閉じる（非同期の支払いの失敗は Stripe の通知で閉じる）
        if (checkout.expiresAt.getTime() + RECONCILE_AFTER_MS < Date.now()) {
          const closed = await closeStripeCheckout(checkout.providerPaymentId);
          if (closed) return closed === "expired" ? { status: "expired" } : { status: "failed", failureCode: "stripe_failed" };
        }
      } catch (e) {
        console.error("[stripe] reconcile failed", { checkoutId: checkout.id, error: (e as Error).name });
      }
      return { status: "processing" };
    }
  }
}

export { STRIPE_SESSION_TTL_MS };
