import "server-only";
import { FieldValue, type DocumentData } from "firebase-admin/firestore";
import { defaultFeeRateBps, FORTUNE_SESSION_TTL_MS, PRICE_JPY, STORE_SHARE_BPS } from "@/config/pricing";
import { calcFee, splitRevenue } from "@/lib/money";
import { C, fsdb, mustDate, safeId, toDate } from "@/lib/firestore/admin";
import { isSalesPayment } from "@/lib/payments/kind";
import { isAlreadyExists, salesKeys } from "@/lib/firestore/shared";
import { sha256Hex } from "@/lib/security/crypto";
import type { CheckoutStatus } from "@/lib/services/checkout";
import { CheckoutError } from "@/lib/errors";
import { FORTUNE_CATALOG } from "@/lib/fortune/catalog";
import { siteConfig } from "@/config/site";
import { writeAudit } from "@/lib/firestore/audit";
import { reconcileTransactionInTx, settlementRefForTx } from "@/lib/firestore/settlement-adjustments";
import { recordPaymentReview, type PaymentReviewInput } from "@/lib/firestore/payment-reviews";
import { chargebackCoversRemainder, disputeStateOf } from "./settlement-rules";
import type Stripe from "stripe";
import {
  createStripeCheckoutSession,
  feeOf,
  isStripeSessionId,
  listStripeRefunds,
  retrieveStripeCharge,
  retrieveStripeDispute,
  retrieveStripePaymentIntent,
  retrieveStripeSession,
  STRIPE_SESSION_TTL_MS,
  stripeSessionExpiry,
  stripeSessionState,
  summarizeRefunds,
  stripeRuntime,
  validateStripeSession,
  type StripeRefundSummary,
  type StripeRuntime,
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
 * モード（テスト／本番）は Stripe との接続（StripeRuntime）で決まる。各関数の最後の引数で渡せるが、アプリからは渡さず
 * stripeRuntime()（今はテストだけ）を使う。本番モードは自動テストで模擬 Stripe API に対してだけ使う。
 * livemode は Stripe から取得してモードとの一致を確かめた値を記録する。テスト決済（false）は売上・店舗の売上画面・月次精算に
 * 含めず、本番の決済（true）だけが含まれる（lib/payments/kind.ts。salesKeys の countable）。
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
 *  - 1つの注文に紐付く Session は1つだけ。注文に Session の ID を保存してから URL を返す（紐付けてから移動する）
 *  - 紐付いた Session がまだ支払える（open）なら、作り直さずにその URL を返す（二重の決済を防ぐ）
 *  - Session の有効期限は、Session を作る時刻から31分後（Stripe の下限は作成から30分）。注文の有効期限も同じ値にそろえる
 *  - すでに別の Session が紐付いていたら拒否する
 */
const EXPIRED_ERROR = () => new CheckoutError("expired", "お支払いの有効期限が切れました。お手数ですが占いの選択からやり直してください。", 410);
const FAILED_ERROR = () => new CheckoutError("payment_failed", "お支払いが完了しませんでした（請求は発生していません）。お手数ですが占いの選択からやり直してください。", 410);

export type StripeStartResult = { status: "redirect"; url: string } | { status: "succeeded" } | { status: "pending"; returnUrl: string };

export async function startStripeCheckout(token: string | null, origin: string, rt?: StripeRuntime): Promise<StripeStartResult> {
  const r0 = rt ?? stripeRuntime();
  const found = await stripeCheckoutByToken(token);
  if (!found) throw new CheckoutError("not_found", "お支払い情報が見つかりません。占いの選択からやり直してください。", 404);
  const d = found.data;
  // 別のモードで始めた注文（テストと本番の取り違え）は、状態にかかわらず扱わない
  if (typeof d.stripeLivemode === "boolean" && d.stripeLivemode !== (r0.mode === "live")) {
    throw new CheckoutError("checkout_conflict", "お支払い情報を確認できませんでした。占いの選択からやり直してください。", 409);
  }
  if (d.status === "SUCCEEDED") return { status: "succeeded" };
  // すでに Session に移動済みなら、期限より先に支払い状況を照合する（期限の後に PayPay の支払いが確定することもあるため）
  if (typeof d.providerPaymentId === "string" && d.providerPaymentId) {
    // 別のモードの Session が紐付いた注文（テストと本番の取り違え）は使わない
    if (!isStripeSessionId(d.providerPaymentId, r0.mode)) throw new CheckoutError("checkout_conflict", "お支払い情報を確認できませんでした。占いの選択からやり直してください。", 409);
    const r = await confirmStripeCheckout(d.providerPaymentId, r0);
    if (r.status === "confirmed" || r.status === "duplicate") return { status: "succeeded" };
    if (r.status === "rejected") throw new CheckoutError("checkout_conflict", "お支払い情報を確認できませんでした。占いの選択からやり直してください。", 409);
    // すでに閉じた注文（失敗・期限切れ）は、支払いが確定していなければ選び直しを案内する
    if (d.status === "FAILED") throw FAILED_ERROR();
    if (d.status === "EXPIRED") throw EXPIRED_ERROR();
    const linkedSession = await retrieveStripeSession(d.providerPaymentId, r0);
    const state = stripeSessionState(linkedSession);
    // まだ支払える Session（カードの拒否の後なども含む）：同じ決済画面へ戻す
    if (state === "retryable") {
      if (!linkedSession.url) throw new CheckoutError("checkout_conflict", "お支払い情報を確認できませんでした。占いの選択からやり直してください。", 409);
      return { status: "redirect", url: linkedSession.url };
    }
    if (state === "canceled" || state === "expired") {
      await closeStripeCheckout(d.providerPaymentId, {}, r0);
      throw state === "canceled" ? FAILED_ERROR() : EXPIRED_ERROR();
    }
    // それ以外（Stripe 側で確定待ち・支払い済みで確定の処理待ちなど）：新しい Session は作らない（二重の支払いを防ぐ）。確認中の画面へ
    return { status: "pending", returnUrl: `/payment/return?session_id=${encodeURIComponent(d.providerPaymentId)}` };
  }
  if (d.status === "FAILED") throw FAILED_ERROR();
  // 注文の期限が過ぎていたら Session を作らない（注文の期限は、占いを選んだ時刻から31分）
  if (!["CREATED", "PROCESSING"].includes(d.status) || mustDate(d.expiresAt) <= new Date()) throw EXPIRED_ERROR();
  const store = await fsdb().collection(C.stores).doc(String(d.storeId)).get();
  if (!store.exists || store.get("status") !== "ACTIVE") throw new CheckoutError("store_suspended", "こちらの店舗では現在ご利用いただけません。", 403);

  const session = await createStripeCheckoutSession({
    checkoutId: found.id,
    storeId: String(d.storeId),
    fortuneType: String(d.fortuneType),
    productName: `${siteConfig.name} ${FORTUNE_CATALOG[d.fortuneType as keyof typeof FORTUNE_CATALOG]?.label ?? "占い"}（テスト決済）`,
    origin,
    expiresAt: stripeSessionExpiry(),
  }, r0);
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
        // 注文の期限を Session の期限にそろえる（注文の期限切れの判断と、Stripe の期限切れを一致させる）
        expiresAt: session.expiresAt,
        // どちらのモードの Session か（確定時に照合する）
        stripeLivemode: r0.mode === "live",
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
export async function confirmStripeCheckout(sessionId: string, rt?: StripeRuntime): Promise<StripeConfirmOutcome> {
  const r0 = rt ?? stripeRuntime();
  if (!isStripeSessionId(sessionId, r0.mode)) return { status: "rejected", reason: "invalid_session_id" };
  const v = validateStripeSession(await retrieveStripeSession(sessionId, r0), r0.mode);
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
      // 注文に記録したモードと、決済のモードが一致すること（記録が無い古い注文は、Session の ID の形で確認済み）
      if (typeof co.stripeLivemode === "boolean" && co.stripeLivemode !== f.livemode) return { status: "rejected", reason: "mode_mismatch" } as const;
      if (co.status === "SUCCEEDED") return { status: "rejected", reason: "checkout_already_succeeded" } as const; // 1注文につき1決済
      // 注文を閉じた後に Stripe 側で支払いが確定した場合も、支払われた以上は権利を付与する（ログで知らせる）
      if (co.status !== "PROCESSING" && co.status !== "CREATED") console.warn("[stripe] payment confirmed after the order was closed", { checkoutId: f.checkoutId, status: co.status });
      if (String(co.storeId) !== f.storeId) return { status: "rejected", reason: "store_mismatch" } as const;
      if (String(co.fortuneType) !== f.fortuneType) return { status: "rejected", reason: "fortune_type_mismatch" } as const;
      if (Number(co.amount) !== f.amount || f.amount !== PRICE_JPY) return { status: "rejected", reason: "amount_mismatch" } as const;
      const stRef = fsdb().collection(C.stores).doc(f.storeId);
      const st = await tx.get(stRef);
      if (!st.exists) return { status: "rejected", reason: "store_not_found" } as const;
      // 店舗の取り分は全店舗一律（店舗のデータの率は使わない）。決済時点の取り分を保存する
      const shareBps = STORE_SHARE_BPS;
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
        livemode: f.livemode, // Stripe から取得した値（モードと一致を確認済み）。true の本番の決済だけが売上・精算の対象
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
        ...salesKeys(f.storeId, STRIPE_PROVIDER, "SUCCEEDED", f.paidAt, f.livemode),
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
      // 店舗の最終利用日は、売上に数える決済（本番の決済）だけで更新する（テスト決済では更新しない）
      if (isSalesPayment(STRIPE_PROVIDER, f.livemode)) {
        const lastUsed = toDate(st.get("lastUsedAt"));
        if (!lastUsed || lastUsed < f.paidAt) tx.update(stRef, { lastUsedAt: f.paidAt });
      }
      return { status: "confirmed", transactionId: txId } as const;
    });
  } catch (e) {
    // 同時に別の処理（Webhook と戻り先など）が先に作成した場合
    if (isAlreadyExists(e)) return { status: "duplicate", transactionId: txId };
    throw e;
  }
}

/**
 * 支払いが終わらなかった注文を閉じる（Stripe API から Session を取り直して判断する。支払い済み・確定待ちなら何もしない）。
 *  - Session の期限切れ（支払いも進んでいない）→ EXPIRED
 *  - PaymentIntent の取り消し → FAILED
 *  - 非同期の支払いの失敗：Stripe の通知（asyncFailed=true。署名を確認済み）があり、取り直した Session も
 *    「手続き済み・未払い」のときだけ FAILED。requires_payment_method だけでは失敗にしない
 */
export async function closeStripeCheckout(sessionId: string, opts: { asyncFailed?: boolean } = {}, rt?: StripeRuntime): Promise<"expired" | "failed" | false> {
  const r0 = rt ?? stripeRuntime();
  if (!isStripeSessionId(sessionId, r0.mode)) return false;
  const s = await retrieveStripeSession(sessionId, r0);
  if (s.livemode !== (r0.mode === "live")) return false;
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

export type StripeRefundOutcome = "refund_pending" | "refunded" | "partial" | "refund_failed" | "unchanged" | "ignored" | "rejected";

const idOfRef = (v: unknown): string | null => (typeof v === "string" ? v : v && typeof v === "object" && typeof (v as { id?: unknown }).id === "string" ? (v as { id: string }).id : null);

/**
 * Stripe の Charge が、記録した決済（取引）と一致するか（返金・異議申し立ての反映の前に確かめる）。
 * 決済ID（Charge・PaymentIntent）、モード（livemode）、金額、通貨、店舗（PaymentIntent の metadata）がすべて一致すること。
 * 一致しない項目名を返す（空なら一致）。値そのものは返さない（決済要確認には項目名だけを記録する）。
 */
function chargeMismatches(t: DocumentData, charge: Stripe.Charge, pi: Stripe.PaymentIntent): string[] {
  const out: string[] = [];
  if (t.paymentProvider !== STRIPE_PROVIDER) out.push("provider");
  if (t.stripeChargeId !== charge.id) out.push("charge_id");
  if (t.livemode !== charge.livemode || pi.livemode !== charge.livemode) out.push("livemode");
  if (idOfRef(charge.payment_intent) !== pi.id) out.push("payment_intent");
  if (charge.currency !== "jpy") out.push("currency");
  if (Number(t.amount) !== charge.amount || pi.amount !== charge.amount) out.push("amount");
  if (pi.metadata?.storeId !== String(t.storeId)) out.push("store");
  return out;
}

/** このアプリの注文の決済か（PaymentIntent の metadata に注文ID・店舗IDを入れている） */
const isOurPayment = (pi: Stripe.PaymentIntent) => typeof pi.metadata?.checkoutId === "string" && pi.metadata.checkoutId !== "" && typeof pi.metadata?.storeId === "string";

type TxOutcome<T extends string> = { outcome: T; review?: PaymentReviewInput };

/**
 * 返金の状態を Stripe API から取り直して、決済記録と占い権利に反映する（charge.refunded・refund.* の通知から呼ばれる）。
 * 状態は返金の一覧から毎回求め直し、変わったときだけ書き込む（通知の再送・順番の入れ替わりがあっても結果は同じ。古い通知が
 * 後から届いても、Stripe API の今の状態で判断するので巻き戻らない）。
 *  - 処理中 … refundStatus=pending。未使用の権利を止める（suspendedByRefund=true）
 *  - 成功   … paymentStatus=REFUNDED。未使用の権利を止める
 *  - 一部・失敗 … refundNeedsReview=true（管理者が確認する。権利の復旧は restoreStripeEntitlement）
 * 記録と照合できないとき（店舗・金額の食い違い、記録が無い）は反映せず「決済要確認」に記録する。
 */
export async function syncStripeRefunds(chargeId: string, rt?: StripeRuntime, eventType?: string): Promise<StripeRefundOutcome> {
  const r0 = rt ?? stripeRuntime();
  const charge = await retrieveStripeCharge(chargeId, r0);
  if (charge.livemode !== (r0.mode === "live")) return "ignored"; // 別のモードの決済は扱わない
  const piId = typeof charge.payment_intent === "string" ? charge.payment_intent : charge.payment_intent?.id;
  if (!piId) return "ignored";
  const summary = summarizeRefunds(charge.id, charge.amount, await listStripeRefunds(charge.id, r0));
  if (summary.state === "none") return "ignored";
  const pi = await retrieveStripePaymentIntent(piId, r0);
  const txRef = fsdb().collection(C.transactions).doc(stripeTransactionId(piId));
  const sessionRef = fsdb().collection(C.fortuneSessions).doc(txRef.id);
  const base = { chargeId: charge.id, paymentIntentId: piId, eventType: eventType ?? null, livemode: charge.livemode };
  const res = await fsdb().runTransaction(async (tx): Promise<TxOutcome<StripeRefundOutcome>> => {
    const [t, fs] = await Promise.all([tx.get(txRef), tx.get(sessionRef)]);
    if (!t.exists) return { outcome: "ignored", review: isOurPayment(pi) ? { kind: "transaction_not_found", objectType: "charge", objectId: charge.id, storeId: pi.metadata.storeId, ...base } : undefined };
    // 金額・店舗などが記録と一致しない返金は反映しない（売上・精算を動かさない）
    const mism = chargeMismatches(t.data()!, charge, pi);
    if (mism.length) return { outcome: "rejected", review: { kind: "charge_mismatch", objectType: "charge", objectId: charge.id, transactionId: t.id, storeId: String(t.get("storeId")), mismatches: mism, ...base } };
    const refundKey = refundKeyOf(summary);
    if (t.get("refundKey") === refundKey) return { outcome: "unchanged" }; // 同じ状態はもう反映済み（再送・重複）
    const st = await tx.get(settlementRefForTx(t.data()!));
    const refunded = summary.state === "succeeded";
    const needsReview = summary.state === "partial" || summary.state === "failed";
    const paymentStatus = refunded ? "REFUNDED" : "SUCCEEDED"; // 成功した返金が後で失敗に変わったら SUCCEEDED に戻す
    const paidAt = mustDate(t.get("paidAt"));
    // 異議申し立てで敗訴（全額）した決済は CHARGEBACK のまま（返金の状態だけ記録する）
    const nextStatus = t.get("paymentStatus") === "CHARGEBACK" ? "CHARGEBACK" : paymentStatus;
    const patch: Record<string, unknown> = {
      refundStatus: summary.state,
      refundKey,
      amountRefunded: summary.succeededAmount,
      refundPendingAmount: summary.pendingAmount,
      refundFailedAmount: summary.failedAmount,
      stripeRefundIds: summary.refundIds,
      refundNeedsReview: needsReview,
      refundUpdatedAt: new Date(),
      ...(t.get("paymentStatus") !== nextStatus
        ? { paymentStatus: nextStatus, refundedAt: refunded ? new Date() : null, ...salesKeys(String(t.get("storeId")), STRIPE_PROVIDER, nextStatus, paidAt, t.get("livemode")) }
        : {}),
    };
    // 振込済み（確定済み）の月の取引なら、取り分の差額を調整として記録する（成功した返金の額だけ。処理中・失敗では減らさない）
    const adj = reconcileTransactionInTx(tx, txRef, t.data()!, patch, "refund", summary.refundIds.join(","), { id: st.id, data: st.data() });
    tx.update(txRef, { ...patch, ...adj.fields, updatedAt: FieldValue.serverTimestamp() });
    // 返金の処理中・成功：未使用の権利を止める（使用済みの権利はそのまま）
    if ((refunded || summary.state === "pending") && fs.exists && fs.get("status") === "PAID") {
      tx.update(sessionRef, { status: "EXPIRED", suspendedByRefund: true, suspendedAt: new Date() });
    }
    const outcome = refunded ? "refunded" : summary.state === "pending" ? "refund_pending" : summary.state === "partial" ? "partial" : "refund_failed";
    return { outcome, review: adj.review ? { ...adj.review, eventType: eventType ?? null } : undefined };
  });
  if (res.review) await recordPaymentReview(res.review);
  const result = res.outcome;
  if (result === "rejected") console.error("[stripe] refund does not match the recorded payment (not applied)", { chargeId: charge.id });
  if (result === "refund_failed") console.error("[stripe] refund failed (admin review required)", { chargeId: charge.id });
  if (result === "partial") console.warn("[stripe] partial refund recorded (admin review required)", { chargeId: charge.id });
  return result;
}

export type StripeDisputeOutcome = "dispute_open" | "dispute_won" | "dispute_lost" | "unchanged" | "ignored" | "rejected";

/**
 * 異議申し立て（チャージバック）の状態を Stripe API から取り直して、決済記録に反映する（charge.dispute.* の通知から呼ばれる）。
 *  - 対応中（needs_response・under_review など）… disputeStatus=open。売上には数えたまま、申し立ての額の分だけ精算を保留
 *  - 勝訴（won など）……………………………………… disputeStatus=won。保留を解除（振込済みの月なら、差し引いた分を次回に戻す）
 *  - 敗訴（lost）…………………………………………… 申し立ての額を売上・取り分から除く。返金の後の残りすべてなら paymentStatus=CHARGEBACK
 *                                                    （一部の額だけなら、残りは売上・取り分に残す）。未使用の権利を止める
 * 振込済み（確定済み）の月の取引は、取り分の差額を調整として記録する（同じトランザクション）。
 * 同じ状態はもう反映済みとして何もしない（通知の再送・重複でも二重にならない）。結果が出た（勝訴・敗訴）申し立ては
 * 対応中に戻さない（Stripe API が古い状態を返しても巻き戻らない。決済要確認に記録する）。
 */
export async function syncStripeDispute(disputeId: string, rt?: StripeRuntime, eventType?: string): Promise<StripeDisputeOutcome> {
  const r0 = rt ?? stripeRuntime();
  const dp = await retrieveStripeDispute(disputeId, r0);
  if (dp.livemode !== (r0.mode === "live")) return "ignored";
  const chargeId = idOfRef(dp.charge);
  if (!chargeId) return "ignored";
  const charge = await retrieveStripeCharge(chargeId, r0);
  if (charge.livemode !== (r0.mode === "live")) return "ignored";
  const piId = idOfRef(charge.payment_intent);
  if (!piId) return "ignored";
  const pi = await retrieveStripePaymentIntent(piId, r0);
  const base = { chargeId: charge.id, paymentIntentId: piId, eventType: eventType ?? null, livemode: charge.livemode };
  if (dp.currency !== "jpy" || !Number.isSafeInteger(dp.amount) || dp.amount <= 0 || dp.amount > charge.amount) {
    console.error("[stripe] dispute amount does not match the charge (not applied)", { disputeId: dp.id });
    if (isOurPayment(pi)) await recordPaymentReview({ kind: "dispute_amount_invalid", objectType: "dispute", objectId: dp.id, storeId: pi.metadata.storeId, amount: Number.isSafeInteger(dp.amount) ? dp.amount : null, mismatches: [dp.currency !== "jpy" ? "currency" : "amount"], ...base });
    return "rejected";
  }
  const state = disputeStateOf(String(dp.status));
  const txRef = fsdb().collection(C.transactions).doc(stripeTransactionId(piId));
  const sessionRef = fsdb().collection(C.fortuneSessions).doc(txRef.id);
  const res = await fsdb().runTransaction(async (tx): Promise<TxOutcome<StripeDisputeOutcome>> => {
    const [t, fs] = await Promise.all([tx.get(txRef), tx.get(sessionRef)]);
    if (!t.exists) return { outcome: "ignored", review: isOurPayment(pi) ? { kind: "transaction_not_found", objectType: "dispute", objectId: dp.id, storeId: pi.metadata.storeId, ...base } : undefined };
    const mism = chargeMismatches(t.data()!, charge, pi);
    if (mism.length) return { outcome: "rejected", review: { kind: "charge_mismatch", objectType: "dispute", objectId: dp.id, transactionId: t.id, storeId: String(t.get("storeId")), mismatches: mism, ...base } };
    const prevId = t.get("disputeId");
    const prevState = t.get("disputeStatus");
    // 同じ決済に別の異議申し立て（通常は起きない）：自動では反映しない
    if (typeof prevId === "string" && prevId && prevId !== dp.id) return { outcome: "rejected", review: { kind: "multiple_disputes", objectType: "dispute", objectId: dp.id, transactionId: t.id, storeId: String(t.get("storeId")), ...base } };
    // 結果が出た申し立てを対応中に戻さない（古い状態の取り直し・順番の入れ替わり）
    if ((prevState === "won" || prevState === "lost") && state === "open") return { outcome: "unchanged", review: { kind: "dispute_state_regressed", objectType: "dispute", objectId: dp.id, transactionId: t.id, storeId: String(t.get("storeId")), ...base } };
    const key = `${dp.id}:${dp.status}:${dp.amount}`;
    if (t.get("disputeKey") === key) return { outcome: "unchanged" };
    const st = await tx.get(settlementRefForTx(t.data()!));
    const cur = String(t.get("paymentStatus"));
    const facts = { amount: Number(t.get("amount")), amountRefunded: Number(t.get("amountRefunded") ?? 0), disputeStatus: state, disputeAmount: dp.amount };
    const full = chargebackCoversRemainder(facts);
    const refundedAll = t.get("refundStatus") === "succeeded";
    const nextStatus = state === "lost" && full ? "CHARGEBACK" : cur === "CHARGEBACK" ? (refundedAll ? "REFUNDED" : "SUCCEEDED") : cur;
    const patch: Record<string, unknown> = {
      disputeId: dp.id,
      disputeStatus: state,
      disputeStripeStatus: String(dp.status),
      disputeAmount: dp.amount,
      disputeReason: String(dp.reason ?? ""),
      disputeKey: key,
      disputeNeedsReview: state !== "won",
      disputeUpdatedAt: new Date(),
      ...(nextStatus !== cur
        ? { paymentStatus: nextStatus, chargebackAt: nextStatus === "CHARGEBACK" ? new Date() : null, ...salesKeys(String(t.get("storeId")), STRIPE_PROVIDER, nextStatus, mustDate(t.get("paidAt")), t.get("livemode")) }
        : {}),
    };
    const adj = reconcileTransactionInTx(tx, txRef, t.data()!, patch, "dispute", dp.id, { id: st.id, data: st.data() });
    tx.update(txRef, { ...patch, ...adj.fields, updatedAt: FieldValue.serverTimestamp() });
    // 敗訴：未使用の権利を止める（使用済みはそのまま）
    if (state === "lost" && fs.exists && fs.get("status") === "PAID") tx.update(sessionRef, { status: "EXPIRED", suspendedByDispute: true, suspendedAt: new Date() });
    const outcome = state === "lost" ? "dispute_lost" : state === "won" ? "dispute_won" : "dispute_open";
    return { outcome, review: adj.review ? { ...adj.review, eventType: eventType ?? null } : undefined };
  });
  if (res.review) await recordPaymentReview(res.review);
  const result = res.outcome;
  if (result === "rejected") console.error("[stripe] dispute does not match the recorded payment (not applied)", { disputeId: dp.id });
  if (result === "dispute_open" || result === "dispute_lost") console.warn("[stripe] dispute recorded (admin review required)", { disputeId: dp.id, state });
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

/** 返金の確認が必要な決済（管理画面） */
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
export async function restoreStripeEntitlement(transactionId: string, actor: Actor, rt?: StripeRuntime): Promise<RestoreOutcome> {
  if (!/^stripe_[A-Za-z0-9_]{1,200}$/.test(transactionId)) return "not_eligible";
  const txRef = fsdb().collection(C.transactions).doc(transactionId);
  const first = await txRef.get();
  const chargeId = first.get("stripeChargeId");
  if (!first.exists || first.get("paymentProvider") !== STRIPE_PROVIDER || typeof chargeId !== "string") return "not_eligible";
  // 別のモードの決済（テストの環境で本番の決済など）は扱わない（Stripe にも問い合わせない）
  if (first.get("livemode") !== ((rt ?? stripeRuntime()).mode === "live")) return "not_eligible";
  await syncStripeRefunds(chargeId, rt); // 最新の返金の状態を反映してから判断する
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

export type StripeDisputeReview = {
  transactionId: string;
  storeId: string;
  amount: number;
  disputeAmount: number;
  disputeStatus: "open" | "won" | "lost";
  disputeStripeStatus: string;
  disputeReason: string;
  livemode: boolean;
  paidAt: Date;
};

/** 異議申し立て（チャージバック）の確認が必要な決済（管理画面。対応中・敗訴） */
export async function listStripeDisputeReviews(): Promise<StripeDisputeReview[]> {
  const q = await fsdb().collection(C.transactions).where("disputeNeedsReview", "==", true).limit(50).get();
  return q.docs
    .filter((d) => d.get("paymentProvider") === STRIPE_PROVIDER)
    .map((d) => ({
      transactionId: d.id,
      storeId: String(d.get("storeId")),
      amount: Number(d.get("amount")),
      disputeAmount: Number(d.get("disputeAmount") ?? 0),
      disputeStatus: d.get("disputeStatus") as "open" | "won" | "lost",
      disputeStripeStatus: String(d.get("disputeStripeStatus") ?? ""),
      disputeReason: String(d.get("disputeReason") ?? ""),
      livemode: d.get("livemode") === true,
      paidAt: mustDate(d.get("paidAt")),
    }));
}

/**
 * 異議申し立ての確認を終える（結果が出たもの＝敗訴だけ。対応中は Stripe で結果が出るまで残す）。監査ログに記録。
 * 精算の保留・調整は状態から自動で決まるので、ここでは変えない。
 */
export async function dismissStripeDisputeReview(transactionId: string, actor: Actor): Promise<"dismissed" | "still_open" | "not_found"> {
  if (!/^stripe_[A-Za-z0-9_]{1,200}$/.test(transactionId)) return "not_found";
  const txRef = fsdb().collection(C.transactions).doc(transactionId);
  return fsdb().runTransaction(async (tx) => {
    const t = await tx.get(txRef);
    if (!t.exists || t.get("paymentProvider") !== STRIPE_PROVIDER || t.get("disputeNeedsReview") !== true) return "not_found" as const;
    if (t.get("disputeStatus") === "open") return "still_open" as const;
    tx.update(txRef, { disputeNeedsReview: false, disputeReviewedAt: new Date(), updatedAt: FieldValue.serverTimestamp() });
    await writeAudit(
      { actorUserId: actor.userId, actorRole: actor.role, action: "stripe.dispute_review_dismissed", targetType: "transaction", targetId: transactionId, storeId: String(t.get("storeId")), before: { disputeStatus: t.get("disputeStatus") }, after: null },
      tx,
    );
    return "dismissed" as const;
  });
}

/** 手数料の確定値が出たら、推定値で記録した決済を更新する */
export async function refreshStripeFee(chargeId: string, rt?: StripeRuntime): Promise<boolean> {
  const r0 = rt ?? stripeRuntime();
  const charge = await retrieveStripeCharge(chargeId, r0);
  if (charge.livemode !== (r0.mode === "live")) return false;
  const { fee, balanceTransactionId } = feeOf(charge);
  const piId = typeof charge.payment_intent === "string" ? charge.payment_intent : charge.payment_intent?.id;
  if (fee === null || !piId) return false;
  const txRef = fsdb().collection(C.transactions).doc(stripeTransactionId(piId));
  return fsdb().runTransaction(async (tx) => {
    const t = await tx.get(txRef);
    if (!t.exists || t.get("stripeChargeId") !== charge.id || t.get("livemode") !== charge.livemode || t.get("feeEstimated") !== true) return false;
    tx.update(txRef, { paymentFee: fee, feeEstimated: false, stripeBalanceTransactionId: balanceTransactionId, updatedAt: FieldValue.serverTimestamp() });
    return true;
  });
}

/** 戻り先（/payment/return）：ブラウザの注文と Session が紐付いていることを確かめてから確定する */
export async function confirmStripeReturn(token: string | null, sessionId: string, rt?: StripeRuntime): Promise<StripeConfirmOutcome | { status: "not_linked" }> {
  const r0 = rt ?? stripeRuntime();
  const found = await stripeCheckoutByToken(token);
  if (!found || !isStripeSessionId(sessionId, r0.mode) || found.data.providerPaymentId !== sessionId) return { status: "not_linked" };
  return confirmStripeCheckout(sessionId, r0);
}

const RECONCILE_AFTER_MS = 3_000;

/** 状態の確認（/api/checkout/status）。Webhook が遅れても、Stripe API で照合して進める */
export async function stripeCheckoutStatus(checkout: CheckoutLike, rt?: StripeRuntime): Promise<{ status: CheckoutStatus; failureCode?: string | null }> {
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
        const r0 = rt ?? stripeRuntime();
        const outcome = await confirmStripeCheckout(checkout.providerPaymentId, r0);
        if (outcome.status === "confirmed" || outcome.status === "duplicate") return { status: "succeeded" };
        if (outcome.status === "rejected") return { status: "failed", failureCode: "stripe_rejected" };
        // 期限の後だけ、期限切れ・取り消しを確かめて閉じる（非同期の支払いの失敗は Stripe の通知で閉じる）
        if (checkout.expiresAt.getTime() + RECONCILE_AFTER_MS < Date.now()) {
          const closed = await closeStripeCheckout(checkout.providerPaymentId, {}, r0);
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
