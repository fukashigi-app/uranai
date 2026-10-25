import "server-only";
import Stripe from "stripe";
import { CURRENCY, PRICE_JPY } from "@/config/pricing";
import { stripeTestConfig, STRIPE_TEST_DENY_MESSAGE } from "./stripe-guard";

/**
 * Stripe Checkout（Stripe の決済画面へ移動する方式）のテスト決済。Stripe 公式 SDK を使う。
 *  - テスト用キー（sk_test_）でだけ動く。条件は stripe-guard.ts（欠けていたら例外＝決済を受け付けない）
 *  - 決済の確定は、Webhook や戻り先の URL の内容を信用せず、必ず Stripe API から取り直して検証する（stripe-confirm.ts）
 *  - 支払い方法は、カード（Apple Pay・Google Pay を含む）と PayPay だけ。Session の作成時に絞り込み、確定時にも Charge で確認する
 */

export class StripeUnavailableError extends Error {
  constructor(reason: string) {
    super(`Stripe test checkout is not available: ${reason}`);
    this.name = "StripeUnavailableError";
  }
}

let cached: { key: string; client: Stripe } | null = null;

/** テスト決済が使える設定のときだけ SDK を返す。使えないときは例外（安全側） */
export function stripeClient(): Stripe {
  const cfg = stripeTestConfig();
  if (!cfg.ok) throw new StripeUnavailableError(STRIPE_TEST_DENY_MESSAGE[cfg.reason]);
  const key = `${cfg.secretKey}|${cfg.apiBase ? `${cfg.apiBase.protocol}://${cfg.apiBase.host}:${cfg.apiBase.port}` : ""}`;
  if (cached?.key === key) return cached.client;
  const client = new Stripe(cfg.secretKey, {
    maxNetworkRetries: 2,
    timeout: 20_000,
    telemetry: false,
    appInfo: { name: "uranai" },
    ...(cfg.apiBase ? { host: cfg.apiBase.host, port: cfg.apiBase.port, protocol: cfg.apiBase.protocol } : {}),
  });
  cached = { key, client };
  return client;
}

/** Webhook の署名の確認に使う秘密の値（設定が欠けていたら例外） */
export function stripeWebhookSecret(): string {
  const cfg = stripeTestConfig();
  if (!cfg.ok) throw new StripeUnavailableError(STRIPE_TEST_DENY_MESSAGE[cfg.reason]);
  return cfg.webhookSecret;
}

/** Stripe の Checkout Session の有効期限（Stripe の下限は30分）。注文の有効期限もこれに合わせる */
export const STRIPE_SESSION_TTL_MS = 31 * 60 * 1000;

/**
 * Session で使える支払い方法（allowed_payment_method_types。Stripe が自動で選ぶ候補から、この中のものだけを表示する）。
 * Apple Pay・Google Pay は Stripe ではカード（card）のウォレットとして扱われるので "card" に含まれる。
 * payment_method_types（API バージョン 2026-09-30.endive 以降は使えない）や payment_method_configuration とは併用しない。
 */
export const STRIPE_ALLOWED_PAYMENT_METHOD_TYPES = ["card", "paypay"] as const;

/** 受け付ける支払い方法（決済記録に残す） */
export type StripePaymentMethod = "card" | "apple_pay" | "google_pay" | "paypay";

export type StripeSessionInput = {
  checkoutId: string;
  storeId: string;
  fortuneType: string;
  productName: string;
  /** 戻り先のサイトの URL（https。ローカルの自動テストだけ http を許可） */
  origin: string;
  expiresAt: Date;
};

/**
 * Checkout Session を作成する。冪等キーは注文IDから作るので、同じ注文で何度呼んでも同じ Session が返る
 * （画面の連打・通信の再試行で Session が増えない）。注文IDは metadata と client_reference_id の両方に入れる。
 */
export async function createStripeCheckoutSession(input: StripeSessionInput): Promise<{ id: string; url: string }> {
  const cfg = stripeTestConfig();
  if (!cfg.ok) throw new StripeUnavailableError(STRIPE_TEST_DENY_MESSAGE[cfg.reason]);
  const origin = new URL(input.origin);
  if (origin.protocol !== "https:" && !(cfg.mode === "local" && origin.protocol === "http:")) throw new Error("checkout origin must be https");
  const metadata = { checkoutId: input.checkoutId, storeId: input.storeId, fortuneType: input.fortuneType };
  const session = await stripeClient().checkout.sessions.create(
    {
      mode: "payment",
      locale: "ja",
      submit_type: "pay",
      line_items: [{ quantity: 1, price_data: { currency: CURRENCY, unit_amount: PRICE_JPY, product_data: { name: input.productName.slice(0, 120) } } }],
      client_reference_id: input.checkoutId,
      metadata,
      payment_intent_data: { metadata },
      success_url: `${origin.origin}/payment/return?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${origin.origin}/payment?canceled=1`,
      expires_at: Math.floor(input.expiresAt.getTime() / 1000),
      allowed_payment_method_types: [...STRIPE_ALLOWED_PAYMENT_METHOD_TYPES],
    },
    { idempotencyKey: `uranai-checkout-${input.checkoutId}` },
  );
  if (!session.id.startsWith("cs_test_") || session.livemode || !session.url) throw new Error("unexpected checkout session");
  if (session.client_reference_id !== input.checkoutId || session.metadata?.checkoutId !== input.checkoutId) throw new Error("checkout session is not linked to the order");
  // Stripe が実際に表示する支払い方法がカード・PayPay の範囲に収まっているか（絞り込みが効いていなければ、決済画面に移動させない）
  const allowed = new Set<string>(STRIPE_ALLOWED_PAYMENT_METHOD_TYPES);
  if (!Array.isArray(session.payment_method_types) || session.payment_method_types.length === 0 || session.payment_method_types.some((t) => !allowed.has(t))) {
    throw new Error("checkout session offers unexpected payment methods");
  }
  return { id: session.id, url: session.url };
}

/** 決済の確認に必要な情報を Stripe API から取り直す（PaymentIntent・Charge・手数料の明細まで） */
export async function retrieveStripeSession(sessionId: string): Promise<Stripe.Checkout.Session> {
  if (!isStripeTestSessionId(sessionId)) throw new Error("invalid test session id");
  return stripeClient().checkout.sessions.retrieve(sessionId, { expand: ["payment_intent.latest_charge.balance_transaction"] });
}

export async function retrieveStripeCharge(chargeId: string): Promise<Stripe.Charge> {
  if (!/^(ch|py)_[A-Za-z0-9_]{1,200}$/.test(chargeId)) throw new Error("invalid charge id");
  return stripeClient().charges.retrieve(chargeId, { expand: ["balance_transaction"] });
}

/** Charge の返金の一覧（返金の状態は、通知の中身ではなくこの一覧から判断する） */
export async function listStripeRefunds(chargeId: string): Promise<Stripe.Refund[]> {
  if (!/^(ch|py)_[A-Za-z0-9_]{1,200}$/.test(chargeId)) throw new Error("invalid charge id");
  const page = await stripeClient().refunds.list({ charge: chargeId, limit: 100 });
  if (page.has_more) throw new Error("too many refunds"); // 100円の商品では起きない。取りこぼすくらいなら処理しない
  return page.data;
}

export const isStripeTestSessionId = (v: unknown): v is string => typeof v === "string" && /^cs_test_[A-Za-z0-9_]{1,200}$/.test(v);

export type StripePaymentFacts = {
  sessionId: string;
  checkoutId: string;
  storeId: string;
  fortuneType: string;
  amount: number;
  paymentIntentId: string;
  chargeId: string;
  paidAt: Date;
  /** Stripe の手数料（円）。まだ確定していなければ null（推定値を使い、確定後に更新する） */
  fee: number | null;
  balanceTransactionId: string | null;
  refunded: boolean;
  paymentMethod: StripePaymentMethod;
};

export type StripeValidation = { ok: true; facts: StripePaymentFacts } | { ok: false; status: "not_paid" | "rejected"; reason: string };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FORTUNE_TYPES = new Set(["BIRTHDAY", "ZODIAC", "BLOOD"]);

const idOf = (v: unknown): string | null => (typeof v === "string" ? v : v && typeof v === "object" && typeof (v as { id?: unknown }).id === "string" ? (v as { id: string }).id : null);

/**
 * Stripe API から取り直した Session を検証する（Firestore には触れない純粋な処理）。
 * テスト決済であること・支払い済み・通貨・金額・注文ID・店舗ID・占いの種類・PaymentIntent・Charge を確認する。
 */
export function validateStripeSession(session: Stripe.Checkout.Session): StripeValidation {
  if (session.object !== "checkout.session" || !isStripeTestSessionId(session.id)) return { ok: false, status: "rejected", reason: "not_test_session" };
  if (session.livemode) return { ok: false, status: "rejected", reason: "livemode" };
  if (session.mode !== "payment") return { ok: false, status: "rejected", reason: "mode" };
  if (session.status !== "complete" || session.payment_status !== "paid") return { ok: false, status: "not_paid", reason: `session_${session.status}_${session.payment_status}` };
  if (session.currency !== CURRENCY) return { ok: false, status: "rejected", reason: "currency_mismatch" };
  if (session.amount_total !== PRICE_JPY) return { ok: false, status: "rejected", reason: "amount_mismatch" };
  const md = session.metadata ?? {};
  const checkoutId = md.checkoutId ?? "";
  if (!UUID_RE.test(checkoutId) || session.client_reference_id !== checkoutId) return { ok: false, status: "rejected", reason: "checkout_id_mismatch" };
  const storeId = md.storeId ?? "";
  const fortuneType = md.fortuneType ?? "";
  if (!storeId || !FORTUNE_TYPES.has(fortuneType)) return { ok: false, status: "rejected", reason: "metadata_invalid" };

  const pi = session.payment_intent;
  if (!pi || typeof pi === "string") return { ok: false, status: "rejected", reason: "payment_intent_not_expanded" };
  if (pi.livemode) return { ok: false, status: "rejected", reason: "livemode" };
  if (pi.status !== "succeeded") return { ok: false, status: "not_paid", reason: `payment_intent_${pi.status}` };
  if (pi.currency !== CURRENCY || pi.amount !== PRICE_JPY || pi.amount_received !== PRICE_JPY) return { ok: false, status: "rejected", reason: "amount_mismatch" };
  const pmd = pi.metadata ?? {};
  if (pmd.checkoutId !== checkoutId || pmd.storeId !== storeId || pmd.fortuneType !== fortuneType) return { ok: false, status: "rejected", reason: "payment_intent_metadata_mismatch" };

  const charge = pi.latest_charge;
  if (!charge || typeof charge === "string") return { ok: false, status: "rejected", reason: "charge_not_expanded" };
  if (charge.livemode || charge.status !== "succeeded" || !charge.paid || !charge.captured) return { ok: false, status: "not_paid", reason: "charge_not_captured" };
  if (charge.currency !== CURRENCY || charge.amount !== PRICE_JPY || idOf(charge.payment_intent) !== pi.id) return { ok: false, status: "rejected", reason: "charge_mismatch" };
  // カード（Apple Pay・Google Pay を含む）と PayPay だけを受け付ける（Session で絞り込んでいるが、確定時にも確認する）
  const paymentMethod = paymentMethodOf(charge);
  if (!paymentMethod) return { ok: false, status: "rejected", reason: "payment_method_not_allowed" };

  const { fee, balanceTransactionId } = feeOf(charge);
  return {
    ok: true,
    facts: {
      sessionId: session.id,
      checkoutId,
      storeId,
      fortuneType,
      amount: PRICE_JPY,
      paymentIntentId: pi.id,
      chargeId: charge.id,
      paidAt: new Date(charge.created * 1000),
      fee,
      balanceTransactionId,
      refunded: charge.refunded || charge.amount_refunded > 0,
      paymentMethod,
    },
  };
}

/** Charge の支払い方法。受け付けない方法（Link・Samsung Pay など他のウォレット、カード・PayPay 以外）は null */
export function paymentMethodOf(charge: Stripe.Charge): StripePaymentMethod | null {
  const d = charge.payment_method_details;
  if (d?.type === "paypay") return "paypay";
  if (d?.type !== "card" || !d.card) return null;
  const wallet = d.card.wallet;
  if (!wallet) return "card";
  if (wallet.type === "apple_pay") return "apple_pay";
  if (wallet.type === "google_pay") return "google_pay";
  return null;
}

/**
 * 支払いがまだ確定していない Session の状態（注文を閉じてよいかの判断に使う。Stripe API から取り直した Session で判断する）
 *  - awaiting  … 支払い手続きは終わったが、Stripe 側で確定待ち（PayPay などの非同期の支払い）。権利は付与しないが、注文は閉じない
 *  - retryable … まだ決済画面で支払い直せる（カードが拒否された・requires_payment_method など）。注文は閉じない
 *  - failed_candidate … 手続きは終わったが支払われていない。Stripe の「非同期の支払いの失敗」の通知があったときだけ失敗にする
 *  - canceled  … PaymentIntent が取り消された（最終）
 *  - expired   … Session が期限切れで、支払いも進んでいない（最終）
 *  - paid      … 支払い済み（確定処理は validateStripeSession で行う）
 */
export type StripeSessionState = "paid" | "awaiting" | "retryable" | "failed_candidate" | "canceled" | "expired";

export function stripeSessionState(session: Stripe.Checkout.Session): StripeSessionState {
  const pi = session.payment_intent && typeof session.payment_intent === "object" ? session.payment_intent : null;
  if (session.payment_status === "paid" || pi?.status === "succeeded") return "paid";
  if (pi?.status === "processing") return "awaiting";
  if (pi?.status === "canceled") return "canceled";
  if (session.status === "expired") return "expired";
  if (session.status === "open") return "retryable";
  // status === "complete" で未払い
  if (pi && ["requires_action", "requires_confirmation", "requires_capture"].includes(pi.status)) return "awaiting";
  return "failed_candidate";
}

/** 返金の状態（Stripe API の返金の一覧から求める） */
export type StripeRefundState = "none" | "pending" | "succeeded" | "partial" | "failed";

export type StripeRefundSummary = { state: StripeRefundState; succeededAmount: number; pendingAmount: number; failedAmount: number; refundIds: string[] };

/**
 * 返金の状態をまとめる（純粋な処理）。
 *  - succeeded … 返金が成功し、合計が決済額に達した
 *  - pending   … 返金の処理中（pending・requires_action）がある
 *  - partial   … 一部だけ返金が成功した（100円の商品では想定しない。管理者が確認する）
 *  - failed    … 返金がすべて失敗・取り消し（failed・canceled）。管理者が確認する
 */
export function summarizeRefunds(chargeId: string, amount: number, refunds: Stripe.Refund[]): StripeRefundSummary {
  let succeededAmount = 0;
  let pendingAmount = 0;
  let failedAmount = 0;
  const refundIds: string[] = [];
  for (const r of refunds) {
    if (idOf(r.charge) !== chargeId || r.currency !== CURRENCY || !Number.isSafeInteger(r.amount) || r.amount <= 0) continue;
    refundIds.push(r.id);
    if (r.status === "succeeded") succeededAmount += r.amount;
    else if (r.status === "pending" || r.status === "requires_action") pendingAmount += r.amount;
    else if (r.status === "failed" || r.status === "canceled") failedAmount += r.amount;
    else pendingAmount += r.amount; // 状態が不明なものは処理中とみなす（安全側：権利を止めて、確定を待つ）
  }
  refundIds.sort();
  const state: StripeRefundState =
    succeededAmount >= amount ? "succeeded" : pendingAmount > 0 ? "pending" : succeededAmount > 0 ? "partial" : failedAmount > 0 ? "failed" : "none";
  return { state, succeededAmount, pendingAmount, failedAmount, refundIds };
}

/** 手数料の確定値（Stripe の balance_transaction の fee。円・整数）。取得できなければ null */
export function feeOf(charge: Stripe.Charge): { fee: number | null; balanceTransactionId: string | null } {
  const bt = charge.balance_transaction;
  if (!bt || typeof bt === "string") return { fee: null, balanceTransactionId: typeof bt === "string" ? bt : null };
  if (bt.currency !== CURRENCY || !Number.isSafeInteger(bt.fee) || bt.fee < 0 || bt.fee > charge.amount) return { fee: null, balanceTransactionId: bt.id };
  return { fee: bt.fee, balanceTransactionId: bt.id };
}
