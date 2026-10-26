import "server-only";
import Stripe from "stripe";
import { CURRENCY, PRICE_JPY } from "@/config/pricing";
import { isLocalEmulatorTarget, stripeTestConfig, STRIPE_TEST_DENY_MESSAGE } from "./stripe-guard";

/**
 * Stripe Checkout（Stripe の決済画面へ移動する方式）。Stripe 公式 SDK を使う。
 *  - Stripe との接続は「モード」（test＝Sandbox / live＝本番）を持つ StripeRuntime で表す。照合・記録はモードに合わせて行う
 *    （Session の ID が cs_test_ / cs_live_、Session・PaymentIntent・Charge・通知の livemode がモードと一致すること）
 *  - アプリの決済の処理が使う接続は stripeRuntime() だけで、今はテスト（sk_test_）しか返さない。本番決済は未実装・無効
 *    （条件は stripe-guard.ts。欠けていたら例外＝決済を受け付けない）
 *  - 本番モードの処理は、自動テストで createSimulatedStripeRuntime（localhost の模擬 Stripe API と Firestore Emulator だけ）で確かめる
 *  - 決済の確定は、Webhook や戻り先の URL の内容を信用せず、必ず Stripe API から取り直して検証する（stripe-confirm.ts）
 *  - 支払い方法は、カード（Apple Pay・Google Pay を含む）と PayPay だけ。Session の作成時に絞り込み、確定時にも Charge で確認する
 */

export class StripeUnavailableError extends Error {
  constructor(reason: string) {
    super(`Stripe checkout is not available: ${reason}`);
    this.name = "StripeUnavailableError";
  }
}

export type StripeMode = "test" | "live";

/** Stripe との接続（モード・SDK・Webhook の署名の値）。モードは作成時に決まり、変えられない */
export type StripeRuntime = {
  readonly mode: StripeMode;
  readonly client: Stripe;
  readonly webhookSecret: string;
  /** 戻り先に http を許すか（ローカルの自動テストだけ） */
  readonly allowHttpOrigin: boolean;
};

type ApiBase = { host: string; port: number; protocol: "http" | "https" };

function newClient(secretKey: string, apiBase: ApiBase | null): Stripe {
  return new Stripe(secretKey, {
    maxNetworkRetries: 2,
    timeout: 20_000,
    telemetry: false,
    appInfo: { name: "uranai" },
    ...(apiBase ? { host: apiBase.host, port: apiBase.port, protocol: apiBase.protocol } : {}),
  });
}

let cached: { key: string; runtime: StripeRuntime } | null = null;

/**
 * アプリの決済の処理が使う Stripe との接続。今はテスト（Sandbox）だけを返す（本番決済は未実装・無効。段階を分けて有効にする）。
 * 使えない設定のときは例外（安全側）。
 */
export function stripeRuntime(): StripeRuntime {
  const cfg = stripeTestConfig();
  if (!cfg.ok) throw new StripeUnavailableError(STRIPE_TEST_DENY_MESSAGE[cfg.reason]);
  const key = `test|${cfg.secretKey}|${cfg.webhookSecret}|${cfg.apiBase ? `${cfg.apiBase.protocol}://${cfg.apiBase.host}:${cfg.apiBase.port}` : ""}`;
  if (cached?.key === key) return cached.runtime;
  const runtime: StripeRuntime = { mode: "test", client: newClient(cfg.secretKey, cfg.apiBase), webhookSecret: cfg.webhookSecret, allowHttpOrigin: cfg.mode === "local" };
  cached = { key, runtime };
  return runtime;
}

const LOOPBACK = new Set(["localhost", "127.0.0.1"]);

/**
 * 自動テスト専用：localhost の模擬 Stripe API に接続する Stripe との接続を作る（本番モードの照合・記録を確かめるため）。
 * 次のすべてを満たさなければ例外。本物の Stripe・本番の Firebase には接続できない。
 *  - Vercel 上ではない（VERCEL_ENV が無い）
 *  - Firestore Emulator（localhost）の demo- プロジェクト
 *  - 接続先が http(s)://localhost または 127.0.0.1
 *  - キーの形がモードと一致（形だけの偽物を使う）
 */
export function createSimulatedStripeRuntime(
  mode: StripeMode,
  opts: { apiBase: string; secretKey: string; webhookSecret: string },
  e: Record<string, string | undefined> = process.env,
): StripeRuntime {
  if (e.VERCEL_ENV) throw new StripeUnavailableError("simulated runtime is for local automated tests only");
  if (!isLocalEmulatorTarget(e) || !(e.FIREBASE_PROJECT_ID ?? "").startsWith("demo-")) throw new StripeUnavailableError("simulated runtime requires the local Firestore emulator (demo- project)");
  const u = new URL(opts.apiBase);
  if (!LOOPBACK.has(u.hostname) || !["http:", "https:"].includes(u.protocol) || u.pathname !== "/") throw new StripeUnavailableError("simulated runtime must use a localhost API");
  if (!opts.secretKey.startsWith(`sk_${mode}_`) || !opts.webhookSecret.startsWith("whsec_")) throw new StripeUnavailableError("simulated runtime key does not match the mode");
  const protocol = u.protocol === "https:" ? "https" : "http";
  const apiBase = { host: u.hostname, port: Number(u.port || (protocol === "https" ? 443 : 80)), protocol } as const;
  return { mode, client: newClient(opts.secretKey, apiBase), webhookSecret: opts.webhookSecret, allowHttpOrigin: true };
}

/** Stripe の Checkout Session の有効期限（Stripe の下限は作成から30分）。注文の有効期限もこれに合わせる */
export const STRIPE_SESSION_TTL_MS = 31 * 60 * 1000;

/**
 * Session の有効期限（Session を作る時刻が基準。Stripe は「作成から30分〜24時間後」だけを受け付ける）。
 * 分単位に切り上げるので、同じ分のうちの連打では同じ値になり、冪等キーも同じになる（Session が増えない）。
 */
export function stripeSessionExpiry(now: number = Date.now()): Date {
  return new Date(Math.ceil((now + STRIPE_SESSION_TTL_MS) / 60_000) * 60_000);
}

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
  /** Session の有効期限（stripeSessionExpiry。Session を作る時刻から30分より後） */
  expiresAt: Date;
};

/**
 * Checkout Session を作成する。冪等キーは注文IDと有効期限から作るので、同じ注文・同じ期限で何度呼んでも同じ Session が返る
 * （画面の連打・通信の再試行で Session が増えない。期限が変われば別の要求になり、冪等キーの食い違いのエラーにならない）。
 * 注文IDは metadata と client_reference_id の両方に入れる。
 *
 * Managed Payments（Stripe が販売者になる仕組み）は使わない。このアプリは運営が販売者で、店舗の取り分はアプリ内で計算・記録し、
 * 運営が銀行振込する。アカウントの既定で有効になっていても、Session ごとに managed_payments.enabled=false を明示する。
 */
export async function createStripeCheckoutSession(input: StripeSessionInput, rt: StripeRuntime = stripeRuntime()): Promise<{ id: string; url: string; expiresAt: Date }> {
  const origin = new URL(input.origin);
  if (origin.protocol !== "https:" && !(rt.allowHttpOrigin && origin.protocol === "http:")) throw new Error("checkout origin must be https");
  const metadata = { checkoutId: input.checkoutId, storeId: input.storeId, fortuneType: input.fortuneType };
  const expiresAt = Math.floor(input.expiresAt.getTime() / 1000);
  if (expiresAt * 1000 < Date.now() + 30 * 60 * 1000) throw new Error("checkout session expiry is too early");
  const session = await rt.client.checkout.sessions.create(
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
      expires_at: expiresAt,
      allowed_payment_method_types: [...STRIPE_ALLOWED_PAYMENT_METHOD_TYPES],
      managed_payments: { enabled: false },
    },
    { idempotencyKey: `uranai-checkout-v2-${input.checkoutId}-${expiresAt}` },
  );
  // モードと違う Session（テストの環境で本番の Session など）は使わない
  if (!isStripeSessionId(session.id, rt.mode) || session.livemode !== (rt.mode === "live") || !session.url) throw new Error("unexpected checkout session");
  if (session.client_reference_id !== input.checkoutId || session.metadata?.checkoutId !== input.checkoutId) throw new Error("checkout session is not linked to the order");
  // Managed Payments が有効な Session（販売者が Stripe になる）には移動させない
  if (session.managed_payments?.enabled === true) throw new Error("checkout session uses managed payments");
  if (session.expires_at !== expiresAt) throw new Error("checkout session expiry mismatch");
  // Stripe が実際に表示する支払い方法がカード・PayPay の範囲に収まっているか（絞り込みが効いていなければ、決済画面に移動させない）
  const allowed = new Set<string>(STRIPE_ALLOWED_PAYMENT_METHOD_TYPES);
  if (!Array.isArray(session.payment_method_types) || session.payment_method_types.length === 0 || session.payment_method_types.some((t) => !allowed.has(t))) {
    throw new Error("checkout session offers unexpected payment methods");
  }
  return { id: session.id, url: session.url, expiresAt: new Date(session.expires_at * 1000) };
}

/** Stripe のエラーのうち、原因の特定に必要で秘密情報を含まない項目だけ（ログ用。エラー文は含めない） */
export function stripeErrorSummary(e: unknown): Record<string, string | number | null> {
  const x = (e ?? {}) as { name?: unknown; type?: unknown; code?: unknown; param?: unknown; statusCode?: unknown; requestId?: unknown };
  const str = (v: unknown) => (typeof v === "string" && v.length <= 120 && /^[\w.\-\[\]]+$/.test(v) ? v : null);
  return { name: str(x.name), type: str(x.type), code: str(x.code), param: str(x.param), statusCode: typeof x.statusCode === "number" ? x.statusCode : null, requestId: str(x.requestId) };
}

/** 決済の確認に必要な情報を Stripe API から取り直す（PaymentIntent・Charge・手数料の明細まで） */
export async function retrieveStripeSession(sessionId: string, rt: StripeRuntime = stripeRuntime()): Promise<Stripe.Checkout.Session> {
  if (!isStripeSessionId(sessionId, rt.mode)) throw new Error("invalid session id for this mode");
  return rt.client.checkout.sessions.retrieve(sessionId, { expand: ["payment_intent.latest_charge.balance_transaction"] });
}

export async function retrieveStripeCharge(chargeId: string, rt: StripeRuntime = stripeRuntime()): Promise<Stripe.Charge> {
  if (!/^(ch|py)_[A-Za-z0-9_]{1,200}$/.test(chargeId)) throw new Error("invalid charge id");
  return rt.client.charges.retrieve(chargeId, { expand: ["balance_transaction"] });
}

/** PaymentIntent（店舗・金額の照合に使う。metadata に注文・店舗を入れている） */
export async function retrieveStripePaymentIntent(paymentIntentId: string, rt: StripeRuntime = stripeRuntime()): Promise<Stripe.PaymentIntent> {
  if (!/^pi_[A-Za-z0-9_]{1,200}$/.test(paymentIntentId)) throw new Error("invalid payment intent id");
  return rt.client.paymentIntents.retrieve(paymentIntentId);
}

/** 異議申し立て（チャージバック）。状態・金額は通知の中身ではなく、ここで取り直した値で判断する */
export async function retrieveStripeDispute(disputeId: string, rt: StripeRuntime = stripeRuntime()): Promise<Stripe.Dispute> {
  if (!/^(dp|du)_[A-Za-z0-9_]{1,200}$/.test(disputeId)) throw new Error("invalid dispute id");
  return rt.client.disputes.retrieve(disputeId);
}

/** Charge の返金の一覧（返金の状態は、通知の中身ではなくこの一覧から判断する） */
export async function listStripeRefunds(chargeId: string, rt: StripeRuntime = stripeRuntime()): Promise<Stripe.Refund[]> {
  if (!/^(ch|py)_[A-Za-z0-9_]{1,200}$/.test(chargeId)) throw new Error("invalid charge id");
  const page = await rt.client.refunds.list({ charge: chargeId, limit: 100 });
  if (page.has_more) throw new Error("too many refunds"); // 100円の商品では起きない。取りこぼすくらいなら処理しない
  return page.data;
}

/** モードに合った Checkout Session の ID か（テストは cs_test_、本番は cs_live_） */
export const isStripeSessionId = (v: unknown, mode: StripeMode): v is string =>
  typeof v === "string" && (mode === "live" ? /^cs_live_[A-Za-z0-9_]{1,200}$/ : /^cs_test_[A-Za-z0-9_]{1,200}$/).test(v);
export const isStripeTestSessionId = (v: unknown): v is string => isStripeSessionId(v, "test");

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
  /** Stripe の値（モードと一致することを確認済み）。本番の決済だけ true（売上・精算の対象） */
  livemode: boolean;
};

export type StripeValidation = { ok: true; facts: StripePaymentFacts } | { ok: false; status: "not_paid" | "rejected"; reason: string };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FORTUNE_TYPES = new Set(["BIRTHDAY", "ZODIAC", "BLOOD"]);

const idOf = (v: unknown): string | null => (typeof v === "string" ? v : v && typeof v === "object" && typeof (v as { id?: unknown }).id === "string" ? (v as { id: string }).id : null);

/**
 * Stripe API から取り直した Session を検証する（Firestore には触れない純粋な処理）。
 * テスト決済であること・支払い済み・通貨・金額・注文ID・店舗ID・占いの種類・PaymentIntent・Charge を確認する。
 */
export function validateStripeSession(session: Stripe.Checkout.Session, mode: StripeMode = "test"): StripeValidation {
  const live = mode === "live";
  // ID の形と livemode が、実行環境から決まるモードと一致すること（テストの環境で本番の決済、本番の環境でテストの決済を記録しない）
  if (session.object !== "checkout.session" || !isStripeSessionId(session.id, mode)) return { ok: false, status: "rejected", reason: live ? "not_live_session" : "not_test_session" };
  if (session.livemode !== live) return { ok: false, status: "rejected", reason: "livemode" };
  // Managed Payments（Stripe が販売者）の決済は記録しない（このアプリは運営が販売者。店舗の取り分の前提が変わる）
  if (session.managed_payments?.enabled === true) return { ok: false, status: "rejected", reason: "managed_payments_not_allowed" };
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
  if (pi.livemode !== live) return { ok: false, status: "rejected", reason: "livemode" };
  if (pi.status !== "succeeded") return { ok: false, status: "not_paid", reason: `payment_intent_${pi.status}` };
  if (pi.currency !== CURRENCY || pi.amount !== PRICE_JPY || pi.amount_received !== PRICE_JPY) return { ok: false, status: "rejected", reason: "amount_mismatch" };
  const pmd = pi.metadata ?? {};
  if (pmd.checkoutId !== checkoutId || pmd.storeId !== storeId || pmd.fortuneType !== fortuneType) return { ok: false, status: "rejected", reason: "payment_intent_metadata_mismatch" };

  const charge = pi.latest_charge;
  if (!charge || typeof charge === "string") return { ok: false, status: "rejected", reason: "charge_not_expanded" };
  if (charge.livemode !== live) return { ok: false, status: "rejected", reason: "livemode" };
  if (charge.status !== "succeeded" || !charge.paid || !charge.captured) return { ok: false, status: "not_paid", reason: "charge_not_captured" };
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
      livemode: live,
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
