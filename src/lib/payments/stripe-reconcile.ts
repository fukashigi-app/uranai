import "server-only";
import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { FieldPath, Timestamp, type DocumentReference, type DocumentSnapshot } from "firebase-admin/firestore";
import { C, fsdb, safeId, toDate } from "@/lib/firestore/admin";
import { paymentReviewId } from "@/lib/firestore/payment-reviews";
import { isSessionSecretStrong } from "@/lib/env-rules";
import { txFacts } from "@/lib/firestore/settlement-adjustments";
import { ensureStripeAccount, StripeAccountMismatchError, type StripeMode, type StripeRuntime } from "./stripe-checkout";
import { isSettlementPayment } from "./kind";
import { entitledStoreShare } from "./settlement-rules";
import {
  chargeFactOf,
  chargeNeedsAdjustmentCheck,
  classifyAdjustments,
  classifySettlement,
  disputeFactOf,
  refundFactOf,
  RECONCILE_MAX_ADJUSTMENTS_PER_TX,
  REVERSE_LOOKBACK_SEC,
  classifyReverse,
  reversePrecheck,
  type ReverseTxFact,
  type AdjustmentDocFact,
  type AdjustmentTxFact,
  type ChargeFact,
  type DisputeFact,
  type RefundFact,
  type SettlementFact,
  classifyPayment,
  normalizeRange,
  piFactOf,
  reconcileVerdict,
  scopeOf,
  type CheckoutFact,
  type PaymentVerdict,
  type PiFact,
  type ReconcileFinding,
  type ReconcileAnomalyKind,
  type ReconcileScope,
  type ReconcileVerdict,
  type TxFact,
} from "./reconcile-rules";

/**
 * Stripe 起点の決済照合（F2 第1段階。読み取り専用）。
 *  1. Stripe の PaymentIntent の一覧（GET /v1/payment_intents。created で期間を指定・新しい順・starting_after でページ送り）を読む
 *  2. この環境の決済（livemode・metadata の環境を表す値）だけを対象にし、支払い済みのものについて
 *     Firestore の注文（checkouts/{metadata.checkoutId}）・取引（transactions/stripe_{PaymentIntent}）を ID で読んで照合する
 *  3. 異常・処理待ち・要確認（照合できなかった決済）・対象外を分けて数える
 * Stripe は一覧の取得（と、接続のアカウントの確認 GET /v1/account）だけ。Firestore は読むだけ。決済・返金・精算・注文は変更しない。
 * 自動の返金・修復・決済要確認への登録はしない。
 *
 * 途中で止まったとき（取得の失敗・時間・件数の上限）は「未完了」とし、続きの位置を署名付きの再開用の値（token）で返す。
 * 再開の値には期間・モード・環境・アカウント・実行した運営者を含めて署名するので、再開のときに期間や環境をすり替えられない。
 * 1ページ（最大100件）は、Stripe の取得と Firestore の読み取りと判定がすべて成功したときだけ結果に加える（途中の失敗では
 * 続きの位置を進めない。再開するとそのページから読み直す）。
 */

export const RECONCILE_LIMITS = {
  /** Stripe の一覧の1ページの件数（Stripe の上限は100） */
  pageSize: 100,
  /** 1回の実行で読むページの上限（超えたら未完了で止め、続きから再開する） */
  maxPagesPerSegment: 30,
  /** 1回の実行の時間の上限（この時間を過ぎたら次のページを読まない） */
  deadlineMs: 40_000,
  /** 画面に一覧で出す件数の上限（種類ごと。件数は上限を超えても数える） */
  maxListed: 200,
  /** 再開できる期間（照合の開始から） */
  tokenTtlMs: 2 * 60 * 60 * 1000,
  /**
   * 重複の判定に使う索引の上限（件数）。索引に入れるのは、この環境の支払い済みで、注文が紐付いていない（未確定の）決済だけ
   * （確定した決済は入れない）。超えた分は重複を判定しない（truncated.dupIndex）
   */
  maxDupIndex: 1000,
  /** 返金・異議申し立ての一覧の1ページの件数（1件ごとに Stripe・Firestore を読むので、決済の一覧より小さくする） */
  streamPageSize: 20,
  /** 1回の実行で、返金・異議申し立てを詳しく確かめる Charge の上限（超えたら次のページを読まずに未完了で止め、続きから再開） */
  maxAdjustmentChecksPerSegment: 60,
  /** 返金・異議申し立てを確かめた Charge の記録の上限（同じ Charge を二重に数えないため。超えた分は「確認していない」） */
  maxChecked: 3000,
  /** 第2段階b：Firestore の取引の一覧の1ページの件数 */
  txPageSize: 50,
  /** 取引のページごとに読む Stripe の決済の一覧の上限（ページ数）。読み切れなかった取引は1件ずつ取り直す */
  reverseListMaxPages: 5,
  /** 1回の実行で、取引の決済を1件ずつ取り直す上限（超えたら次のページを読まずに未完了で止め、続きから再開） */
  maxReverseLookupsPerSegment: 60,
};
export type ReconcileLimits = typeof RECONCILE_LIMITS;

/** 異常の1件（ID・金額の種類だけ。個人情報・秘密情報は含めない） */
export type ReconcileItem = {
  kind: ReconcileAnomalyKind;
  details: string[];
  paymentIntentId: string;
  chargeId: string | null;
  checkoutId: string | null;
  transactionId: string;
  storeId: string | null;
  created: number;
  /** 同じ決済が、決済要確認（paid_checkout_unconfirmable）に記録済みか */
  existingReview: boolean;
  /** 精算の調整の不一致の差額（今の取り分 − 支払った額 − 調整の合計。円） */
  delta?: number;
};
/**
 * 重複の判定の索引の1件（注文 ID ごと。ページをまたいで判定するため、再開用の値に入れる）。
 * p=PaymentIntent・t=作成日時・ch=Charge・s=店舗・st=結果に数えた分類・dup=重複として数えたか
 */
export type ReconcileDupEntry = { p: string; t: number; ch: string | null; s: string | null; st: "pending" | "anomaly"; dup: boolean };
/** 処理待ち・要確認の1件 */
export type ReconcileRef = { paymentIntentId: string; checkoutId: string | null; created: number; scope?: ReconcileScope | string; reason?: string; chargeId?: string | null; transactionId?: string | null };

export type ReconcileCounts = {
  /** 一覧から読んだ PaymentIntent の件数（すべて） */
  scanned: number;
  /** この環境の決済 */
  inScope: number;
  /** この環境の、支払い済みで記録と一致した決済 */
  matched: number;
  /** この環境の、支払いが完了していない PaymentIntent（照合しない） */
  notPaid: number;
  /** 処理待ち（支払いの直後で記録がまだ無い） */
  pending: number;
  /** 異常のある決済の件数（1件の決済に複数の異常があっても1件） */
  anomalyPayments: number;
  /** 異常の件数（種類ごとの合計） */
  anomalies: number;
  /** 対象外：モードが違う */
  otherMode: number;
  /** 対象外：別の環境の決済（すべての状態） */
  otherEnv: number;
  /** 環境を表す値が無い決済（すべての状態） */
  untagged: number;
  /** 環境を表す値の形が違う決済（すべての状態） */
  badTag: number;
  /** 要確認：照合できなかった支払い済みの決済（値が無い・形が違う・本番の接続での別の環境）と、返金・異議申し立て・精算で正常と判断できないもの */
  needsReview: number;
  /** 第2段階a：返金・異議申し立てを詳しく確かめた Charge */
  adjustmentChecks: number;
  /** 返金・異議申し立て・精算の異常がある Charge */
  adjustmentIssues: number;
  /** 返金・異議申し立ての一覧から読んだ件数 */
  refundsSeen: number;
  disputesSeen: number;
  /** 正常な一時状態：返金の処理中（取引にも反映済み）・異議申し立ての対応中 */
  refundInProgress: number;
  disputeOpen: number;
  /** 精算の調整を確かめた取引（確定済みの精算に含めたもの） */
  settlementChecked: number;
  /** 第2段階b：Firestore の取引の一覧で読んだ取引（paidAt が期間の中のもの。paidAt が無い取引は含まれない） */
  txScanned: number;
  /** 対象外：Stripe 以外の決済会社・モードが違う取引 */
  txOtherProvider: number;
  txOtherMode: number;
  /** 元の決済が期間の中（決済の一覧の段階で照合済み。重ねて数えない） */
  txCovered: number;
  /** 元の決済が期間の外で、Stripe と一致（期間の境目） */
  txMatched: number;
  /** Stripe の決済を1件ずつ取り直した回数 */
  reverseLookups: number;
};

export type ReconcilePhase = "payments" | "refunds" | "disputes" | "transactions";

export type ReconcileState = {
  v: 3;
  runId: string;
  userId: string;
  mode: StripeMode;
  envTag: string;
  accountKey: string;
  from: number;
  to: number;
  startedAt: number;
  /** 今の段階（決済の一覧 → 返金の一覧 → 異議申し立ての一覧）。cursor は今の段階の続きの位置 */
  phase: ReconcilePhase;
  cursor: string | null;
  done: boolean;
  pages: number;
  counts: ReconcileCounts;
  byKind: Record<ReconcileAnomalyKind, number>;
  anomalies: ReconcileItem[];
  pendingItems: ReconcileRef[];
  reviewItems: ReconcileRef[];
  /** dupIndex＝重複の判定の索引が上限に達し、それ以降の決済の重複を判定していない */
  truncated: { anomalies: boolean; pending: boolean; review: boolean; dupIndex: boolean; checked: boolean };
  /** 重複の判定の索引（注文 ID → 未確定の支払い済みの決済） */
  dupIndex: Record<string, ReconcileDupEntry[]>;
  dupIndexSize: number;
  /** 返金・異議申し立てを確かめた Charge（ID のハッシュ12文字。段階をまたいで二重に数えないため） */
  checked: string[];
  /** 結果に加えたページでの、Stripe の呼び出しと Firestore の読み取りの件数（失敗して読み直したページの分は含まない） */
  metrics: { stripeCalls: number; firestoreReads: number };
};

export type ReconcileStop = "time" | "page_limit" | "check_limit" | "stripe_error" | "firestore_error" | "unexpected_response" | "account_mismatch";

export const RECONCILE_STOP_LABEL: Record<ReconcileStop, string> = {
  time: "1回の実行の時間の上限に達した",
  page_limit: "1回の実行で読むページの上限に達した",
  check_limit: "1回の実行で、返金・異議申し立てを確かめる件数、または取引の決済を取り直す件数の上限に達した",
  stripe_error: "Stripe から取得できなかった（決済・返金・異議申し立ての一覧、または個別の確認）",
  firestore_error: "Firestore を読めなかった",
  unexpected_response: "Stripe から想定外の応答があった",
  account_mismatch: "Stripe のアカウントを確認できなかった",
};

export type ReconcileRun = {
  state: ReconcileState;
  verdict: ReconcileVerdict;
  /** 未完了なら止まった理由。全ページを読み終えたら null */
  stoppedBy: ReconcileStop | null;
  /** 続きから再開するための値（全ページを読み終えたら null） */
  token: string | null;
  /** この実行で読んだページ数 */
  segmentPages: number;
};

export type ReconcileStartError = "invalid_range" | "range_too_long" | "range_future" | "secret_unavailable";
export type ReconcileResumeError = "invalid_token" | "expired_token" | "token_user_mismatch" | "token_environment_mismatch" | "already_done" | "secret_unavailable";

export class ReconcileInputError extends Error {
  constructor(public readonly code: ReconcileStartError | ReconcileResumeError) {
    super(code);
    this.name = "ReconcileInputError";
  }
}

const emptyCounts = (): ReconcileCounts => ({
  scanned: 0, inScope: 0, matched: 0, notPaid: 0, pending: 0, anomalyPayments: 0, anomalies: 0, otherMode: 0, otherEnv: 0, untagged: 0, badTag: 0, needsReview: 0,
  adjustmentChecks: 0, adjustmentIssues: 0, refundsSeen: 0, disputesSeen: 0, refundInProgress: 0, disputeOpen: 0, settlementChecked: 0,
  txScanned: 0, txOtherProvider: 0, txOtherMode: 0, txCovered: 0, txMatched: 0, reverseLookups: 0,
});
const emptyByKind = (): Record<ReconcileAnomalyKind, number> => ({
  stripe_paid_no_checkout: 0, stripe_paid_no_transaction: 0, amount_or_mode_mismatch: 0, duplicate_or_bad_link: 0, refund_mismatch: 0, dispute_mismatch: 0, settlement_adjustment_mismatch: 0, stripe_payment_missing: 0,
});
const chargeKey = (ch: string) => createHash("sha256").update(ch).digest("hex").slice(0, 12);

const accountKeyOf = (rt: Pick<StripeRuntime, "accountId">) => createHash("sha256").update(`uranai-reconcile-account:${rt.accountId ?? "none"}`).digest("hex").slice(0, 24);

// ===== 再開用の値（署名付き） =====

function tokenKey(secret: string | undefined): Buffer {
  if (!secret || !isSessionSecretStrong({ SESSION_SECRET: secret })) throw new ReconcileInputError("secret_unavailable");
  return createHmac("sha256", secret).update("uranai-payment-reconcile:v1").digest();
}

export function encodeReconcileToken(s: ReconcileState, secret: string | undefined = process.env.SESSION_SECRET): string {
  const body = Buffer.from(JSON.stringify(s)).toString("base64url");
  const sig = createHmac("sha256", tokenKey(secret)).update(body).digest("base64url");
  return `${body}.${sig}`;
}

/** 再開用の値の大きさの上限（画面とサーバーの間で受け渡す。一覧の上限から十分に大きい値） */
export const RECONCILE_TOKEN_MAX_LENGTH = 800_000;

export function decodeReconcileToken(raw: unknown, secret: string | undefined = process.env.SESSION_SECRET): ReconcileState {
  const key = tokenKey(secret);
  if (typeof raw !== "string" || raw.length > RECONCILE_TOKEN_MAX_LENGTH) throw new ReconcileInputError("invalid_token");
  const [body, sig, extra] = raw.split(".");
  if (!body || !sig || extra !== undefined) throw new ReconcileInputError("invalid_token");
  const expected = Buffer.from(createHmac("sha256", key).update(body).digest("base64url"));
  const actual = Buffer.from(sig);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) throw new ReconcileInputError("invalid_token");
  let s: ReconcileState;
  try {
    s = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as ReconcileState;
  } catch {
    throw new ReconcileInputError("invalid_token");
  }
  if (!s || s.v !== 3 || typeof s.runId !== "string" || typeof s.startedAt !== "number" || typeof s.from !== "number" || typeof s.to !== "number") throw new ReconcileInputError("invalid_token");
  return s;
}

// ===== 実行 =====

/** 照合を始める（期間は Unix 秒。from 以上・to 未満。to は今の時刻を超えない） */
export async function startReconcile(opts: { rt: StripeRuntime; userId: string; fromSec: number; toSec: number; now?: Date; limits?: Partial<ReconcileLimits>; secret?: string }): Promise<ReconcileRun> {
  const now = opts.now ?? new Date();
  const secret = opts.secret ?? process.env.SESSION_SECRET;
  tokenKey(secret); // 署名の鍵が使えない環境では始めない（再開できない照合を始めない）
  const range = normalizeRange(opts.fromSec, opts.toSec, now.getTime());
  if (!range.ok) throw new ReconcileInputError(range.reason === "too_long" ? "range_too_long" : range.reason === "future" ? "range_future" : "invalid_range");
  const state: ReconcileState = {
    v: 3,
    runId: randomUUID(),
    userId: opts.userId,
    mode: opts.rt.mode,
    envTag: opts.rt.envTag,
    accountKey: accountKeyOf(opts.rt),
    from: range.from,
    to: range.to,
    startedAt: now.getTime(),
    phase: "payments",
    cursor: null,
    done: false,
    pages: 0,
    counts: emptyCounts(),
    byKind: emptyByKind(),
    anomalies: [],
    pendingItems: [],
    reviewItems: [],
    truncated: { anomalies: false, pending: false, review: false, dupIndex: false, checked: false },
    dupIndex: {},
    dupIndexSize: 0,
    checked: [],
    metrics: { stripeCalls: 0, firestoreReads: 0 },
  };
  return runSegment(state, opts.rt, { ...RECONCILE_LIMITS, ...opts.limits }, secret);
}

/** 続きから再開する。期間・モード・環境・アカウント・運営者は、署名した再開用の値のものを使う（外から渡した値では変えられない） */
export async function resumeReconcile(opts: { rt: StripeRuntime; userId: string; token: unknown; now?: Date; limits?: Partial<ReconcileLimits>; secret?: string }): Promise<ReconcileRun> {
  const secret = opts.secret ?? process.env.SESSION_SECRET;
  const L = { ...RECONCILE_LIMITS, ...opts.limits };
  const s = decodeReconcileToken(opts.token, secret);
  const now = opts.now ?? new Date();
  if (now.getTime() - s.startedAt > L.tokenTtlMs || now.getTime() < s.startedAt) throw new ReconcileInputError("expired_token");
  if (s.userId !== opts.userId) throw new ReconcileInputError("token_user_mismatch");
  if (s.mode !== opts.rt.mode || s.envTag !== opts.rt.envTag || s.accountKey !== accountKeyOf(opts.rt)) throw new ReconcileInputError("token_environment_mismatch");
  if (s.done) throw new ReconcileInputError("already_done");
  if (!s.dupIndex || typeof s.dupIndex !== "object" || !Number.isSafeInteger(s.dupIndexSize) || typeof s.truncated?.dupIndex !== "boolean" || typeof s.truncated?.checked !== "boolean") throw new ReconcileInputError("invalid_token");
  if (!["payments", "refunds", "disputes", "transactions"].includes(s.phase) || !Array.isArray(s.checked) || !s.metrics) throw new ReconcileInputError("invalid_token");
  return runSegment(s, opts.rt, L, secret);
}

const clone = (s: ReconcileState): ReconcileState => JSON.parse(JSON.stringify(s)) as ReconcileState;

function pushCapped<T>(list: T[], item: T, max: number): boolean {
  if (list.length >= max) return false;
  list.push(item);
  return true;
}

const CHECKOUT_FIELDS = ["provider", "status", "amount", "storeId", "fortuneType", "stripeLivemode", "providerPaymentId", "providerPaymentKey"];
const TX_FIELDS = [
  "paymentProvider", "amount", "livemode", "storeId", "fortuneType", "checkoutId", "stripePaymentIntentId", "stripeChargeId", "stripeCheckoutSessionId",
  // 第2段階a：返金・異議申し立て・精算
  "paymentStatus", "amountRefunded", "refundStatus", "refundKey", "refundPendingAmount", "refundFailedAmount", "stripeRefundIds", "refundNeedsReview",
  "disputeId", "disputeStatus", "disputeKey", "disputeAmount", "storeShare", "storeShareBps", "operatorShare", "yearMonth", "settlementId", "settledShare", "adjustmentTotal", "adjustmentCount",
];
const SETTLEMENT_FIELDS = ["status", "lockedAt"];
const ADJUSTMENT_FIELDS = ["transactionId", "storeId", "sourceSettlementId", "amount"];

/** 1ページの処理で使う値。page は結果に加えるページの読み取り・呼び出しの件数 */
type Ctx = { rt: StripeRuntime; L: ReconcileLimits; live: boolean; now: Date; page: { stripeCalls: number; firestoreReads: number }; checks: number; reverseLookups: number };

const coRef = (id: string) => fsdb().collection(C.checkouts).doc(id);
const txRef = (pi: string) => fsdb().collection(C.transactions).doc(safeId("stripe", pi));
const settlementRef = (id: string) => fsdb().collection(C.settlements).doc(id);
const adjustmentRef = (id: string) => fsdb().collection(C.settlementAdjustments).doc(id);

/** ID で読む（照合に使う項目だけ。注文のトークンなどは読まない）。存在しなければ exists=false。失敗は firestore_error */
async function readByIds(ctx: Ctx, refs: DocumentReference[], fields: string[]): Promise<Map<string, DocumentSnapshot>> {
  const out = new Map<string, DocumentSnapshot>();
  try {
    for (let i = 0; i < refs.length; i += 100) {
      const part = refs.slice(i, i + 100);
      if (!part.length) continue;
      ctx.page.firestoreReads += part.length;
      const snaps = await fsdb().getAll(...part, { fieldMask: fields });
      for (const s of snaps) out.set(s.ref.path, s);
    }
  } catch (e) {
    console.error("[payment-reconcile] firestore read failed", { error: (e as Error)?.name });
    throw new Stop("firestore_error");
  }
  return out;
}

/** Stripe の取得（読むだけ）。失敗は stripe_error（照合全体を未完了にする） */
async function stripeGet<T>(ctx: Ctx, fn: () => Promise<T>): Promise<T> {
  ctx.page.stripeCalls++;
  try {
    return await fn();
  } catch (e) {
    console.error("[payment-reconcile] stripe read failed", { error: (e as Error)?.name });
    throw new Stop("stripe_error");
  }
}

class Stop extends Error {
  constructor(public readonly reason: ReconcileStop) {
    super(reason);
    this.name = "ReconcileStop";
  }
}

function addFound(next: ReconcileState, found: ReconcileItem[], item: ReconcileItem) {
  next.counts.anomalies++;
  next.byKind[item.kind]++;
  found.push(item);
}
function addReview(next: ReconcileState, L: ReconcileLimits, ref: ReconcileRef) {
  next.counts.needsReview++;
  if (!pushCapped(next.reviewItems, ref, L.maxListed)) next.truncated.review = true;
}
function addPending(next: ReconcileState, L: ReconcileLimits, ref: ReconcileRef) {
  next.counts.pending++;
  if (!pushCapped(next.pendingItems, ref, L.maxListed)) next.truncated.pending = true;
}
function markChecked(next: ReconcileState, L: ReconcileLimits, ch: string) {
  if (next.checked.length >= L.maxChecked) next.truncated.checked = true;
  else next.checked.push(chargeKey(ch));
}
const isChecked = (s: ReconcileState, ch: string) => s.checked.includes(chargeKey(ch));

type PayRef = { id: string; created: number; checkoutId: string | null; storeId: string | null };

/**
 * 1件の Charge の返金・異議申し立てを、Stripe から取り直して取引の記録と照合する（A・B・C）。
 * Stripe は返金の一覧・異議申し立ての一覧（Charge で絞り込み）の取得だけ。
 */
async function checkCharge(ctx: Ctx, next: ReconcileState, found: ReconcileItem[], a: { tx: AdjustmentTxFact; txId: string; chargeId: string; chargeAmount: number; livemode: boolean; pi: PayRef }) {
  const ref: ReconcileRef = { paymentIntentId: a.pi.id, checkoutId: a.pi.checkoutId, created: a.pi.created, chargeId: a.chargeId, transactionId: a.txId };
  if (next.checked.length >= ctx.L.maxChecked) {
    next.truncated.checked = true;
    addReview(next, ctx.L, { ...ref, reason: "adjustments_unchecked" });
    return;
  }
  const rl = await stripeGet(ctx, () => ctx.rt.client.refunds.list({ charge: a.chargeId, limit: 100 }));
  const dl = await stripeGet(ctx, () => ctx.rt.client.disputes.list({ charge: a.chargeId, limit: 10 }));
  if (!Array.isArray(rl?.data) || !Array.isArray(dl?.data) || typeof rl.has_more !== "boolean" || typeof dl.has_more !== "boolean") throw new Stop("unexpected_response");
  const refunds: RefundFact[] = [];
  for (const r of rl.data) {
    const f = refundFactOf(r);
    if (!f) throw new Stop("unexpected_response");
    refunds.push(f);
  }
  const disputes: DisputeFact[] = [];
  for (const d of dl.data) {
    const f = disputeFactOf(d);
    if (!f) throw new Stop("unexpected_response");
    disputes.push(f);
  }
  ctx.checks++;
  next.counts.adjustmentChecks++;
  markChecked(next, ctx.L, a.chargeId);
  if (rl.has_more) {
    addReview(next, ctx.L, { ...ref, reason: "refund_invalid" }); // 1件の決済に100件を超える返金（100円の商品では起きない）。一部だけで判定しない
    return;
  }
  const v = classifyAdjustments({ tx: a.tx, chargeId: a.chargeId, chargeAmount: a.chargeAmount, livemode: a.livemode, refunds, disputes: dl.has_more && disputes.length < 2 ? [...disputes, ...disputes] : disputes, now: ctx.now }); // 異議申し立ての一覧に続きがある＝複数（要確認）
  if (v.findings.length) next.counts.adjustmentIssues++;
  for (const fd of v.findings) addFound(next, found, { kind: fd.kind, details: fd.details, paymentIntentId: a.pi.id, chargeId: a.chargeId, checkoutId: a.pi.checkoutId, transactionId: a.txId, storeId: a.pi.storeId, created: a.pi.created, existingReview: false });
  for (const p of v.pending) addPending(next, ctx.L, { ...ref, reason: p });
  for (const r of v.review) addReview(next, ctx.L, { ...ref, reason: r });
  if (v.refundInProgress) next.counts.refundInProgress++;
  if (v.disputeOpen) next.counts.disputeOpen++;
}

/**
 * 確定済みの精算の調整（D）。取引の値と、精算の記録（状態・lockedAt）、調整の記録（取引ID_1〜n+1）を ID で読んで判定する。
 * Stripe は呼ばない。精算の対象（本番の決済）だけ。
 */
async function checkSettlements(ctx: Ctx, next: ReconcileState, found: ReconcileItem[], list: { txId: string; data: Record<string, unknown>; pi: PayRef; chargeId: string | null }[]) {
  const targets = list.filter((x) => isSettlementPayment(String(x.data.paymentProvider), x.data.livemode));
  if (!targets.length) return;
  const stIds = new Set<string>();
  for (const x of targets) {
    if (typeof x.data.settlementId === "string" && x.data.settlementId) stIds.add(x.data.settlementId);
    else if (typeof x.data.storeId === "string" && typeof x.data.yearMonth === "string") stIds.add(`${x.data.storeId}_${x.data.yearMonth}`);
  }
  const sts = await readByIds(ctx, [...stIds].map(settlementRef), SETTLEMENT_FIELDS);
  const adjIds: string[] = [];
  for (const x of targets) {
    const n = Number(x.data.adjustmentCount ?? 0);
    if (typeof x.data.settlementId === "string" && x.data.settlementId && Number.isSafeInteger(n) && n >= 0 && n <= RECONCILE_MAX_ADJUSTMENTS_PER_TX) {
      for (let i = 1; i <= n + 1; i++) adjIds.push(`${x.txId}_${i}`);
    }
  }
  const adjs = await readByIds(ctx, adjIds.map(adjustmentRef), ADJUSTMENT_FIELDS);
  const stFact = (id: string): SettlementFact | null => {
    const sn = sts.get(settlementRef(id).path);
    return sn?.exists ? { status: sn.get("status"), lockedAt: !!sn.get("lockedAt") } : null;
  };
  for (const x of targets) {
    const d = x.data;
    const stamped = typeof d.settlementId === "string" && d.settlementId ? stFact(d.settlementId) : null;
    const month = typeof d.storeId === "string" && typeof d.yearMonth === "string" ? stFact(`${d.storeId}_${d.yearMonth}`) : null;
    const n = Number(d.adjustmentCount ?? 0);
    const docs: (AdjustmentDocFact | null)[] = [];
    let extra = false;
    if (Number.isSafeInteger(n) && n >= 0 && n <= RECONCILE_MAX_ADJUSTMENTS_PER_TX) {
      for (let i = 1; i <= n; i++) {
        const sn = adjs.get(adjustmentRef(`${x.txId}_${i}`).path);
        docs.push(sn?.exists ? (sn.data() as AdjustmentDocFact) : null);
      }
      extra = !!adjs.get(adjustmentRef(`${x.txId}_${n + 1}`).path)?.exists;
    }
    const v = classifySettlement({ settlementPayment: true, entitled: entitledStoreShare(txFacts(d)), tx: { settlementId: d.settlementId, settledShare: d.settledShare, adjustmentTotal: d.adjustmentTotal, adjustmentCount: d.adjustmentCount, storeId: d.storeId }, stamped, month, adjustmentDocs: docs, extraAdjustmentDoc: extra, txId: x.txId });
    const ref: ReconcileRef = { paymentIntentId: x.pi.id, checkoutId: x.pi.checkoutId, created: x.pi.created, chargeId: x.chargeId, transactionId: x.txId };
    if (v.kind === "not_applicable") continue;
    if (stamped) next.counts.settlementChecked++;
    if (v.kind === "review") addReview(next, ctx.L, { ...ref, reason: v.reason });
    else if (v.kind === "anomaly") addFound(next, found, { kind: "settlement_adjustment_mismatch", details: v.details, paymentIntentId: x.pi.id, chargeId: x.chargeId, checkoutId: x.pi.checkoutId, transactionId: x.txId, storeId: typeof d.storeId === "string" ? d.storeId : null, created: x.pi.created, existingReview: false, delta: v.delta });
  }
}

/** 決済の一覧の1ページ（第1段階の照合と、この環境の取引の返金・異議申し立て・精算の調整） */
async function paymentsPage(ctx: Ctx, state: ReconcileState, next: ReconcileState, found: ReconcileItem[]): Promise<{ hasMore: boolean; lastId: string | null }> {
  const { rt, L, live, now } = ctx;
  // 1. Stripe の一覧（1ページ）。取得系だけ。latest_charge を展開して、返金・異議申し立ての有無（amount_refunded・refunded・disputed）を読む
  const page = await stripeGet(ctx, () => rt.client.paymentIntents.list({ created: { gte: state.from, lt: state.to }, limit: L.pageSize, expand: ["data.latest_charge"], ...(state.cursor ? { starting_after: state.cursor } : {}) }));
  if (!Array.isArray(page.data) || typeof page.has_more !== "boolean" || page.data.length > L.pageSize) throw new Stop("unexpected_response");
  const facts: PiFact[] = [];
  const charges = new Map<string, ChargeFact | null>();
  for (const raw of page.data) {
    const f = piFactOf(raw); // ここで ID・状態・金額・metadata の決まった項目だけにする（元の応答は保存しない）
    if (!f || f.created < state.from || f.created >= state.to) throw new Stop("unexpected_response");
    const lc = (raw as { latest_charge?: unknown }).latest_charge;
    if (typeof lc === "string") throw new Stop("unexpected_response"); // 展開を求めたのに ID のまま
    charges.set(f.id, lc ? chargeFactOf(lc) : null); // Charge の個人情報（billing_details など）は取り出さない
    facts.push(f);
  }
  if (page.has_more && facts.length === 0) throw new Stop("unexpected_response"); // 続きがあるのに空（続きの位置を進められない）
  if (state.cursor && facts.some((f) => f.id === state.cursor)) throw new Stop("unexpected_response"); // 同じページの繰り返し

    // 2. この環境の支払い済みの決済について、Firestore の注文・取引を ID で読む
    const c = next.counts;
    const targets: PiFact[] = [];
    for (const f of facts) {
      c.scanned++;
      const scope = scopeOf(f, { live, envTag: rt.envTag });
      if (scope === "other_mode") c.otherMode++;
      else if (scope === "other_env") c.otherEnv++;
      else if (scope === "untagged") c.untagged++;
      else if (scope === "bad_tag") c.badTag++;
      if (scope === "in_scope") {
        c.inScope++;
        targets.push(f);
        continue;
      }
      // 照合できなかった支払い済みの決済は「要確認」（正常とは扱わない）。テストの接続での別の環境は、同じ Sandbox を使う別の環境の決済なので対象外
      const review = f.status === "succeeded" && (scope === "untagged" || scope === "bad_tag" || (scope === "other_env" && live));
      if (review) {
        c.needsReview++;
        if (!pushCapped(next.reviewItems, { paymentIntentId: f.id, checkoutId: f.checkoutId, created: f.created, scope }, L.maxListed)) next.truncated.review = true;
      }
    }
    const paid = targets.filter((f) => f.status === "succeeded");
    let checkouts: Map<string, DocumentSnapshot>;
    let txs: Map<string, DocumentSnapshot>;
    try {
      const coIds = [...new Set(paid.map((f) => f.checkoutId).filter((x): x is string => !!x))];
      [checkouts, txs] = await Promise.all([readByIds(ctx, coIds.map(coRef), CHECKOUT_FIELDS), readByIds(ctx, paid.map((f) => txRef(f.id)), TX_FIELDS)]);
    } catch (e) {
      console.error("[payment-reconcile] firestore read failed", { error: (e as Error)?.name });
      throw new Stop("firestore_error");
    }

    // 3. 判定
    type PageItem = { f: PiFact; txId: string; verdict: PaymentVerdict; findings: ReconcileFinding[]; entry?: ReconcileDupEntry };
    const items: PageItem[] = targets.map((f) => {
      const txId = safeId("stripe", f.id);
      const coSnap = f.checkoutId ? checkouts.get(coRef(f.checkoutId).path) : undefined;
      const txSnap = f.status === "succeeded" ? txs.get(txRef(f.id).path) : undefined;
      const verdict = classifyPayment(f, txId, coSnap?.exists ? (coSnap.data() as CheckoutFact) : null, txSnap?.exists ? (txSnap.data() as TxFact) : null, now);
      return { f, txId, verdict, findings: verdict.kind === "anomaly" ? verdict.findings.map((x) => ({ ...x, details: [...x.details] })) : [] };
    });
    // 3a. 重複：同じ注文に、注文が紐付いていない（未確定の）支払い済みの決済が複数あれば、すべて重複（ページ・処理待ちの時間によらない）。
    //     注文が紐付いている決済（正しく確定した1件目）は対象外（索引にも入れない）。前のページの決済は、確定した結果に重複を加える
    const addDup = (findings: ReconcileFinding[]) => {
      const d = findings.find((x) => x.kind === "duplicate_or_bad_link");
      if (!d) findings.push({ kind: "duplicate_or_bad_link", details: ["duplicate_in_run"] });
      else if (!d.details.includes("duplicate_in_run")) d.details.push("duplicate_in_run");
    };
    const onThisPage = new Map<string, PageItem>();
    for (const it of items) {
      const f = it.f;
      if (f.status !== "succeeded" || !f.checkoutId) continue;
      const coSnap = checkouts.get(coRef(f.checkoutId).path);
      if (coSnap?.exists && coSnap.get("providerPaymentKey") === it.txId) continue;
      const list = next.dupIndex[f.checkoutId] ?? [];
      if (list.length) {
        addDup(it.findings);
        for (const e of list) {
          if (e.dup) continue;
          e.dup = true;
          const same = onThisPage.get(e.p);
          if (same) {
            addDup(same.findings);
            continue;
          }
          if (e.st === "pending") {
            // 前のページで処理待ちに数えた決済：処理待ちから外し、異常の決済に数え直す
            c.pending--;
            next.pendingItems = next.pendingItems.filter((x) => x.paymentIntentId !== e.p);
            c.anomalyPayments++;
            e.st = "anomaly";
          }
          c.anomalies++;
          next.byKind.duplicate_or_bad_link++;
          found.push({ kind: "duplicate_or_bad_link", details: ["duplicate_in_run"], paymentIntentId: e.p, chargeId: e.ch, checkoutId: f.checkoutId, transactionId: safeId("stripe", e.p), storeId: e.s, created: e.t, existingReview: false });
        }
      }
      if (next.dupIndexSize >= L.maxDupIndex) {
        next.truncated.dupIndex = true; // 索引の上限：この決済と、この後の同じ注文の決済の重複は判定できない
        continue;
      }
      it.entry = { p: f.id, t: f.created, ch: f.latestChargeId, s: f.storeId, st: "pending", dup: list.length > 0 };
      (next.dupIndex[f.checkoutId] ??= []).push(it.entry);
      next.dupIndexSize++;
      onThisPage.set(f.id, it);
    }
    // 3b. このページの決済を数える
    for (const it of items) {
      const f = it.f;
      if (it.findings.length) {
        c.anomalyPayments++;
        if (it.entry) it.entry.st = "anomaly";
        for (const fd of it.findings) {
          c.anomalies++;
          next.byKind[fd.kind]++;
          found.push({ kind: fd.kind, details: fd.details, paymentIntentId: f.id, chargeId: f.latestChargeId, checkoutId: f.checkoutId, transactionId: it.txId, storeId: f.storeId, created: f.created, existingReview: false });
        }
      } else if (it.verdict.kind === "not_paid") c.notPaid++;
      else if (it.verdict.kind === "pending") {
        c.pending++;
        if (!pushCapped(next.pendingItems, { paymentIntentId: f.id, checkoutId: f.checkoutId, created: f.created }, L.maxListed)) next.truncated.pending = true;
      } else c.matched++;
    }

  // 3c. 第2段階a：この環境の支払い済みで取引のある決済の、返金・異議申し立て（A・B・C）と精算の調整（D）
  const forSettlement: { txId: string; data: Record<string, unknown>; pi: PayRef; chargeId: string | null }[] = [];
  for (const it of items) {
    const f = it.f;
    if (f.status !== "succeeded") continue;
    const txSnap = txs.get(txRef(f.id).path);
    if (!txSnap?.exists) continue;
    const t = txSnap.data() as Record<string, unknown>;
    const pref: PayRef = { id: f.id, created: f.created, checkoutId: f.checkoutId, storeId: f.storeId };
    const cf = charges.get(f.id) ?? null;
    forSettlement.push({ txId: it.txId, data: t, pi: pref, chargeId: cf?.id ?? f.latestChargeId });
    if (!chargeNeedsAdjustmentCheck(cf, t as AdjustmentTxFact)) continue;
    if (!cf || cf.amount === null || cf.livemode !== f.livemode) {
      addReview(next, L, { paymentIntentId: f.id, checkoutId: f.checkoutId, created: f.created, chargeId: cf?.id ?? null, transactionId: it.txId, reason: "charge_not_latest" });
      continue;
    }
    if (isChecked(next, cf.id)) continue;
    await checkCharge(ctx, next, found, { tx: t as AdjustmentTxFact, txId: it.txId, chargeId: cf.id, chargeAmount: cf.amount, livemode: f.livemode, pi: pref });
  }
  await checkSettlements(ctx, next, found, forSettlement);
  return { hasMore: page.has_more, lastId: facts.length ? facts[facts.length - 1].id : null };
}

/**
 * 返金・異議申し立ての一覧の1ページ（created が照合の期間の中のもの。元の決済が期間の外でも確かめる）。
 * 1件ごとに、元の PaymentIntent を Stripe から取り直して環境・モードを確かめ、取引を ID で読んで照合する。
 * 決済の一覧の段階で確かめた Charge は二重に数えない（checked）。元の決済が期間の中で取引が無いものは、決済の一覧の段階で
 * 「取引が無い」として数えているので重ねない。期間の外で取引が無いものは、ここで「取引が無い」とする。
 */
async function streamPage(ctx: Ctx, state: ReconcileState, next: ReconcileState, found: ReconcileItem[], kind: "refunds" | "disputes"): Promise<{ hasMore: boolean; lastId: string | null }> {
  const { rt, L, live } = ctx;
  const params = { created: { gte: state.from, lt: state.to }, limit: L.streamPageSize, ...(state.cursor ? { starting_after: state.cursor } : {}) };
  const page = await stripeGet(ctx, () => (kind === "refunds" ? rt.client.refunds.list(params) : rt.client.disputes.list(params)) as Promise<{ data?: unknown; has_more?: unknown }>);
  if (!Array.isArray(page.data) || typeof page.has_more !== "boolean" || page.data.length > L.streamPageSize) throw new Stop("unexpected_response");
  const items: { id: string; charge: string | null; paymentIntent: string | null; created: number; livemode: boolean | null }[] = [];
  for (const raw of page.data) {
    const f = kind === "refunds" ? refundFactOf(raw) : disputeFactOf(raw);
    if (!f || f.created < state.from || f.created >= state.to) throw new Stop("unexpected_response");
    items.push({ id: f.id, charge: f.charge, paymentIntent: f.paymentIntent, created: f.created, livemode: kind === "disputes" ? (f as DisputeFact).livemode : null });
  }
  if (page.has_more && items.length === 0) throw new Stop("unexpected_response");
  if (state.cursor && items.some((x) => x.id === state.cursor)) throw new Stop("unexpected_response");
  const c = next.counts;
  const via = kind === "refunds" ? "found_via_refund" : "found_via_dispute";
  const forSettlement: { txId: string; data: Record<string, unknown>; pi: PayRef; chargeId: string | null }[] = [];
  for (const it of items) {
    if (kind === "refunds") c.refundsSeen++;
    else c.disputesSeen++;
    if (it.livemode !== null && it.livemode !== live) {
      c.otherMode++;
      continue;
    }
    if (!it.charge || !it.paymentIntent) {
      addReview(next, L, { paymentIntentId: it.paymentIntent ?? "-", checkoutId: null, created: it.created, chargeId: it.charge, reason: kind === "refunds" ? "refund_invalid" : "dispute_invalid" });
      continue;
    }
    if (isChecked(next, it.charge)) continue;
    const pi = piFactOf(await stripeGet(ctx, () => rt.client.paymentIntents.retrieve(it.paymentIntent!)));
    if (!pi) throw new Stop("unexpected_response");
    const scope = scopeOf(pi, { live, envTag: rt.envTag });
    const ref: ReconcileRef = { paymentIntentId: pi.id, checkoutId: pi.checkoutId, created: pi.created, chargeId: it.charge };
    if (scope === "other_mode") {
      c.otherMode++;
      continue;
    }
    if (scope === "other_env" && !live) {
      c.otherEnv++;
      markChecked(next, L, it.charge);
      continue;
    }
    if (scope !== "in_scope") {
      addReview(next, L, { ...ref, scope, reason: scope });
      markChecked(next, L, it.charge);
      continue;
    }
    const inPeriod = pi.created >= state.from && pi.created < state.to;
    if (pi.status !== "succeeded") {
      addReview(next, L, { ...ref, reason: "not_succeeded" });
      markChecked(next, L, it.charge);
      continue;
    }
    const txId = safeId("stripe", pi.id);
    const txSnap = (await readByIds(ctx, [txRef(pi.id)], TX_FIELDS)).get(txRef(pi.id).path);
    const pref: PayRef = { id: pi.id, created: pi.created, checkoutId: pi.checkoutId, storeId: pi.storeId };
    if (!txSnap?.exists) {
      // 期間の中の決済は、決済の一覧の段階で「取引が無い」として数えている。期間の外の決済はここで数える
      if (!inPeriod) addFound(next, found, { kind: "stripe_paid_no_transaction", details: ["outside_period", via], paymentIntentId: pi.id, chargeId: it.charge, checkoutId: pi.checkoutId, transactionId: txId, storeId: pi.storeId, created: pi.created, existingReview: false });
      markChecked(next, L, it.charge);
      continue;
    }
    if (pi.latestChargeId !== it.charge || pi.amountReceived === null) {
      addReview(next, L, { ...ref, transactionId: txId, reason: "charge_not_latest" });
      markChecked(next, L, it.charge);
      continue;
    }
    const t = txSnap.data() as Record<string, unknown>;
    await checkCharge(ctx, next, found, { tx: t as AdjustmentTxFact, txId, chargeId: it.charge, chargeAmount: pi.amountReceived, livemode: pi.livemode, pi: pref });
    // 期間の中の決済の精算の調整は、決済の一覧の段階で確かめている
    if (!inPeriod) forSettlement.push({ txId, data: t, pi: pref, chargeId: it.charge });
  }
  await checkSettlements(ctx, next, found, forSettlement);
  return { hasMore: page.has_more, lastId: items.length ? items[items.length - 1].id : null };
}

const REVERSE_TX_FIELDS = ["paymentProvider", "livemode", "stripePaymentIntentId", "stripeChargeId", "paidAt", "storeId", "checkoutId"];

/**
 * Stripe の PaymentIntent を1件取り直す（逆方向の照合）。Stripe に無い（404・resource_missing）ときだけ null。
 * 認証の失敗（401）・権限（403）・レート制限（429）・通信の失敗・5xx などは stripe_error（照合全体を未完了にする。「Stripe に無い」とはしない）
 */
async function retrievePaymentIntent(ctx: Ctx, id: string): Promise<PiFact | null> {
  ctx.page.stripeCalls++;
  let raw: unknown;
  try {
    raw = await ctx.rt.client.paymentIntents.retrieve(id);
  } catch (e) {
    const x = e as { statusCode?: unknown; code?: unknown; name?: unknown };
    if (x.statusCode === 404 && x.code === "resource_missing") return null;
    console.error("[payment-reconcile] stripe read failed", { error: (e as Error)?.name, status: typeof x.statusCode === "number" ? x.statusCode : null });
    throw new Stop("stripe_error");
  }
  const f = piFactOf(raw);
  if (!f || f.id !== id) throw new Stop("unexpected_response");
  return f;
}

/**
 * Firestore の取引の一覧の1ページ（第2段階b。逆方向）。paidAt が期間の中の取引を paidAt・文書 ID の順に読む
 * （範囲の条件と並び順が同じ1つの項目なので、自動の単一項目のインデックスで動く。同じ値の中は文書 ID の順）。
 * paidAt が無い取引は検索に含まれない（照合の対象外）。
 * Stripe 以外の決済会社・モードの違う取引は対象外。それ以外は、取引の支払日時の2時間前から支払日時までに作られた
 * Stripe の PaymentIntent の一覧と、完全な ID で照合する（短いハッシュは使わない）。一覧に無いものだけを1件ずつ取り直し、
 * 404 のときだけ「Stripe に無い」とする。元の決済が期間の中なら、決済の一覧の段階で照合済みなので重ねて数えない。
 */
async function transactionsPage(ctx: Ctx, state: ReconcileState, next: ReconcileState, found: ReconcileItem[]): Promise<{ hasMore: boolean; lastId: string | null }> {
  const { rt, L, live } = ctx;
  let cursor: { ms: number; id: string } | null = null;
  if (state.cursor) {
    const i = state.cursor.indexOf("|");
    const ms = Number(state.cursor.slice(0, i));
    const id = state.cursor.slice(i + 1);
    if (i <= 0 || !Number.isSafeInteger(ms) || !id) throw new Stop("unexpected_response");
    cursor = { ms, id };
  }
  let docs: DocumentSnapshot[];
  try {
    let q = fsdb()
      .collection(C.transactions)
      .where("paidAt", ">=", Timestamp.fromMillis(state.from * 1000))
      .where("paidAt", "<", Timestamp.fromMillis(state.to * 1000))
      .orderBy("paidAt")
      .orderBy(FieldPath.documentId())
      .select(...REVERSE_TX_FIELDS)
      .limit(L.txPageSize);
    if (cursor) q = q.startAfter(Timestamp.fromMillis(cursor.ms), cursor.id);
    const snap = await q.get();
    ctx.page.firestoreReads += Math.max(1, snap.size); // 結果が0件でも1件の読み取り
    docs = snap.docs;
  } catch (e) {
    console.error("[payment-reconcile] firestore read failed", { error: (e as Error)?.name });
    throw new Stop("firestore_error");
  }
  const c = next.counts;
  type Cand = { id: string; tx: ReverseTxFact & Record<string, unknown>; pi: string; paidAt: number };
  const cands: Cand[] = [];
  const itemOf = (d: DocumentSnapshot, t: Record<string, unknown>, paidAt: number) => ({
    paymentIntentId: typeof t.stripePaymentIntentId === "string" ? t.stripePaymentIntentId : "-",
    chargeId: typeof t.stripeChargeId === "string" ? t.stripeChargeId : null,
    checkoutId: typeof t.checkoutId === "string" ? t.checkoutId : null,
    transactionId: d.id,
    storeId: typeof t.storeId === "string" ? t.storeId : null,
    created: paidAt,
    existingReview: false,
  });
  for (const d of docs) {
    c.txScanned++;
    const t = (d.data() ?? {}) as ReverseTxFact & Record<string, unknown>;
    const paidAtDate = toDate(t.paidAt);
    if (!paidAtDate) throw new Stop("unexpected_response"); // 検索の条件で paidAt があるはず
    const paidAt = Math.floor(paidAtDate.getTime() / 1000);
    const pre = reversePrecheck(t, d.id, live);
    if (pre.kind === "other_provider") c.txOtherProvider++;
    else if (pre.kind === "other_mode") c.txOtherMode++;
    else if (pre.kind === "invalid") addFound(next, found, { kind: "duplicate_or_bad_link", details: [...pre.details, "found_via_transactions"], ...itemOf(d, t, paidAt) });
    else cands.push({ id: d.id, tx: t, pi: pre.paymentIntentId, paidAt });
  }
  if (cands.length) {
    // Stripe の一覧（作成日時が、取引の支払日時の2時間前から支払日時まで）。完全な ID で照合する
    const minPaid = Math.min(...cands.map((x) => x.paidAt));
    const maxPaid = Math.max(...cands.map((x) => x.paidAt));
    const seen = new Map<string, PiFact>();
    let after: string | undefined;
    for (let i = 0; i < L.reverseListMaxPages; i++) {
      const page = await stripeGet(ctx, () => rt.client.paymentIntents.list({ created: { gte: minPaid - REVERSE_LOOKBACK_SEC, lt: maxPaid + 1 }, limit: 100, ...(after ? { starting_after: after } : {}) }));
      if (!Array.isArray(page.data) || typeof page.has_more !== "boolean") throw new Stop("unexpected_response");
      for (const raw of page.data) {
        const f = piFactOf(raw);
        if (!f) throw new Stop("unexpected_response");
        seen.set(f.id, f);
      }
      if (!page.has_more || !page.data.length) break;
      after = (page.data[page.data.length - 1] as { id: string }).id;
    }
    for (const x of cands) {
      let f = seen.get(x.pi) ?? null;
      if (!f) {
        // 一覧に無い（PaymentIntent が支払いの2時間より前に作られた・一覧を読み切れなかった・Stripe に無い）：1件ずつ取り直す
        ctx.reverseLookups++;
        c.reverseLookups++;
        f = await retrievePaymentIntent(ctx, x.pi);
      }
      const v = classifyReverse({ tx: x.tx, pi: f, from: state.from, to: state.to, live, envTag: rt.envTag });
      const doc = docs.find((d) => d.id === x.id)!;
      if (v.kind === "covered") c.txCovered++;
      else if (v.kind === "ok") c.txMatched++;
      else if (v.kind === "review") addReview(next, L, { paymentIntentId: x.pi, checkoutId: typeof x.tx.checkoutId === "string" ? x.tx.checkoutId : null, created: x.paidAt, chargeId: typeof x.tx.stripeChargeId === "string" ? x.tx.stripeChargeId : null, transactionId: x.id, scope: v.reason, reason: v.reason });
      else for (const fd of v.findings) addFound(next, found, { kind: fd.kind, details: fd.details, ...itemOf(doc, x.tx, x.paidAt) });
    }
  }
  const last = docs[docs.length - 1];
  const lastPaid = last ? toDate(last.get("paidAt")) : null;
  return { hasMore: docs.length === L.txPageSize, lastId: last && lastPaid ? `${lastPaid.getTime()}|${last.id}` : null };
}

const NEXT_PHASE: Record<ReconcilePhase, ReconcilePhase | null> = { payments: "refunds", refunds: "disputes", disputes: "transactions", transactions: null };

async function runSegment(start: ReconcileState, rt: StripeRuntime, L: ReconcileLimits, secret: string | undefined): Promise<ReconcileRun> {
  let state = start;
  const t0 = Date.now();
  let segmentPages = 0;
  let stoppedBy: ReconcileStop | null = null;
  const ctx: Ctx = { rt, L, live: rt.mode === "live", now: new Date(), page: { stripeCalls: 0, firestoreReads: 0 }, checks: 0, reverseLookups: 0 };
  try {
    try {
      await ensureStripeAccount(rt); // 本番：キーが設定したアカウントのものか（GET /v1/account。読むだけ）
    } catch (e) {
      throw new Stop(e instanceof StripeAccountMismatchError ? "account_mismatch" : "stripe_error");
    }
    while (!state.done) {
      if (segmentPages >= L.maxPagesPerSegment) throw new Stop("page_limit");
      if (ctx.checks >= L.maxAdjustmentChecksPerSegment || ctx.reverseLookups >= L.maxReverseLookupsPerSegment) throw new Stop("check_limit");
      if (Date.now() - t0 > L.deadlineMs) throw new Stop("time");
      ctx.now = new Date();
      ctx.page = { stripeCalls: 0, firestoreReads: 0 };
      // 1ページ分の結果は写しに加え、ページのすべての取得・読み取り・判定が成功したときだけ採用する（失敗したら続きの位置を進めない）
      const next = clone(state);
      const found: ReconcileItem[] = [];
      const r =
        state.phase === "payments" ? await paymentsPage(ctx, state, next, found) : state.phase === "transactions" ? await transactionsPage(ctx, state, next, found) : await streamPage(ctx, state, next, found, state.phase);
      // 異常の決済が、決済要確認（F1：Webhook の受信のときの記録）に記録済みか（ID で読むだけ。新しく記録はしない）
      const chargeIds = [...new Set(found.map((x) => x.chargeId).filter((x): x is string => !!x))];
      if (chargeIds.length) {
        const reviewRef = (ch: string) => fsdb().collection(C.paymentReviews).doc(paymentReviewId("paid_checkout_unconfirmable", ch));
        const reviews = await readByIds(ctx, chargeIds.map(reviewRef), ["status"]);
        for (const x of found) x.existingReview = !!x.chargeId && !!reviews.get(reviewRef(x.chargeId).path)?.exists;
      }
      for (const x of found) if (!pushCapped(next.anomalies, x, L.maxListed)) next.truncated.anomalies = true;
      // このページを結果に加え、続きの位置を進める。段階の最後のページなら次の段階へ
      next.pages++;
      next.metrics.stripeCalls += ctx.page.stripeCalls;
      next.metrics.firestoreReads += ctx.page.firestoreReads;
      if (r.hasMore) next.cursor = r.lastId ?? next.cursor;
      else {
        const np = NEXT_PHASE[state.phase];
        next.cursor = null;
        if (np) next.phase = np;
        else next.done = true;
      }
      state = next;
      segmentPages++;
    }
  } catch (e) {
    if (!(e instanceof Stop)) {
      console.error("[payment-reconcile] failed", { error: (e as Error)?.name });
      stoppedBy = "unexpected_response";
    } else stoppedBy = e.reason;
  }
  const verdict = reconcileVerdict({ complete: state.done, anomalies: state.counts.anomalies, needsReview: state.counts.needsReview, pending: state.counts.pending });
  return { state, verdict, stoppedBy: state.done ? null : stoppedBy, token: state.done ? null : encodeReconcileToken(state, secret), segmentPages };
}
