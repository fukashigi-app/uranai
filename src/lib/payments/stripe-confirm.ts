import "server-only";
import { FieldValue, type DocumentData, type DocumentSnapshot, type Transaction } from "firebase-admin/firestore";
import { defaultFeeRateBps, FORTUNE_SESSION_TTL_MS, PRICE_JPY, STORE_SHARE_BPS } from "@/config/pricing";
import { calcFee, splitRevenue } from "@/lib/money";
import { C, fsdb, mustDate, safeId, toDate } from "@/lib/firestore/admin";
import { isSalesPayment } from "@/lib/payments/kind";
import { feeKeys, isAlreadyExists, salesKeys } from "@/lib/firestore/shared";
import { sha256Hex } from "@/lib/security/crypto";
import type { CheckoutStatusResult } from "@/lib/services/checkout";
import { isCheckoutRefundReason, refundedNotice, type CheckoutRefundReason } from "./refunded-notice";
import { CheckoutError } from "@/lib/errors";
import { FORTUNE_CATALOG } from "@/lib/fortune/catalog";
import { siteConfig } from "@/config/site";
import { writeAudit } from "@/lib/firestore/audit";
import { reconcileTransactionInTx, settlementRefForTx } from "@/lib/firestore/settlement-adjustments";
import { paymentReviewRef, recordPaymentReviewInTx, recordRequiredPaymentReview, type PaymentReviewInput } from "@/lib/firestore/payment-reviews";
import type { DisputeState } from "./settlement-rules";
import {
  chargeMismatches,
  checkoutIdOf,
  decideAfterConfirmForSync,
  decideCheckoutAfterSync,
  decideConfirmState,
  decideDisputeSync,
  decideEntitlementRestore,
  decideRefundSync,
  disputeAmountProblem,
  disputeKeyOf,
  isOurPayment,
  normalizeRestoreReason,
  planMissingTransaction,
  RECHECK_DONE,
  RECHECK_PENDING,
  recheckFailureOf,
  sessionPaymentIntentMatches,
  recheckStateOf,
  refundKeyOf,
  RESTORE_REASON_MAX,
  type RestoreOutcomeCode,
} from "./stripe-sync-rules";
import { recordPaymentAlert } from "@/lib/firestore/payment-alerts";
import { alertModeOf } from "./monitor-rules";
import {
  createStripeCheckoutSession,
  ensureStripeAccount,
  feeOf,
  isOtherStripeEnv,
  isStripeSessionId,
  listStripeRefunds,
  readStripeChargeAdjustments,
  StripeAdjustmentsUnverifiedError,
  retrieveStripeCharge,
  retrieveStripeDispute,
  retrieveStripePaymentIntent,
  retrieveStripeSession,
  STRIPE_ENV_METADATA_KEY,
  STRIPE_SESSION_TTL_MS,
  stripeSessionExpiry,
  stripeSessionState,
  summarizeRefunds,
  stripeRuntime,
  validateStripeSession,
  type StripePaidRejection,
  type StripeRuntime,
  stripeProductName,
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
 * stripeRuntime()（Preview はテスト、Production は本番）を使う。ローカルの自動テストは模擬 Stripe API の接続を渡す。
 * livemode は Stripe から取得してモードとの一致を確かめた値を記録する。テスト決済（false）は売上・店舗の売上画面・月次精算に
 * 含めず、本番の決済（true）だけが含まれる（lib/payments/kind.ts。salesKeys の countable）。
 * 店舗の取り分・運営の取り分は記録する（100円 → 30円・70円）。手数料は Stripe の確定値。未確定なら推定値で feeEstimated=true にして、後で確定値に直す。
 */

export const STRIPE_PROVIDER = "stripe" as const;
export const stripeTransactionId = (paymentIntentId: string) => safeId(STRIPE_PROVIDER, paymentIntentId);

/**
 * 決済確定の結果。recheck は決済確定の後の再確認を実行したときだけ付く
 * （done＝完了、pending＝失敗して PENDING のまま。Webhook は 500 を返して Stripe に再送させる）。
 */
export type StripeConfirmOutcome = (
  | { status: "confirmed"; transactionId: string }
  | { status: "duplicate"; transactionId: string }
  /** 返金済み・チャージバック：決済記録は作る（または作成済み）が、占い権利は付与しない（注文は REFUNDED） */
  | { status: "refunded"; transactionId: string; refundReason: CheckoutRefundReason | null }
  | { status: "not_paid"; reason: string }
  /**
   * paidReview … Stripe では支払い済みだが確定を拒否した（決済要確認・決済監視に記録済み。利用者には「請求は発生していません」と案内しない）
   * retryable … 注文・店舗の記録が見つからない（復元の途中・データの消失など、後で記録が戻る可能性がある）。Webhook は処理済みにせず 500 を返し、
   *             Stripe の再送・Webhook の自動の復旧・運営の再処理で、記録が戻った後に確定する
   */
  | { status: "rejected"; reason: string; paidReview?: true; retryable?: true }
) & { recheck?: RecheckRun };

/** 再確認の実行の結果（not_pending＝PENDING ではなかったので何もしていない） */
export type RecheckRun = "done" | "pending" | "not_pending";

const checkoutRef = (id: string) => fsdb().collection(C.checkouts).doc(id);

type CheckoutLike = { id: string; provider: string; status: string; providerPaymentId: string | null; expiresAt: Date; storeId: string; fortuneType: string; refundReason?: unknown };

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
/** 返金済み・チャージバックの注文（REFUNDED）：占いも新しい決済も始めない（「請求は発生していません」とは案内しない） */
const REFUNDED_ERROR = (reason: unknown) => new CheckoutError("refunded", refundedNotice(isCheckoutRefundReason(reason) ? reason : null).body, 410);
/** 支払い済みなのに確定できなかった決済（運営が確認する）：新しい決済を始めない・「請求は発生していません」とは案内しない */
const PAID_REVIEW_ERROR = () =>
  new CheckoutError("checkout_conflict", "お支払いの内容を確認できなかったため、占いを開始できませんでした。お手数ですが、運営までお問い合わせください。もう一度お支払いいただく必要はありません。", 409);
const refundReasonOf = (v: unknown): CheckoutRefundReason | null => (isCheckoutRefundReason(v) ? v : null);

export type StripeStartResult = { status: "redirect"; url: string } | { status: "succeeded" } | { status: "pending"; returnUrl: string };

export async function startStripeCheckout(token: string | null, origin: string, rt?: StripeRuntime): Promise<StripeStartResult> {
  const r0 = rt ?? stripeRuntime();
  // 本番：キーが設定した Stripe のアカウントのものか（違えば決済画面を作らない。例外は呼び出し側で 502）
  await ensureStripeAccount(r0);
  const found = await stripeCheckoutByToken(token);
  if (!found) throw new CheckoutError("not_found", "お支払い情報が見つかりません。占いの選択からやり直してください。", 404);
  const d = found.data;
  // 別のモードで始めた注文（テストと本番の取り違え）は、状態にかかわらず扱わない
  if (typeof d.stripeLivemode === "boolean" && d.stripeLivemode !== (r0.mode === "live")) {
    throw new CheckoutError("checkout_conflict", "お支払い情報を確認できませんでした。占いの選択からやり直してください。", 409);
  }
  // 返金済み・チャージバックの注文：決済記録があっても占いへ進めない（確定の照合より先に判断する）
  if (d.status === "REFUNDED") throw REFUNDED_ERROR(d.refundReason);
  if (d.status === "SUCCEEDED") return { status: "succeeded" };
  // すでに Session に移動済みなら、期限より先に支払い状況を照合する（期限の後に PayPay の支払いが確定することもあるため）
  if (typeof d.providerPaymentId === "string" && d.providerPaymentId) {
    // 別のモードの Session が紐付いた注文（テストと本番の取り違え）は使わない
    if (!isStripeSessionId(d.providerPaymentId, r0.mode)) throw new CheckoutError("checkout_conflict", "お支払い情報を確認できませんでした。占いの選択からやり直してください。", 409);
    const r = await confirmStripeCheckout(d.providerPaymentId, r0);
    if (r.status === "refunded") throw REFUNDED_ERROR(r.refundReason);
    if (r.status === "confirmed" || r.status === "duplicate") return { status: "succeeded" };
    if (r.status === "rejected" && r.paidReview) throw PAID_REVIEW_ERROR();
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
    productName: stripeProductName(siteConfig.name, FORTUNE_CATALOG[d.fortuneType as keyof typeof FORTUNE_CATALOG]?.label ?? "占い", r0.mode),
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
 *
 * 確定の前に、その Charge の返金・異議申し立ての今の状態を Stripe API から読む（readStripeChargeAdjustments）。
 *  - 取得・検証できなければ例外（一時的なエラー。決済確定を進めない。Webhook は 500 で再送される）
 *  - 返金（処理中・成功・一部）・異議申し立ての敗訴があれば、決済記録はその状態で作り、占い権利は最初から止めて作る
 *    （一瞬も PAID にしない）。注文は REFUNDED（理由 refund / chargeback）。結果は refunded
 *  - 異議申し立ての対応中は、権利は付与し、精算の保留に使う項目（disputeStatus など）を記録する
 * 作成の後に、もう一度 Stripe の状態を読み、読んだ後から作成までの間に起きた返金・異議申し立てを反映する
 * （syncStripeRefunds・syncStripeDispute。Stripe から取り直した最新の状態と、記録済みのキーで判断するので古い情報で上書きしない）。
 */
/** 決済の環境を表す値がこの環境と違うのに、この環境に注文・決済記録がある（どちらの環境の決済か判断できないので処理しない） */
export class StripeEnvironmentMismatchError extends Error {
  constructor() {
    super("stripe payment belongs to another environment but a record exists here");
    this.name = "StripeEnvironmentMismatchError";
  }
}

/**
 * expectedPaymentIntentId … 先着の返金・異議申し立ての通知から確定するとき（confirmBeforeSync）に、通知の対象の PaymentIntent を渡す。
 * Session の PaymentIntent が違えば、検証・返金と異議申し立ての読み取り・書き込みの前に rejected（payment_intent_mismatch）を返す
 * （通知の対象ではない別の決済を確定しない。Session が未払いでも「確定待ち」にせず不一致として扱う）。通常の確定では渡さない
 * requireExistingTransaction … 決済記録の再確認の自動の回収（recheck-recovery.ts）から呼ぶとき。決済記録が無ければ新しく作らず、
 * rejected（transaction_missing）を返す（回収は決済記録がある決済だけを扱い、記録の作成・権利の付与はしない）
 */
export async function confirmStripeCheckout(
  sessionId: string,
  rt?: StripeRuntime,
  opts: { expectedPaymentIntentId?: string; requireExistingTransaction?: boolean } = {},
): Promise<StripeConfirmOutcome> {
  const r0 = rt ?? stripeRuntime();
  if (!isStripeSessionId(sessionId, r0.mode)) return { status: "rejected", reason: "invalid_session_id" };
  await ensureStripeAccount(r0); // 本番：別のアカウントのキーなら確定しない（例外。Webhook は 500 で再送）
  const session = await retrieveStripeSession(sessionId, r0);
  if (!sessionPaymentIntentMatches(session.payment_intent, opts.expectedPaymentIntentId)) {
    console.error("[stripe] payment rejected", { sessionId, reason: "payment_intent_mismatch" });
    return { status: "rejected", reason: "payment_intent_mismatch" };
  }
  const v = validateStripeSession(session, r0.mode);
  if (!v.ok) {
    if (v.status === "rejected") console.error("[stripe] payment rejected", { sessionId, reason: v.reason });
    if (v.status === "rejected" && v.paidRejection) {
      // 支払い済みなのに確定できない（許可しない支払い方法）：運営が見つけられるよう記録する。記録できなければ例外
      // （Webhook は処理済みにせず 500・Stripe が再送。戻り先・状態の確認は「確認しています」の表示のまま）。返金・付与はしない
      await recordPaidRejection(v.paidRejection, v.reason);
      return { status: "rejected", reason: v.reason, paidReview: true };
    }
    return v.status === "not_paid" ? { status: "not_paid", reason: v.reason } : { status: "rejected", reason: v.reason };
  }
  const f = v.facts;
  // 返金・異議申し立ての今の状態（取得・検証できなければ例外。決済確定を進めない）
  const pre = await readStripeChargeAdjustments({ id: f.chargeId, amount: f.amount, livemode: f.livemode }, r0);
  const state = decideConfirmState(f.amount, pre.refunds, pre.dispute, new Date());
  const ent = state.entitlement;
  const txId = stripeTransactionId(f.paymentIntentId);
  const txRef = fsdb().collection(C.transactions).doc(txId);
  const fee = f.fee ?? calcFee(f.amount, defaultFeeRateBps());
  const feeEstimated = f.fee === null;
  let outcome: StripeConfirmOutcome;
  let createdHere = false; // この呼び出しで決済記録を作成したか（トランザクションのやり直しのたびに初期化）
  let recheckPending = false; // 確定済みの決済記録の再確認が未完了か（同上）
  // 別の環境（同じ Sandbox を使う別の Firestore）で作った Session か（metadata の環境を表す値が確かに違うときだけ。値が無ければ今までどおり）
  const otherEnv = isOtherStripeEnv(f.envTag, r0);
  try {
    outcome = await fsdb().runTransaction(async (tx): Promise<StripeConfirmOutcome> => {
      createdHere = false;
      recheckPending = false;
      const [coSnap, existing] = await Promise.all([tx.get(checkoutRef(f.checkoutId)), tx.get(txRef)]);
      if (otherEnv) {
        // この環境に注文・決済記録が無ければ、別の環境の決済（何も書かない。売上・権利に関わらない）。
        // あれば食い違い（設定の誤りなど）：判断せずに例外（Webhook は処理済みにせず 500。運営が決済監視で気付く）
        if (coSnap.exists || existing.exists) throw new StripeEnvironmentMismatchError();
        return { status: "rejected", reason: "other_environment" } as const;
      }
      if (existing.exists) {
        // 確定済み（Webhook の再送・戻り先の再読み込みなど）。作成の後の再確認が未完了なら、この後で再確認する
        recheckPending = recheckStateOf(existing.get("recheckState")) === RECHECK_PENDING;
        // 確定済み。手数料が推定値のままで、確定値が取れていれば直す
        if (existing.get("feeEstimated") === true && f.fee !== null) {
          tx.update(txRef, { paymentFee: f.fee, feeEstimated: false, stripeBalanceTransactionId: f.balanceTransactionId, updatedAt: FieldValue.serverTimestamp() });
        }
        // 返金済み・チャージバックで確定した注文は、占いへ進めない
        if (coSnap.get("status") === "REFUNDED") return { status: "refunded", transactionId: txId, refundReason: refundReasonOf(coSnap.get("refundReason")) } as const;
        return { status: "duplicate", transactionId: txId } as const;
      }
      // 自動の回収：決済記録が無いのは異常（作成しない）
      if (opts.requireExistingTransaction) return { status: "rejected", reason: "transaction_missing" } as const;
      if (!coSnap.exists) return { status: "rejected", reason: "unknown_checkout" } as const;
      const co = coSnap.data()!;
      if (co.provider !== STRIPE_PROVIDER) return { status: "rejected", reason: "provider_mismatch" } as const;
      if (co.providerPaymentId !== f.sessionId) return { status: "rejected", reason: "session_not_linked" } as const;
      // 注文に記録したモードと、決済のモードが一致すること（記録が無い古い注文は、Session の ID の形で確認済み）
      if (typeof co.stripeLivemode === "boolean" && co.stripeLivemode !== f.livemode) return { status: "rejected", reason: "mode_mismatch" } as const;
      if (co.status === "SUCCEEDED") return { status: "rejected", reason: "checkout_already_succeeded" } as const; // 1注文につき1決済
      if (co.status === "REFUNDED") return { status: "rejected", reason: "checkout_refunded" } as const; // 返金済み・チャージバックの注文に別の決済を記録しない
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
        paymentStatus: state.paymentStatus,
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
        // 確定の前からある返金・異議申し立て（確定の後に通知が届いたときと同じ項目・値）
        ...state.fields,
        ...salesKeys(f.storeId, STRIPE_PROVIDER, state.paymentStatus, f.paidAt, f.livemode),
        // 手数料の集計（返金済み・チャージバックで確定した決済も含める。この後の返金・異議申し立てでも変えない）
        ...feeKeys(f.storeId, STRIPE_PROVIDER, f.paidAt, f.livemode),
        // 作成の後の再確認（recheckStripePayment）が完了するまで PENDING。作成と同じトランザクションで保存するので、
        // 作成の直後に処理が止まっても PENDING が残り、同じ決済の次の決済確定（Webhook の再送など）で再確認する
        recheckState: RECHECK_PENDING,
        recheckAttempts: 0,
        recheckLastAttemptAt: null,
        recheckLastError: null,
        recheckDoneAt: null,
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      });
      tx.create(fsdb().collection(C.fortuneSessions).doc(txId), {
        transactionId: txId,
        storeId: f.storeId,
        fortuneType: f.fortuneType,
        tokenHash: String(co.accessTokenHash),
        // 返金・異議申し立ての敗訴があれば、最初から止めた状態で作る（一瞬も PAID にしない）
        status: ent.grant ? "PAID" : "EXPIRED",
        ...(ent.grant ? {} : { suspendedByRefund: ent.suspendedByRefund, suspendedByDispute: ent.suspendedByDispute, suspendedAt: new Date() }),
        expiresAt: new Date(Date.now() + FORTUNE_SESSION_TTL_MS),
        usedAt: null,
        createdAt: FieldValue.serverTimestamp(),
      });
      tx.update(checkoutRef(f.checkoutId), { status: ent.checkoutStatus, refundReason: ent.refundReason, providerPaymentKey: txId, failureCode: null, updatedAt: FieldValue.serverTimestamp() });
      // 店舗の最終利用日は、売上に数える決済（本番の決済）だけで更新する（テスト決済・返金済みの決済では更新しない）
      if (ent.grant && isSalesPayment(STRIPE_PROVIDER, f.livemode)) {
        const lastUsed = toDate(st.get("lastUsedAt"));
        if (!lastUsed || lastUsed < f.paidAt) tx.update(stRef, { lastUsedAt: f.paidAt });
      }
      createdHere = true;
      return ent.grant ? ({ status: "confirmed", transactionId: txId } as const) : ({ status: "refunded", transactionId: txId, refundReason: ent.refundReason } as const);
    });
  } catch (e) {
    if (!isAlreadyExists(e)) throw e;
    // 同時に別の処理（Webhook と戻り先など）が先に作成した場合。その決済記録の再確認が未完了なら、ここでも再確認する
    // （先に作成した処理が再確認の前に止まっても、取りこぼさない。再確認は何度実行しても二重に反映しない）
    const created = await txRef.get();
    if (recheckStateOf(created.get("recheckState")) !== RECHECK_PENDING) return { status: "duplicate", transactionId: txId };
    return { status: "duplicate", transactionId: txId, recheck: await recheckStripePayment(txId, f, r0) };
  }
  // Stripe では支払い済み（金額・metadata・PaymentIntent・Charge を検証済み）なのに、注文・店舗の記録と照合できず確定しなかった：
  // 運営が見つけられるよう決済要確認・決済監視に記録する（記録できなければ例外。Webhook は 500 で Stripe が再送）。
  // 通常の確定だけが対象（自動の回収・先着の返金と異議申し立ての通知からの確定は、それぞれの仕組みで記録する）。
  // この環境で作った Session（metadata の環境を表す値がこの環境と同じ）だけ。値が無い以前の Session は、同じ Sandbox を使う別の環境の
  // 決済かもしれないので、今までどおり（記録せず処理済み）
  if (
    outcome.status === "rejected" &&
    PAID_UNCONFIRMABLE_REASONS.has(outcome.reason) &&
    !opts.requireExistingTransaction &&
    !opts.expectedPaymentIntentId &&
    f.envTag !== null &&
    f.envTag === r0.envTag
  ) {
    console.error("[stripe] paid payment could not be confirmed", { sessionId, reason: outcome.reason });
    await recordPaidUnconfirmable(f, outcome.reason, r0);
    return { status: "rejected", reason: outcome.reason, paidReview: true, ...(RETRYABLE_UNCONFIRMABLE_REASONS.has(outcome.reason) ? { retryable: true as const } : {}) };
  }
  if (createdHere) {
    if (!ent.grant) console.warn("[stripe] payment confirmed with a refund or chargeback (entitlement not granted)", { sessionId, reason: ent.refundReason });
    await r0.testHooks?.afterConfirmCommit?.(txId);
  } else if (!recheckPending) {
    return outcome;
  }
  // 作成の後（または未完了の決済記録）に Stripe の状態を読み直す（読んだ後から作成までの間の返金・異議申し立てを取りこぼさない）
  return { ...outcome, recheck: await recheckStripePayment(txId, f, r0) };
}

type RecheckFacts = { sessionId: string; chargeId: string; amount: number; livemode: boolean; storeId: string; checkoutId: string };

/**
 * 決済記録の作成の後の再確認（recheckState が PENDING の決済記録だけ）。
 *  1) 決済記録を読み、PENDING であることを確かめる（この後の Stripe の読み取りは、決済記録の作成より後であることが保証される）
 *  2) Stripe から返金・異議申し立ての今の状態を読み、検証する
 *  3) 決済記録の今の状態（キー）と違えば、反映の処理（syncStripeRefunds・syncStripeDispute）で取り直して反映する
 *  4) 2・3 がすべて成功し、反映しなかった結果（照合できない・対象外）も無ければ、DONE にする（まだ PENDING のときだけ）
 * 2〜4 のどこかで失敗したら PENDING のまま（回数・最後のエラーの名前だけを記録）。例外は握りつぶして DONE にしない。
 * 反映の処理は Stripe から最新の状態を取り直し、決済記録のキーと比べて書き込むので、何度・同時に実行しても二重に反映しない
 * （同時に届いた Webhook が先に反映していれば何もしない。結果が出た異議申し立てを対応中に戻さない）。
 * 1 の後に起きた返金・異議申し立ては、決済記録がある状態で通知が届くので、通常の反映の処理で反映される。
 * 決済記録はもう作成済みなので、失敗しても確定は取り消さない（サーバーのログと決済監視に記録する）。
 */
async function recheckStripePayment(txId: string, f: RecheckFacts, r0: StripeRuntime): Promise<RecheckRun> {
  const txRef = fsdb().collection(C.transactions).doc(txId);
  const cur = await txRef.get();
  if (!cur.exists || recheckStateOf(cur.get("recheckState")) !== RECHECK_PENDING) return "not_pending";
  let error: string | null;
  try {
    const now = await readStripeChargeAdjustments({ id: f.chargeId, amount: f.amount, livemode: f.livemode }, r0);
    const outcomes: string[] = [];
    if (now.refunds.state !== "none" && refundKeyOf(now.refunds) !== cur.get("refundKey")) outcomes.push(await syncStripeRefunds(f.chargeId, r0, "confirm_recheck", undefined, { confirmFirst: false }));
    if (now.dispute && disputeKeyOf(now.dispute) !== cur.get("disputeKey")) outcomes.push(await syncStripeDispute(now.dispute.id, r0, "confirm_recheck", undefined, { confirmFirst: false }));
    error = recheckFailureOf(outcomes);
  } catch (e) {
    error = errorNameOf(e);
  }
  if (error === null) {
    try {
      await fsdb().runTransaction(async (tx) => {
        const t = await tx.get(txRef);
        if (recheckStateOf(t.get("recheckState")) !== RECHECK_PENDING) return; // 同時の再確認が先に完了した
        tx.update(txRef, { recheckState: RECHECK_DONE, recheckAttempts: FieldValue.increment(1), recheckLastAttemptAt: new Date(), recheckLastError: null, recheckDoneAt: FieldValue.serverTimestamp() });
      });
      return "done";
    } catch (e) {
      error = errorNameOf(e); // 完了の記録に失敗：PENDING のまま（次の再確認でやり直す）
    }
  }
  console.error("[stripe] recheck after confirmation failed", { sessionId: f.sessionId, error });
  try {
    await fsdb().runTransaction(async (tx) => {
      const t = await tx.get(txRef);
      if (recheckStateOf(t.get("recheckState")) !== RECHECK_PENDING) return;
      tx.update(txRef, { recheckAttempts: FieldValue.increment(1), recheckLastAttemptAt: new Date(), recheckLastError: error });
    });
  } catch (e) {
    console.error("[stripe] recording the recheck failure failed", { sessionId: f.sessionId, error: errorNameOf(e) }); // PENDING は残る
  }
  await recordPaymentAlert({ kind: "refund_sync_failed", objectType: "transaction", objectId: txId, transactionId: txId, checkoutId: f.checkoutId, storeId: f.storeId, mode: alertModeOf(f.livemode), errorName: error });
  return "pending";
}

/** ログ・記録に残すエラーの名前（英数字と記号だけ。エラー文・秘密情報は含めない） */
const errorNameOf = (e: unknown) => {
  const n = (e as Error)?.name;
  return typeof n === "string" && /^[\w.\-]{1,60}$/.test(n) ? n : "Error";
};

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

export type StripeRefundOutcome = "refund_pending" | "refunded" | "partial" | "refund_failed" | "unchanged" | "ignored" | "ignored_other_env" | "rejected";

const idOfRef = (v: unknown): string | null => (typeof v === "string" ? v : v && typeof v === "object" && typeof (v as { id?: unknown }).id === "string" ? (v as { id: string }).id : null);

type TxOutcome<T extends string> = { outcome: T; review?: PaymentReviewInput; /** 決済記録が無かった（先着の通知の可能性） */ missingTransaction?: true };

/**
 * 返金・異議申し立ての反映の設定。
 *  confirmFirst … 決済記録が無く、このアプリの注文の決済なら、先に決済の確定を試みてから1回だけ反映し直す（既定 true。課題2・対策A）。
 *                 決済の確定の中の再確認・運営の権利の復旧・やり直しの反映では false（確定を入れ子にしない。回数を限る）
 */
export type StripeSyncOptions = { confirmFirst?: boolean };

/** 先着の通知のために試みた決済の確定が、Stripe 側でまだ進められない（支払いの確定待ち）。Webhook は 500 を返し、Stripe の再送でやり直す */
export class StripeConfirmNotReadyError extends Error {
  constructor(readonly reason: string) {
    super(`stripe payment cannot be confirmed yet (${reason})`);
    this.name = "StripeConfirmNotReadyError";
  }
}

/**
 * 決済記録が無いときに届いた返金・異議申し立ての通知のために、先に決済の確定を試みる（課題2・対策A）。
 *  - 注文（PaymentIntent の metadata の注文ID）を読み、紐付いた Session で confirmStripeCheckout を呼ぶ。
 *    確定は Stripe から返金・異議申し立ての今の状態を読んでから決済記録を作り、作成の後にも再確認するので、
 *    この通知の返金・異議申し立てもその中で反映される（呼び出し側は反映を1回だけやり直して結果を決める）
 *  - 確定できた（確定済み・返金済みを含む）… "retry_sync"
 *  - 注文が無い・Session が紐付いていない・確定が拒否された … "review"（本当の異常。呼び出し側が transaction_not_found を記録する）
 *  - Stripe 側でまだ確定できない … StripeConfirmNotReadyError（500。200 で握りつぶさない）
 * Stripe API・Firestore の一時的な失敗は例外のまま返す（Webhook は 500、Stripe の再送でやり直す）。
 * Firestore のトランザクションの中では呼ばない（注文は通常の読み取り。Stripe API の呼び出しは confirmStripeCheckout がトランザクションの前に行う）。
 */
async function confirmBeforeSync(pi: { id: string; metadata: Record<string, string> | null }, r0: StripeRuntime): Promise<"retry_sync" | "review"> {
  const meta = { metadata: pi.metadata ?? {} };
  const checkoutId = checkoutIdOf(meta);
  const co = checkoutId ? await checkoutRef(checkoutId).get() : null;
  const plan = planMissingTransaction({
    ourPayment: isOurPayment(meta),
    checkoutId,
    checkout: co ? { exists: co.exists, provider: co.get("provider"), providerPaymentId: co.get("providerPaymentId") } : null,
    isSessionId: (v) => isStripeSessionId(v, r0.mode),
  });
  if (plan.kind === "skip") return "review";
  if (plan.kind === "review") {
    console.warn("[stripe] refund or dispute arrived without a payment record, and the order cannot be confirmed", { paymentIntentId: pi.id, reason: plan.reason });
    return "review";
  }
  // 通知の対象の PaymentIntent と一致する Session だけを確定する（一致しなければ rejected → 本当の異常として記録。別の決済は確定しない）
  const r = await confirmStripeCheckout(plan.sessionId, r0, { expectedPaymentIntentId: pi.id });
  const next = decideAfterConfirmForSync(r.status);
  if (next === "retryable") throw new StripeConfirmNotReadyError(r.status === "not_paid" ? r.reason : r.status);
  if (next === "review") console.warn("[stripe] refund or dispute arrived before the payment record, and the confirmation was rejected", { paymentIntentId: pi.id, reason: r.status === "rejected" ? r.reason : r.status });
  return next;
}

/**
 * 決済記録に紐付いた注文（確定のときに providerPaymentKey に決済記録の ID を入れた Stripe の注文だけ）。無ければ null。
 * 返金・異議申し立ての反映と同じトランザクションで読む（書き込みより前に読む）。
 */
async function linkedCheckoutInTx(tx: Transaction, t: DocumentSnapshot): Promise<DocumentSnapshot | null> {
  const id = t.get("checkoutId");
  if (typeof id !== "string" || !id) return null;
  const snap = await tx.get(checkoutRef(id));
  if (!snap.exists || snap.get("provider") !== STRIPE_PROVIDER || snap.get("providerPaymentKey") !== t.id) return null;
  return snap;
}

/** 反映の後の決済の状態に合わせて、注文を REFUNDED にする（決済記録・権利の更新と同じトランザクション。REFUNDED から自動では戻さない） */
function updateCheckoutAfterSync(tx: Transaction, co: DocumentSnapshot | null, after: { refundStatus: unknown; disputeStatus: unknown; entitlementActive: boolean }) {
  if (!co) return;
  const next = decideCheckoutAfterSync({ status: co.get("status"), refundReason: co.get("refundReason") }, after);
  if (next) tx.update(co.ref, { ...next, updatedAt: FieldValue.serverTimestamp() });
}

/**
 * 返金の状態を Stripe API から取り直して、決済記録と占い権利に反映する（charge.refunded・refund.* の通知から呼ばれる）。
 * 状態は返金の一覧から毎回求め直し、変わったときだけ書き込む（通知の再送・順番の入れ替わりがあっても結果は同じ。古い通知が
 * 後から届いても、Stripe API の今の状態で判断するので巻き戻らない）。
 *  - 処理中 … refundStatus=pending。未使用の権利を止める（suspendedByRefund=true）
 *  - 成功   … paymentStatus=REFUNDED。未使用の権利を止める
 *  - 一部・失敗 … refundNeedsReview=true（管理者が確認する。権利の復旧は restoreStripeEntitlement）
 * 記録と照合できないとき（店舗・金額の食い違い、記録が無い）は反映せず「決済要確認」に記録する。
 */
export async function syncStripeRefunds(chargeId: string, rt?: StripeRuntime, eventType?: string, eventId?: string, opts: StripeSyncOptions = {}): Promise<StripeRefundOutcome> {
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
  const otherEnv = isOtherStripeEnv(pi.metadata?.[STRIPE_ENV_METADATA_KEY], r0);
  const res = await fsdb().runTransaction(async (tx): Promise<TxOutcome<StripeRefundOutcome>> => {
    const [t, fs] = await Promise.all([tx.get(txRef), tx.get(sessionRef)]);
    if (otherEnv) {
      // 別の環境の決済：この環境に決済記録が無ければ何もしない（決済要確認にも記録しない）。あれば食い違いなので処理しない（例外）
      if (t.exists) throw new StripeEnvironmentMismatchError();
      return { outcome: "ignored_other_env" };
    }
    if (!t.exists) return { outcome: "ignored", missingTransaction: true, review: isOurPayment(pi) ? { kind: "transaction_not_found", objectType: "charge", objectId: charge.id, storeId: pi.metadata.storeId, ...base } : undefined };
    // 金額・店舗などが記録と一致しない返金は反映しない（売上・精算を動かさない）
    const mism = chargeMismatches(t.data()!, charge, pi);
    if (mism.length) return { outcome: "rejected", review: { kind: "charge_mismatch", objectType: "charge", objectId: charge.id, transactionId: t.id, storeId: String(t.get("storeId")), mismatches: mism, ...base } };
    const d = decideRefundSync({ paymentStatus: t.get("paymentStatus"), refundKey: t.get("refundKey") }, summary, new Date());
    if (d.kind === "unchanged") return { outcome: "unchanged" }; // 同じ状態はもう反映済み（再送・重複）
    // 書き込みの前にすべて読む（反映と不可分の決済要確認の記録も、同じトランザクションで記録するため）
    const legacyReview = legacySettlementReviewRef(txRef.id);
    const [st, legacyReviewSnap] = await Promise.all([tx.get(settlementRefForTx(t.data()!)), tx.get(legacyReview)]);
    const co = await linkedCheckoutInTx(tx, t);
    const paidAt = mustDate(t.get("paidAt"));
    const patch: Record<string, unknown> = {
      ...d.fields,
      ...(d.statusChange ? { ...d.statusChange, ...salesKeys(String(t.get("storeId")), STRIPE_PROVIDER, d.statusChange.paymentStatus, paidAt, t.get("livemode")) } : {}),
    };
    // 振込済み（確定済み）の月の取引なら、取り分の差額を調整として記録する（成功した返金の額だけ。処理中・失敗では減らさない）
    const adj = reconcileTransactionInTx(tx, txRef, t.data()!, patch, "refund", summary.refundIds.join(","), { id: st.id, data: st.data() });
    tx.update(txRef, { ...patch, ...adj.fields, updatedAt: FieldValue.serverTimestamp() });
    // 返金の処理中・成功：未使用の権利を止める（使用済みの権利はそのまま）
    if (d.suspendEntitlement && fs.exists && fs.get("status") === "PAID") {
      tx.update(sessionRef, { status: "EXPIRED", suspendedByRefund: true, suspendedAt: new Date() });
    }
    // 注文も同じトランザクションで REFUNDED にする（返金の処理中・成功・一部。返金の失敗では戻さない）
    updateCheckoutAfterSync(tx, co, { refundStatus: summary.state, disputeStatus: t.get("disputeStatus"), entitlementActive: fs.exists && fs.get("status") === "PAID" && !d.suspendEntitlement });
    const review = reviewWithinSync(tx, legacyReviewSnap, adj.review ? { ...adj.review, eventType: eventType ?? null } : undefined);
    r0.testHooks?.inSyncTransaction?.("refund", txRef.id);
    return { outcome: d.outcome, review };
  });
  await r0.testHooks?.afterSyncCommit?.("refund", txRef.id);
  // 決済記録が無い（決済の確定より先に届いた通知の可能性）：このアプリの注文の決済なら、先に確定を試みて、反映を1回だけやり直す。
  // 確定できなければ本当の異常として、下で transaction_not_found を記録する（一時的な失敗は例外で 500）
  if (res.missingTransaction && res.review && opts.confirmFirst !== false && (await confirmBeforeSync(pi, r0)) === "retry_sync") {
    return syncStripeRefunds(chargeId, r0, eventType, eventId, { confirmFirst: false });
  }
  // 反映を伴わない決済要確認の記録（決済記録が無い・照合できない）はトランザクションの後で記録する。記録が必須なので、失敗したら例外
  await recordSyncReview(res.review, r0, eventId);
  const result = res.outcome;
  if (result === "rejected") console.error("[stripe] refund does not match the recorded payment (not applied)", { chargeId: charge.id });
  if (result === "refund_failed") console.error("[stripe] refund failed (admin review required)", { chargeId: charge.id });
  if (result === "partial") console.warn("[stripe] partial refund recorded (admin review required)", { chargeId: charge.id });
  return result;
}

/**
 * 返金・異議申し立ての反映で、記録だけで異常を知らせる決済要確認（決済記録が無い・照合できない・複数の申し立て・状態の後戻り・
 * 申し立ての額の不正）を記録する。記録できなければ例外（Webhook は処理済みにせず 500 を返し、Stripe の再送で記録し直す）。
 * 通知の ID を渡すと、同じ通知では1回だけ数える（webhookEvents の recordedReviewIds。記録と同じトランザクション）。
 */
async function recordSyncReview(review: PaymentReviewInput | undefined, r0: StripeRuntime, eventId: string | undefined): Promise<void> {
  if (!review) return;
  r0.testHooks?.beforeReviewRecord?.(review.kind);
  const timeoutMs = r0.testHooks?.reviewRecordTimeoutMs;
  await recordRequiredPaymentReview(review, { ...(eventId ? { webhookEvent: { provider: "stripe", eventId } } : {}), ...(timeoutMs ? { timeoutMs } : {}) });
}

/**
 * 返金・異議申し立ての反映で、反映と不可分の決済要確認の記録（以前の仕組みで確定した精算の月の取引の変化）の参照。
 * 種類と対象（決済記録の ID）で決まるので、トランザクションの中で書き込みの前に読める。
 */
const legacySettlementReviewRef = (transactionId: string) => paymentReviewRef("legacy_settlement_change", transactionId);

/**
 * 反映の結果の決済要確認の記録を、反映と同じトランザクションで記録する（先に読んだ記録 pre と同じ記録のときだけ）。
 * 決済記録の更新（legacySettlementReview の印など）と記録が、両方とも保存されるか、両方とも保存されないかのどちらかになる。
 * 先に読んでいない記録（想定外）は、今までどおりトランザクションの後で記録するために返す。
 */
function reviewWithinSync(tx: Transaction, pre: DocumentSnapshot, review: PaymentReviewInput | undefined): PaymentReviewInput | undefined {
  if (!review) return undefined;
  if (paymentReviewRef(review.kind, review.objectId).path !== pre.ref.path) return review;
  recordPaymentReviewInTx(tx, pre, review);
  return undefined;
}

export type StripeDisputeOutcome = "dispute_open" | "dispute_won" | "dispute_lost" | "unchanged" | "ignored" | "ignored_other_env" | "rejected";

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
export async function syncStripeDispute(disputeId: string, rt?: StripeRuntime, eventType?: string, eventId?: string, opts: StripeSyncOptions = {}): Promise<StripeDisputeOutcome> {
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
  const otherEnv = isOtherStripeEnv(pi.metadata?.[STRIPE_ENV_METADATA_KEY], r0);
  const amountProblem = disputeAmountProblem(dp, charge.amount);
  if (amountProblem) {
    console.error("[stripe] dispute amount does not match the charge (not applied)", { disputeId: dp.id });
    // 別の環境の決済は、この環境の決済要確認に記録しない（反映もしない）
    if (otherEnv) return "ignored_other_env";
    if (isOurPayment(pi)) await recordSyncReview({ kind: "dispute_amount_invalid", objectType: "dispute", objectId: dp.id, storeId: pi.metadata.storeId, amount: Number.isSafeInteger(dp.amount) ? dp.amount : null, mismatches: [amountProblem], ...base }, r0, eventId);
    return "rejected";
  }
  const txRef = fsdb().collection(C.transactions).doc(stripeTransactionId(piId));
  const sessionRef = fsdb().collection(C.fortuneSessions).doc(txRef.id);
  const res = await fsdb().runTransaction(async (tx): Promise<TxOutcome<StripeDisputeOutcome> & { state?: DisputeState }> => {
    const [t, fs] = await Promise.all([tx.get(txRef), tx.get(sessionRef)]);
    if (otherEnv) {
      if (t.exists) throw new StripeEnvironmentMismatchError();
      return { outcome: "ignored_other_env" };
    }
    if (!t.exists) return { outcome: "ignored", missingTransaction: true, review: isOurPayment(pi) ? { kind: "transaction_not_found", objectType: "dispute", objectId: dp.id, storeId: pi.metadata.storeId, ...base } : undefined };
    const mism = chargeMismatches(t.data()!, charge, pi);
    if (mism.length) return { outcome: "rejected", review: { kind: "charge_mismatch", objectType: "dispute", objectId: dp.id, transactionId: t.id, storeId: String(t.get("storeId")), mismatches: mism, ...base } };
    const d = decideDisputeSync(
      {
        disputeId: t.get("disputeId"),
        disputeStatus: t.get("disputeStatus"),
        disputeKey: t.get("disputeKey"),
        paymentStatus: t.get("paymentStatus"),
        amount: t.get("amount"),
        amountRefunded: t.get("amountRefunded"),
        refundStatus: t.get("refundStatus"),
      },
      dp,
      new Date(),
    );
    // 同じ決済に別の異議申し立て（通常は起きない）：自動では反映しない
    if (d.kind === "multiple_disputes") return { outcome: "rejected", review: { kind: "multiple_disputes", objectType: "dispute", objectId: dp.id, transactionId: t.id, storeId: String(t.get("storeId")), ...base } };
    // 結果が出た申し立てを対応中に戻さない（古い状態の取り直し・順番の入れ替わり）
    if (d.kind === "regressed") return { outcome: "unchanged", review: { kind: "dispute_state_regressed", objectType: "dispute", objectId: dp.id, transactionId: t.id, storeId: String(t.get("storeId")), ...base } };
    if (d.kind === "unchanged") return { outcome: "unchanged" };
    // 書き込みの前にすべて読む（反映と不可分の決済要確認の記録も、同じトランザクションで記録するため）
    const legacyReview = legacySettlementReviewRef(txRef.id);
    const [st, legacyReviewSnap] = await Promise.all([tx.get(settlementRefForTx(t.data()!)), tx.get(legacyReview)]);
    const co = await linkedCheckoutInTx(tx, t);
    const patch: Record<string, unknown> = {
      ...d.fields,
      ...(d.statusChange ? { ...d.statusChange, ...salesKeys(String(t.get("storeId")), STRIPE_PROVIDER, d.statusChange.paymentStatus, mustDate(t.get("paidAt")), t.get("livemode")) } : {}),
    };
    const adj = reconcileTransactionInTx(tx, txRef, t.data()!, patch, "dispute", dp.id, { id: st.id, data: st.data() });
    tx.update(txRef, { ...patch, ...adj.fields, updatedAt: FieldValue.serverTimestamp() });
    // 敗訴：未使用の権利を止める（使用済みはそのまま）
    if (d.suspendEntitlement && fs.exists && fs.get("status") === "PAID") tx.update(sessionRef, { status: "EXPIRED", suspendedByDispute: true, suspendedAt: new Date() });
    // 注文も同じトランザクションで REFUNDED（chargeback）にする（勝訴では戻さない）
    updateCheckoutAfterSync(tx, co, { refundStatus: t.get("refundStatus"), disputeStatus: d.state, entitlementActive: fs.exists && fs.get("status") === "PAID" && !d.suspendEntitlement });
    const review = reviewWithinSync(tx, legacyReviewSnap, adj.review ? { ...adj.review, eventType: eventType ?? null } : undefined);
    r0.testHooks?.inSyncTransaction?.("dispute", txRef.id);
    return { outcome: d.outcome, review, state: d.state };
  });
  await r0.testHooks?.afterSyncCommit?.("dispute", txRef.id);
  // 決済記録が無い（決済の確定より先に届いた通知の可能性）：返金と同じく、先に確定を試みて、反映を1回だけやり直す
  if (res.missingTransaction && res.review && opts.confirmFirst !== false && (await confirmBeforeSync(pi, r0)) === "retry_sync") {
    return syncStripeDispute(disputeId, r0, eventType, eventId, { confirmFirst: false });
  }
  // 反映を伴わない決済要確認の記録（決済記録が無い・照合できない・複数の申し立て・状態の後戻り）はトランザクションの後で記録する。
  // 記録が必須なので、失敗したら例外
  await recordSyncReview(res.review, r0, eventId);
  const result = res.outcome;
  if (result === "rejected") console.error("[stripe] dispute does not match the recorded payment (not applied)", { disputeId: dp.id });
  if (result === "dispute_open" || result === "dispute_lost") console.warn("[stripe] dispute recorded (admin review required)", { disputeId: dp.id, state: res.state });
  return result;
}

export type StripeRefundReview = {
  transactionId: string;
  storeId: string;
  fortuneType: string;
  amount: number;
  amountRefunded: number;
  refundStatus: string;
  paymentMethod: string | null;
  paidAt: Date;
  entitlement: "suspended" | "suspended_by_dispute" | "used" | "active" | "expired" | "missing";
  /** 戻せない理由（記録の今の状態から。null なら理由を入力して戻せる。最終の判断は操作のときに Stripe の最新の状態で行う） */
  restoreBlocked: RestoreOutcomeCode | null;
};

/** 返金の確認が必要な決済（管理画面） */
export async function listStripeRefundReviews(): Promise<StripeRefundReview[]> {
  const q = await fsdb().collection(C.transactions).where("refundNeedsReview", "==", true).limit(50).get();
  const docs = q.docs.filter((d) => d.get("paymentProvider") === STRIPE_PROVIDER);
  const sessions = docs.length ? await fsdb().getAll(...docs.map((d) => fsdb().collection(C.fortuneSessions).doc(d.id))) : [];
  return docs.map((d, i) => {
    const s = sessions[i];
    const entitlement = !s?.exists ? "missing" : s.get("status") === "USED" ? "used" : s.get("status") === "PAID" ? "active" : s.get("suspendedByDispute") === true ? "suspended_by_dispute" : s.get("suspendedByRefund") === true ? "suspended" : "expired";
    // 画面の案内用（理由の入力以外の条件だけを見る）
    const pre = decideEntitlementRestore(
      {
        paymentStatus: d.get("paymentStatus"),
        refundStatus: d.get("refundStatus"),
        disputeStatus: d.get("disputeStatus"),
        entitlement: { exists: Boolean(s?.exists), status: s?.get("status"), suspendedByRefund: s?.get("suspendedByRefund"), suspendedByDispute: s?.get("suspendedByDispute"), usedAt: s?.get("usedAt") },
      },
      "(check)",
    );
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
      restoreBlocked: pre.ok ? null : pre.deny,
    };
  });
}

type Actor = { userId: string; role: "OPERATOR" };
export type RestoreOutcome = RestoreOutcomeCode;

/**
 * 返金で止めた占い権利を戻す（運営の理由付きの操作。権限の確認は呼び出し側（運営画面のサーバーの処理）で行う）。
 *  1. 決済記録が Stripe の決済で、今のモードの決済であること（別のモードは Stripe にも問い合わせない）
 *  2. 理由が入力されていること（Stripe に問い合わせる前に確かめる）
 *  3. Stripe API から Charge・PaymentIntent・返金・異議申し立ての最新の状態を取得・検証し、決済記録と一致すること
 *     （取得の失敗は stripe_unavailable、検証できない内容は stripe_unverified、食い違いは payment_mismatch。どれも戻さない）
 *  4. 最新の状態を決済記録に反映してから（syncStripeRefunds・syncStripeDispute）、1つのトランザクションで判断・書き込み：
 *     - 決済記録の状態が、3 で Stripe から確かめた状態（キー）と同じこと（途中で通知が届いて変わっていれば state_changed）
 *     - decideEntitlementRestore の条件（返金がすべて失敗・一部の返金、異議申し立てが対応中・敗訴でない、未使用、返金で止めた権利）
 *     - 権利を PAID（有効期限は今から24時間）、注文を SUCCEEDED（REFUNDED から戻すのはこの操作だけ）、監査ログ（理由・前後の状態・返金の状態と額）
 * 同じ権利を同時に・2回戻そうとしても、トランザクションの中で「返金で止めた権利」を確かめるので、成功するのは1回だけ（監査ログも1件）。
 */
export async function restoreStripeEntitlement(transactionId: string, actor: Actor, reasonInput: unknown, rt?: StripeRuntime): Promise<RestoreOutcome> {
  if (!/^stripe_[A-Za-z0-9_]{1,200}$/.test(transactionId)) return "not_eligible";
  const r0 = rt ?? stripeRuntime();
  const txRef = fsdb().collection(C.transactions).doc(transactionId);
  const first = await txRef.get();
  const chargeId = first.get("stripeChargeId");
  if (!first.exists || first.get("paymentProvider") !== STRIPE_PROVIDER || typeof chargeId !== "string") return "not_eligible";
  // 別のモードの決済（テストの環境で本番の決済など）は扱わない（Stripe にも問い合わせない）
  if (first.get("livemode") !== (r0.mode === "live")) return "not_eligible";
  const reason = normalizeRestoreReason(reasonInput);
  if (!reason) return "reason_required";
  if ([...reason].length > RESTORE_REASON_MAX) return "reason_too_long";

  // Stripe の最新の状態（取得・検証できなければ戻さない）
  let verified: { refundKey: string | null; disputeKey: string | null; disputeId: string | null };
  try {
    const charge = await retrieveStripeCharge(chargeId, r0);
    if (charge.livemode !== (r0.mode === "live")) return "not_eligible";
    const piId = idOfRef(charge.payment_intent);
    if (!piId || stripeTransactionId(piId) !== transactionId) return "payment_mismatch";
    const pi = await retrieveStripePaymentIntent(piId, r0);
    if (chargeMismatches(first.data()!, charge, pi).length) return "payment_mismatch";
    const adj = await readStripeChargeAdjustments({ id: charge.id, amount: charge.amount, livemode: charge.livemode }, r0);
    verified = { refundKey: adj.refunds.state === "none" ? null : refundKeyOf(adj.refunds), disputeKey: adj.dispute ? disputeKeyOf(adj.dispute) : null, disputeId: adj.dispute?.id ?? null };
    // 最新の状態を決済記録に反映してから判断する（Webhook が遅れていても、Stripe の今の状態で判断する）
    await syncStripeRefunds(charge.id, r0, "entitlement_restore", undefined, { confirmFirst: false });
    if (verified.disputeId) await syncStripeDispute(verified.disputeId, r0, "entitlement_restore", undefined, { confirmFirst: false });
  } catch (e) {
    if (e instanceof StripeAdjustmentsUnverifiedError) {
      console.error("[stripe] entitlement restore: refunds/disputes could not be verified", { transactionId, reason: e.reason });
      return "stripe_unverified";
    }
    console.error("[stripe] entitlement restore: Stripe check failed", { transactionId, error: (e as Error)?.name });
    return "stripe_unavailable";
  }

  const sessionRef = fsdb().collection(C.fortuneSessions).doc(transactionId);
  return fsdb().runTransaction(async (tx): Promise<RestoreOutcome> => {
    const [t, fs] = await Promise.all([tx.get(txRef), tx.get(sessionRef)]);
    if (!t.exists) return "not_eligible";
    const co = await linkedCheckoutInTx(tx, t);
    // Stripe で確かめた状態と記録が同じこと（確かめた後に通知などで変わっていれば、古い確認のまま戻さない）
    if ((t.get("refundKey") ?? null) !== verified.refundKey || (t.get("disputeKey") ?? null) !== verified.disputeKey) return "state_changed";
    // 決済記録に紐付いた注文（確定の注文）があり、占いを始められる・返金で止めた注文であること
    if (!co || (co.get("status") !== "SUCCEEDED" && co.get("status") !== "REFUNDED")) return "payment_mismatch";
    const d = decideEntitlementRestore(
      {
        paymentStatus: t.get("paymentStatus"),
        refundStatus: t.get("refundStatus"),
        disputeStatus: t.get("disputeStatus"),
        entitlement: { exists: fs.exists, status: fs.get("status"), suspendedByRefund: fs.get("suspendedByRefund"), suspendedByDispute: fs.get("suspendedByDispute"), usedAt: fs.get("usedAt") },
      },
      reason,
    );
    if (!d.ok) return d.deny;
    const now = new Date();
    const expiresAt = new Date(now.getTime() + FORTUNE_SESSION_TTL_MS);
    tx.update(sessionRef, { status: "PAID", suspendedByRefund: false, expiresAt, restoredAt: now, restoredBy: actor.userId });
    // REFUNDED から SUCCEEDED に戻すのは、この操作（理由付きの手動の復旧）だけ
    if (co.get("status") === "REFUNDED") tx.update(co.ref, { status: "SUCCEEDED", refundReason: null, updatedAt: FieldValue.serverTimestamp() });
    tx.update(txRef, { refundNeedsReview: false, refundReviewedAt: now, refundReviewResult: "entitlement_restored", updatedAt: FieldValue.serverTimestamp() });
    await writeAudit(
      {
        actorUserId: actor.userId,
        actorRole: actor.role,
        action: stripeAuditAction(t.get("livemode"), "entitlement_restored"),
        targetType: "transaction",
        targetId: transactionId,
        storeId: String(t.get("storeId")),
        before: {
          fortuneSession: fs.get("status"),
          suspendedByRefund: fs.get("suspendedByRefund") === true,
          checkout: co.get("status"),
          checkoutRefundReason: co.get("refundReason") ?? null,
          paymentStatus: t.get("paymentStatus"),
          refundStatus: t.get("refundStatus"),
          amountRefunded: Number(t.get("amountRefunded") ?? 0),
          refundPendingAmount: Number(t.get("refundPendingAmount") ?? 0),
          refundFailedAmount: Number(t.get("refundFailedAmount") ?? 0),
          disputeStatus: t.get("disputeStatus") ?? null,
        },
        after: { fortuneSession: "PAID", expiresAt: expiresAt.toISOString(), checkout: "SUCCEEDED", restoredAt: now.toISOString(), reason: d.reason, refundState: d.refundState, chargeId: t.get("stripeChargeId") },
      },
      tx,
    );
    return "restored";
  });
}

/**
 * 監査ログのイベント名：本番の決済（livemode=true）は stripe.*、それ以外（Sandbox のテスト決済・判定できない記録）は stripe_test.*
 * （以前の記録の名前は stripe_test.* のまま。監査ログの画面・検索では両方の名前を扱う）
 */
const stripeAuditAction = (livemode: unknown, name: "entitlement_restored" | "refund_review_dismissed") => (livemode === true ? `stripe.${name}` : `stripe_test.${name}`);

/** 返金の確認を終える（権利は戻さない。監査ログに残す） */
export async function dismissStripeRefundReview(transactionId: string, actor: Actor): Promise<boolean> {
  if (!/^stripe_[A-Za-z0-9_]{1,200}$/.test(transactionId)) return false;
  const txRef = fsdb().collection(C.transactions).doc(transactionId);
  return fsdb().runTransaction(async (tx) => {
    const t = await tx.get(txRef);
    if (!t.exists || t.get("paymentProvider") !== STRIPE_PROVIDER || t.get("refundNeedsReview") !== true) return false;
    tx.update(txRef, { refundNeedsReview: false, refundReviewedAt: new Date(), refundReviewResult: "dismissed", updatedAt: FieldValue.serverTimestamp() });
    await writeAudit(
      { actorUserId: actor.userId, actorRole: actor.role, action: stripeAuditAction(t.get("livemode"), "refund_review_dismissed"), targetType: "transaction", targetId: transactionId, storeId: String(t.get("storeId")), before: { refundStatus: t.get("refundStatus") }, after: null },
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
export async function confirmStripeReturn(
  token: string | null,
  sessionId: string,
  rt?: StripeRuntime,
): Promise<StripeConfirmOutcome | { status: "not_linked" } | { status: "refunded"; refundReason: CheckoutRefundReason | null }> {
  const r0 = rt ?? stripeRuntime();
  const found = await stripeCheckoutByToken(token);
  if (!found || !isStripeSessionId(sessionId, r0.mode) || found.data.providerPaymentId !== sessionId) return { status: "not_linked" };
  // 返金済み・チャージバックの注文：決済記録があっても占いの入力へ進めない
  if (found.data.status === "REFUNDED") return { status: "refunded", refundReason: refundReasonOf(found.data.refundReason) };
  return confirmStripeCheckout(sessionId, r0);
}

/**
 * Stripe では支払い済みなのに、確定を拒否した決済（validateStripeSession の paidRejection）を記録する。
 *  - 決済要確認（paid_payment_method_not_allowed・対象は Charge）… 必須。失敗したら例外
 *  - 決済監視（paid_payment_method_not_allowed・対象は注文）     … 失敗しても止めない
 * どちらも ID は種類と対象で決まる固定の値で、作成・更新は Firestore のトランザクション（別のサーバーから同時に処理されても1件）。
 * 同じ決済のくり返し（Webhook の再送・戻り先・状態の確認・運営の復旧）では回数を増やさず、確認済みを未確認に戻さない
 * （決済要確認は内容の判定のキー（種類・項目・金額）が同じ決済では変わらない。決済監視は once）。
 * 保存するのは ID・金額・モード・支払い方法の種類の名前だけ（秘密情報・カードの情報・個人情報は保存しない）。
 */
async function recordPaidRejection(p: StripePaidRejection, reason: string): Promise<void> {
  const kind = "paid_payment_method_not_allowed" as const;
  await recordRequiredPaymentReview({
    kind,
    objectType: "charge",
    objectId: p.chargeId,
    chargeId: p.chargeId,
    paymentIntentId: p.paymentIntentId,
    checkoutId: p.checkoutId,
    sessionId: p.sessionId,
    storeId: p.storeId,
    paymentMethodType: p.paymentMethodType,
    mismatches: ["payment_method"],
    amount: p.amount,
    livemode: p.livemode,
  });
  await recordPaymentAlert(
    { kind, objectType: "checkout", objectId: p.checkoutId, checkoutId: p.checkoutId, paymentIntentId: p.paymentIntentId, storeId: p.storeId, mode: alertModeOf(p.livemode), errorName: reason },
    new Date(),
    { once: true },
  );
}

/**
 * 支払い済みなのに、注文・店舗の記録と照合できずに確定を拒否した理由（confirmStripeCheckout のトランザクションの中の判定）。
 * Stripe の側（金額・metadata・PaymentIntent・Charge）は検証済みで、このアプリの決済であることは確か。
 *  unknown_checkout       … 注文が無い
 *  store_not_found        … 店舗が無い
 *  provider_mismatch・session_not_linked・mode_mismatch … 注文が別の決済（別の Session・モード）と紐付いている
 *  checkout_already_succeeded … 同じ注文が別の決済で確定済み（同じ注文に2回目の支払い）
 *  checkout_refunded      … 返金済み・チャージバックの注文に、別の支払い
 *  store_mismatch・fortune_type_mismatch・amount_mismatch … 注文と Stripe の metadata・金額が一致しない
 */
export const PAID_UNCONFIRMABLE_REASONS: ReadonlySet<string> = new Set([
  "unknown_checkout",
  "store_not_found",
  "provider_mismatch",
  "session_not_linked",
  "mode_mismatch",
  "checkout_already_succeeded",
  "checkout_refunded",
  "store_mismatch",
  "fortune_type_mismatch",
  "amount_mismatch",
]);
/** 記録が戻れば確定できる可能性がある理由（Webhook は処理済みにせず再送を待つ）。それ以外は運営の確認・返金の対応が必要（再送しても変わらない） */
export const RETRYABLE_UNCONFIRMABLE_REASONS: ReadonlySet<string> = new Set(["unknown_checkout", "store_not_found"]);

/**
 * 支払い済みなのに注文・店舗と照合できず、確定を拒否した決済を記録する（recordPaidRejection と同じ方式）。
 *  - 決済要確認（paid_checkout_unconfirmable・対象は Charge）… 必須。失敗したら例外（Webhook は 500 で再送）
 *  - 決済監視（stripe_paid_not_confirmed・対象は注文）       … 失敗しても止めない。決済監視の点検と同じ種類・対象なので1件にまとまる
 * 保存するのは Stripe の Session・PaymentIntent・Charge の ID、注文・店舗の ID（metadata の値）、金額、モード、理由の名前だけ
 * （秘密情報・カードの情報・個人情報・通知の本文・署名は保存しない）。同じ決済のくり返し（再送など）では回数を増やさない。
 */
async function recordPaidUnconfirmable(
  f: { sessionId: string; checkoutId: string; storeId: string; paymentIntentId: string; chargeId: string; amount: number; livemode: boolean },
  reason: string,
  r0: StripeRuntime,
): Promise<void> {
  r0.testHooks?.beforeReviewRecord?.("paid_checkout_unconfirmable"); // 自動テストだけ（記録の失敗の再現）
  const timeoutMs = r0.testHooks?.reviewRecordTimeoutMs;
  await recordRequiredPaymentReview({
    kind: "paid_checkout_unconfirmable",
    objectType: "charge",
    objectId: f.chargeId,
    chargeId: f.chargeId,
    paymentIntentId: f.paymentIntentId,
    checkoutId: f.checkoutId,
    sessionId: f.sessionId,
    storeId: f.storeId,
    mismatches: [reason],
    amount: f.amount,
    livemode: f.livemode,
  }, timeoutMs ? { timeoutMs } : {});
  await recordPaymentAlert(
    { kind: "stripe_paid_not_confirmed", objectType: "checkout", objectId: f.checkoutId, checkoutId: f.checkoutId, paymentIntentId: f.paymentIntentId, storeId: f.storeId, mode: alertModeOf(f.livemode), errorName: reason },
    new Date(),
    { once: true },
  );
}

const RECONCILE_AFTER_MS = 3_000;

/** 状態の確認（/api/checkout/status）。Webhook が遅れても、Stripe API で照合して進める */
export async function stripeCheckoutStatus(checkout: CheckoutLike, rt?: StripeRuntime): Promise<CheckoutStatusResult> {
  switch (checkout.status) {
    case "SUCCEEDED":
      return { status: "succeeded" };
    case "REFUNDED":
      return { status: "refunded", refundReason: refundReasonOf(checkout.refundReason) };
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
        if (outcome.status === "refunded") return { status: "refunded", refundReason: outcome.refundReason };
        if (outcome.status === "confirmed" || outcome.status === "duplicate") return { status: "succeeded" };
        // 支払い済みなのに確定できなかった決済：「請求は発生していません」とは案内しない（運営への問い合わせを案内する）
        if (outcome.status === "rejected") return { status: "failed", failureCode: outcome.paidReview ? "stripe_paid_review" : "stripe_rejected" };
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
