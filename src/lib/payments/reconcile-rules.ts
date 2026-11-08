import type Stripe from "stripe";
import { CURRENCY, PRICE_JPY } from "@/config/pricing";
import { STUCK_PROCESSING_MINUTES } from "./monitor-rules";
import { chargebackCoversRemainder, disputeStateOf } from "./settlement-rules";
import { summarizeRefunds } from "./stripe-checkout";
import { disputeAmountProblem, disputeKeyOf, refundKeyOf } from "./stripe-sync-rules";

/**
 * Stripe 起点の決済照合（F2 第1段階）の判定（純粋な処理。Stripe・Firestore には接続しない）。
 * Stripe の PaymentIntent の一覧を起点に、この環境（metadata の環境を表す値・livemode）の支払い済みの決済が、
 * Firestore の注文（checkouts）・取引（transactions）に正しく記録されているかを判定する。
 * 返金・異議申し立て・精算の照合は第2段階（ここでは扱わない）。
 */

export const RECONCILE_ANOMALY_KINDS = [
  "stripe_paid_no_checkout",
  "stripe_paid_no_transaction",
  "amount_or_mode_mismatch",
  "duplicate_or_bad_link",
  "refund_mismatch",
  "dispute_mismatch",
  "settlement_adjustment_mismatch",
  "stripe_payment_missing",
] as const;
export type ReconcileAnomalyKind = (typeof RECONCILE_ANOMALY_KINDS)[number];

export const RECONCILE_ANOMALY_LABEL: Record<ReconcileAnomalyKind, string> = {
  stripe_paid_no_checkout: "Stripe で支払い済みだが、注文の記録が無い",
  stripe_paid_no_transaction: "Stripe で支払い済みだが、取引（決済記録）が無い",
  amount_or_mode_mismatch: "Stripe と記録で、金額・モード・店舗などが一致しない",
  duplicate_or_bad_link: "同じ注文への重複した支払い・不正な紐付け",
  refund_mismatch: "Stripe の返金と、取引の返金の記録が一致しない",
  dispute_mismatch: "Stripe の異議申し立てと、取引の記録が一致しない",
  settlement_adjustment_mismatch: "確定済みの精算の調整が、今の取り分と一致しない",
  stripe_payment_missing: "Firestore に取引があるのに、Stripe に決済が無い",
};

/** 一致しない項目の名前（画面の表示用） */
export const RECONCILE_DETAIL_LABEL: Record<string, string> = {
  metadata_checkout_missing: "metadata に注文の ID が無い・形が違う",
  transaction_exists: "取引はある（注文だけが無い）",
  checkout_linked_to_other_payment: "注文は別の決済と紐付いている（同じ注文への2回目の支払いの可能性）",
  amount: "金額",
  currency: "通貨",
  livemode: "モード（本番・テスト）",
  checkout_livemode: "注文のモード",
  provider: "取引の決済会社",
  checkout_provider: "注文の決済会社",
  store: "店舗",
  fortune_type: "占いの種類",
  charge: "Charge の ID",
  transaction_checkout: "取引の注文 ID",
  transaction_payment_intent: "取引の PaymentIntent の ID",
  checkout_link: "注文から取引への紐付け",
  session_link: "Checkout Session の ID",
  checkout_status: "注文の状態（確定済みでない）",
  not_in_stripe: "取引には記録があるが、Stripe には無い",
  pending_amount: "返金の処理中の額",
  failed_amount: "返金の失敗の額",
  status: "状態",
  refund_ids: "返金の ID",
  refund_key: "返金の記録（内容の要約）",
  payment_status: "決済の状態（返金済み・チャージバック）",
  dispute_id: "異議申し立ての ID",
  regressed: "結果が出た異議申し立てが、Stripe では対応中に戻っている",
  dispute_amount: "異議申し立ての額",
  dispute_key: "異議申し立ての記録（内容の要約）",
  outside_period: "元の決済は照合の期間の外",
  found_via_refund: "返金の一覧から見つかった",
  found_via_dispute: "異議申し立ての一覧から見つかった",
  settlement_not_found: "取引が指す精算の記録が無い",
  adjustment_total: "支払った額＋調整の合計が、今の取り分と一致しない",
  adjustment_doc_missing: "調整の記録（文書）が欠けている",
  adjustment_doc_mismatch: "調整の記録の取引・店舗・精算が一致しない",
  adjustment_doc_sum: "調整の記録の合計が、取引の調整の合計と一致しない",
  adjustment_count: "調整の記録の件数が、取引の件数と一致しない",
  stripe_not_found: "Stripe に PaymentIntent が存在しない（404）",
  tx_id_mismatch: "取引の文書 ID と PaymentIntent の ID が一致しない",
  tx_payment_intent_invalid: "取引に PaymentIntent の ID が無い・形が違う",
  stripe_not_paid: "Stripe の決済が支払い済みではない",
  stripe_other_env: "Stripe の決済が別の環境のもの",
  stripe_livemode: "Stripe の決済のモードが取引と違う",
  found_via_transactions: "Firestore の取引の一覧から見つかった（元の決済は期間の外）",
  duplicate_in_run: "同じ注文に、未確定の支払い済みの PaymentIntent が複数（照合した期間の中・ページをまたいでも判定）",
};

/** 支払いの直後の処理待ち（Webhook・決済確定の遅れ）として、異常にしない時間。決済監視と同じ値 */
export const RECONCILE_GRACE_MS = STUCK_PROCESSING_MINUTES * 60_000;

const PI_ID_RE = /^pi_[A-Za-z0-9_]{1,200}$/;
const CHARGE_ID_RE = /^(ch|py)_[A-Za-z0-9_]{1,200}$/;
const ENV_TAG_RE = /^fp_[0-9a-f]{16}$/;
/** 注文の ID（Firestore の文書の ID として安全な形だけ） */
const CHECKOUT_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const SAFE_VALUE_RE = /^[A-Za-z0-9_-]{1,128}$/;

/**
 * PaymentIntent から照合に使う値だけを取り出した形。Stripe の応答には個人情報（receipt_email・shipping など）や
 * client_secret が含まれるので、受け取ったらすぐにこの形にして、元の応答は保存・記録・表示しない。
 */
export type PiFact = {
  id: string;
  created: number;
  livemode: boolean;
  status: string;
  amount: number | null;
  amountReceived: number | null;
  currency: string | null;
  /** metadata の環境を表す値。null＝値が無い（以前の決済）、"invalid"＝形が違う */
  envTag: string | null;
  checkoutId: string | null;
  storeId: string | null;
  fortuneType: string | null;
  latestChargeId: string | null;
};

const intOrNull = (v: unknown) => (typeof v === "number" && Number.isSafeInteger(v) ? v : null);
const safeOrNull = (v: unknown, re = SAFE_VALUE_RE) => (typeof v === "string" && re.test(v) ? v : null);
const idOfRef = (v: unknown): string | null => (typeof v === "string" ? v : v && typeof v === "object" && typeof (v as { id?: unknown }).id === "string" ? (v as { id: string }).id : null);

/** Stripe の応答の1件を PiFact にする。ID・作成日時・livemode の形が正しくなければ null（照合できない応答） */
export function piFactOf(raw: unknown): PiFact | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  if (o.object !== undefined && o.object !== "payment_intent") return null;
  if (typeof o.id !== "string" || !PI_ID_RE.test(o.id)) return null;
  const created = intOrNull(o.created);
  if (created === null || created <= 0 || typeof o.livemode !== "boolean" || typeof o.status !== "string") return null;
  const md = o.metadata && typeof o.metadata === "object" ? (o.metadata as Record<string, unknown>) : {};
  const tag = md.uranaiEnv;
  const charge = idOfRef(o.latest_charge);
  return {
    id: o.id,
    created,
    livemode: o.livemode,
    status: /^[a-z_]{1,40}$/.test(o.status) ? o.status : "unknown",
    amount: intOrNull(o.amount),
    amountReceived: intOrNull(o.amount_received),
    currency: typeof o.currency === "string" && /^[a-z]{3}$/.test(o.currency) ? o.currency : null,
    envTag: tag === undefined || tag === null || tag === "" ? null : typeof tag === "string" && ENV_TAG_RE.test(tag) ? tag : "invalid",
    checkoutId: safeOrNull(md.checkoutId, CHECKOUT_ID_RE),
    storeId: safeOrNull(md.storeId),
    fortuneType: safeOrNull(md.fortuneType),
    latestChargeId: charge && CHARGE_ID_RE.test(charge) ? charge : null,
  };
}

/**
 * 照合の対象か。
 *  in_scope   … この環境の決済（livemode が接続のモードと同じ・環境を表す値がこの環境と同じ）
 *  other_mode … モードが違う（本番の接続でテストの決済など。通常は一覧に出ない）
 *  untagged   … 環境を表す値が無い（以前の決済・別の仕組みで作った決済）。正常とは判断しない（要確認）
 *  bad_tag    … 環境を表す値の形が違う（要確認）
 *  other_env  … 別の環境の決済（同じ Sandbox を使う Preview・ローカルなど）
 */
export type ReconcileScope = "in_scope" | "other_mode" | "untagged" | "bad_tag" | "other_env";

export function scopeOf(f: PiFact, rt: { live: boolean; envTag: string }): ReconcileScope {
  if (f.livemode !== rt.live) return "other_mode";
  if (f.envTag === null) return "untagged";
  if (f.envTag === "invalid") return "bad_tag";
  return f.envTag === rt.envTag ? "in_scope" : "other_env";
}

/** Firestore の注文から照合に使う値（個人情報・トークンは読まない） */
export type CheckoutFact = {
  provider: unknown;
  status: unknown;
  amount: unknown;
  storeId: unknown;
  fortuneType: unknown;
  stripeLivemode: unknown;
  providerPaymentId: unknown;
  providerPaymentKey: unknown;
};

/** Firestore の取引から照合に使う値 */
export type TxFact = {
  paymentProvider: unknown;
  amount: unknown;
  livemode: unknown;
  storeId: unknown;
  fortuneType: unknown;
  checkoutId: unknown;
  stripePaymentIntentId: unknown;
  stripeChargeId: unknown;
  stripeCheckoutSessionId: unknown;
};

export type ReconcileFinding = { kind: ReconcileAnomalyKind; details: string[] };

/**
 * この環境の決済1件の判定。
 *  not_paid … 支払いが完了していない（requires_payment_method・processing・canceled など）。照合しない
 *  pending  … 支払いの直後（RECONCILE_GRACE_MS 以内）で、記録がまだ無い。処理待ち（異常にしない）
 *  ok       … 注文・取引があり、すべて一致
 *  anomaly  … 異常（1件の決済に複数の異常があり得る）
 * 取引の ID（txId）は呼び出し側が決める（stripe_{PaymentIntent}）。
 */
export type PaymentVerdict = { kind: "not_paid"; status: string } | { kind: "pending" } | { kind: "ok" } | { kind: "anomaly"; findings: ReconcileFinding[] };

export function classifyPayment(pi: PiFact, txId: string, checkout: CheckoutFact | null, tx: TxFact | null, now: Date, graceMs = RECONCILE_GRACE_MS): PaymentVerdict {
  if (pi.status !== "succeeded") return { kind: "not_paid", status: pi.status };
  const recent = now.getTime() - pi.created * 1000 < graceMs;
  if (!pi.checkoutId) return { kind: "anomaly", findings: [{ kind: "duplicate_or_bad_link", details: ["metadata_checkout_missing"] }] };
  if (!checkout) {
    if (tx) return { kind: "anomaly", findings: [{ kind: "stripe_paid_no_checkout", details: ["transaction_exists"] }] };
    return recent ? { kind: "pending" } : { kind: "anomaly", findings: [{ kind: "stripe_paid_no_checkout", details: [] }] };
  }
  if (!tx) {
    // 注文が別の決済の取引と紐付いている：同じ注文への2回目の支払い（処理待ちにはしない。確定されることはない）
    if (typeof checkout.providerPaymentKey === "string" && checkout.providerPaymentKey && checkout.providerPaymentKey !== txId) {
      return { kind: "anomaly", findings: [{ kind: "duplicate_or_bad_link", details: ["checkout_linked_to_other_payment"] }] };
    }
    return recent ? { kind: "pending" } : { kind: "anomaly", findings: [{ kind: "stripe_paid_no_transaction", details: [] }] };
  }
  const mism: string[] = [];
  if (pi.amount !== PRICE_JPY || pi.amountReceived !== PRICE_JPY || tx.amount !== pi.amount || checkout.amount !== pi.amount) mism.push("amount");
  if (pi.currency !== CURRENCY) mism.push("currency");
  if (tx.livemode !== pi.livemode) mism.push("livemode");
  if (typeof checkout.stripeLivemode === "boolean" && checkout.stripeLivemode !== pi.livemode) mism.push("checkout_livemode");
  if (tx.paymentProvider !== "stripe") mism.push("provider");
  if (checkout.provider !== "stripe") mism.push("checkout_provider");
  if (!pi.storeId || tx.storeId !== pi.storeId || checkout.storeId !== pi.storeId) mism.push("store");
  if (!pi.fortuneType || tx.fortuneType !== pi.fortuneType || checkout.fortuneType !== pi.fortuneType) mism.push("fortune_type");
  if (!pi.latestChargeId || tx.stripeChargeId !== pi.latestChargeId) mism.push("charge");
  const link: string[] = [];
  if (tx.checkoutId !== pi.checkoutId) link.push("transaction_checkout");
  if (tx.stripePaymentIntentId !== pi.id) link.push("transaction_payment_intent");
  if (checkout.providerPaymentKey !== txId) link.push("checkout_link");
  if (typeof tx.stripeCheckoutSessionId !== "string" || tx.stripeCheckoutSessionId !== checkout.providerPaymentId) link.push("session_link");
  if (checkout.status !== "SUCCEEDED" && checkout.status !== "REFUNDED") link.push("checkout_status");
  const findings: ReconcileFinding[] = [];
  if (mism.length) findings.push({ kind: "amount_or_mode_mismatch", details: mism });
  if (link.length) findings.push({ kind: "duplicate_or_bad_link", details: link });
  return findings.length ? { kind: "anomaly", findings } : { kind: "ok" };
}

/** 照合の期間（Unix 秒。from 以上・to 未満）。最長日数 */
export const RECONCILE_MAX_RANGE_DAYS = 31;

/** 期間の検証。to は実行の開始時刻を超えない（実行中に作られた決済で、ページの境目がずれないように） */
export function normalizeRange(fromSec: number, toSec: number, nowMs: number): { ok: true; from: number; to: number } | { ok: false; reason: "invalid" | "too_long" | "future" } {
  if (!Number.isSafeInteger(fromSec) || !Number.isSafeInteger(toSec) || fromSec <= 0 || toSec <= fromSec) return { ok: false, reason: "invalid" };
  const nowSec = Math.floor(nowMs / 1000);
  if (fromSec >= nowSec) return { ok: false, reason: "future" };
  const to = Math.min(toSec, nowSec);
  if (to - fromSec > RECONCILE_MAX_RANGE_DAYS * 86_400) return { ok: false, reason: "too_long" };
  return { ok: true, from: fromSec, to };
}

/**
 * 画面で指定した日付（日本時間の YYYY-MM-DD）の期間を Unix 秒にする。from の日の 0時 から、to の日の翌日の 0時 まで（to の日を含む）。
 * 形が正しくない・存在しない日付は null。
 */
export function jstDayRangeToSec(fromDate: unknown, toDate: unknown): { from: number; to: number } | null {
  const start = (v: unknown): number | null => {
    if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return null;
    const ms = Date.parse(`${v}T00:00:00+09:00`);
    if (!Number.isFinite(ms)) return null;
    // 2026-02-31 などの存在しない日付を弾く（日本時間に戻して同じ日付か）
    const back = new Date(ms + 9 * 3600_000).toISOString().slice(0, 10);
    return back === v ? Math.floor(ms / 1000) : null;
  };
  const f = start(fromDate);
  const t = start(toDate);
  if (f === null || t === null) return null;
  return { from: f, to: t + 86_400 };
}

/**
 * 照合の全体の結果の分類（画面の表示用）。全ページを読み終えるまで「異常なし」にしない。
 *  incomplete   … 途中で止まった（取得の失敗・時間・件数の上限）。続きから再開できる
 *  issues       … 全ページを照合し、異常あり
 *  needs_review … 全ページを照合し、異常は無いが、照合できなかった決済（環境を表す値が無い・形が違う・本番での別の環境）あり
 *  pending      … 全ページを照合し、異常・要確認は無いが、処理待ちあり
 *  ok           … 全ページを照合し、照合したすべての決済で異常なし
 */
export type ReconcileVerdict = "incomplete" | "issues" | "needs_review" | "pending" | "ok";

export function reconcileVerdict(s: { complete: boolean; anomalies: number; needsReview: number; pending: number }): ReconcileVerdict {
  if (!s.complete) return "incomplete";
  if (s.anomalies > 0) return "issues";
  if (s.needsReview > 0) return "needs_review";
  if (s.pending > 0) return "pending";
  return "ok";
}

// ===================== 第2段階a：返金・異議申し立て・精算の調整 =====================

/** 要確認（正常とは判断しない・照合できなかった）の理由 */
export const RECONCILE_REVIEW_LABEL: Record<string, string> = {
  untagged: "環境を表す値が無い",
  bad_tag: "環境を表す値の形が違う",
  other_env: "別の環境",
  refund_partial: "一部の返金（返金の確認の画面で確認が必要）",
  refund_failed: "返金の失敗（返金の確認の画面で確認が必要）",
  refund_invalid: "Stripe の返金の内容を確認できない（別の Charge・通貨・金額の異常）",
  multiple_disputes: "同じ決済に異議申し立てが複数",
  dispute_invalid: "Stripe の異議申し立ての内容を確認できない（別の Charge・モード・金額の異常）",
  charge_not_latest: "返金・異議申し立ての Charge が、決済の最新の Charge ではない",
  not_succeeded: "返金・異議申し立てがあるのに、Stripe の決済が支払い済みではない",
  legacy_settlement: "以前の仕組みで確定した精算の月（支払った額が分からないため判定しない）",
  settlement_import_pending: "精算の確定の後に確定した決済（「精算の作成」で取り込みが必要）",
  too_many_adjustments: "調整の記録が多すぎるため確認していない",
  adjustments_unchecked: "返金・異議申し立ての確認の上限を超えたため確認していない",
};

/** 処理待ちの理由 */
export const RECONCILE_PENDING_LABEL: Record<string, string> = {
  payment: "支払いの直後で、記録がまだ無い",
  refund_sync: "返金の直後で、取引への反映がまだ",
  dispute_sync: "異議申し立ての直後で、取引への反映がまだ",
};

/** Charge から照合に使う値だけ（billing_details などの個人情報は取り出さない） */
export type ChargeFact = { id: string; amount: number | null; amountRefunded: number | null; refunded: boolean; disputed: boolean; livemode: boolean | null };

export function chargeFactOf(raw: unknown): ChargeFact | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.id !== "string" || !CHARGE_ID_RE.test(o.id)) return null;
  return {
    id: o.id,
    amount: intOrNull(o.amount),
    amountRefunded: intOrNull(o.amount_refunded),
    refunded: o.refunded === true,
    disputed: o.disputed === true,
    livemode: typeof o.livemode === "boolean" ? o.livemode : null,
  };
}

/** 返金（Stripe の返金の一覧の1件）から照合に使う値だけ */
export type RefundFact = { id: string; charge: string | null; paymentIntent: string | null; amount: number | null; currency: string | null; status: string; created: number };
/** 異議申し立てから照合に使う値だけ */
export type DisputeFact = { id: string; charge: string | null; paymentIntent: string | null; amount: number | null; currency: string | null; status: string; created: number; livemode: boolean | null; reason: string };

const REFUND_ID_RE = /^(re|pyr)_[A-Za-z0-9_]{1,200}$/;
const DISPUTE_ID_RE = /^(dp|du)_[A-Za-z0-9_]{1,200}$/;
const statusOf = (v: unknown) => (typeof v === "string" && /^[a-z_]{1,40}$/.test(v) ? v : "unknown");
const currencyOf = (v: unknown) => (typeof v === "string" && /^[a-z]{3}$/.test(v) ? v : null);
const createdOf = (v: unknown) => {
  const n = intOrNull(v);
  return n !== null && n > 0 ? n : null;
};

export function refundFactOf(raw: unknown): RefundFact | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const created = createdOf(o.created);
  if (typeof o.id !== "string" || !REFUND_ID_RE.test(o.id) || created === null) return null;
  const ch = idOfRef(o.charge);
  const pi = idOfRef(o.payment_intent);
  return { id: o.id, charge: ch && CHARGE_ID_RE.test(ch) ? ch : null, paymentIntent: pi && PI_ID_RE.test(pi) ? pi : null, amount: intOrNull(o.amount), currency: currencyOf(o.currency), status: statusOf(o.status), created };
}

export function disputeFactOf(raw: unknown): DisputeFact | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const created = createdOf(o.created);
  if (typeof o.id !== "string" || !DISPUTE_ID_RE.test(o.id) || created === null) return null;
  const ch = idOfRef(o.charge);
  const pi = idOfRef(o.payment_intent);
  return {
    id: o.id,
    charge: ch && CHARGE_ID_RE.test(ch) ? ch : null,
    paymentIntent: pi && PI_ID_RE.test(pi) ? pi : null,
    amount: intOrNull(o.amount),
    currency: currencyOf(o.currency),
    status: statusOf(o.status),
    created,
    livemode: typeof o.livemode === "boolean" ? o.livemode : null,
    reason: typeof o.reason === "string" ? o.reason.slice(0, 60) : "",
  };
}

/** 取引の返金・異議申し立て・精算の項目（照合に使う値だけ） */
export type AdjustmentTxFact = {
  paymentStatus: unknown;
  amount: unknown;
  amountRefunded: unknown;
  refundStatus: unknown;
  refundKey: unknown;
  refundPendingAmount: unknown;
  refundFailedAmount: unknown;
  stripeRefundIds: unknown;
  refundNeedsReview: unknown;
  disputeId: unknown;
  disputeStatus: unknown;
  disputeKey: unknown;
  disputeAmount: unknown;
};

/** 取引に返金・異議申し立ての記録があるか（Stripe 側に無くても照合する） */
export function txHasAdjustments(t: AdjustmentTxFact): boolean {
  return (
    (t.refundKey !== null && t.refundKey !== undefined) ||
    (t.refundStatus !== null && t.refundStatus !== undefined) ||
    Number(t.amountRefunded ?? 0) > 0 ||
    (typeof t.disputeId === "string" && t.disputeId !== "") ||
    t.paymentStatus === "REFUNDED" ||
    t.paymentStatus === "CHARGEBACK"
  );
}

/** 決済の一覧の Charge から、返金・異議申し立てを詳しく確かめる必要があるか */
export function chargeNeedsAdjustmentCheck(c: ChargeFact | null, t: AdjustmentTxFact): boolean {
  return txHasAdjustments(t) || !c || Number(c.amountRefunded ?? 0) > 0 || c.refunded || c.disputed;
}

export type AdjustmentVerdict = {
  findings: ReconcileFinding[];
  /** 処理待ち（Stripe の変化の直後で、取引への反映がまだの可能性） */
  pending: ("refund_sync" | "dispute_sync")[];
  /** 要確認（正常とは判断しない） */
  review: string[];
  /** 正常な一時状態（返金の処理中を取引にも反映済み・異議申し立ての対応中） */
  refundInProgress: boolean;
  disputeOpen: boolean;
};

const arr = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

/**
 * 1件の Charge の返金・異議申し立てを、取引の記録と照合する（A・B・C）。
 * 取引の記録は、Webhook の反映（syncStripeRefunds・syncStripeDispute）が書く値（refundKeyOf・disputeKeyOf）と同じ規則で、
 * 今の Stripe の状態から求めた値と比べる。食い違いが、返金・異議申し立ての作成から graceMs 以内なら処理待ち。
 * 返金の状態の変化（処理中 → 成功など）・異議申し立ての状態の変化には Stripe の日時が無いので、変化の直後は異常として出ることがある
 * （画面で「時間をおいて照合し直す」と案内する）。
 */
export function classifyAdjustments(input: { tx: AdjustmentTxFact; chargeId: string; chargeAmount: number; livemode: boolean; refunds: RefundFact[]; disputes: DisputeFact[]; now: Date; graceMs?: number }): AdjustmentVerdict {
  const { tx, chargeId, chargeAmount, refunds, disputes, now } = input;
  const grace = input.graceMs ?? RECONCILE_GRACE_MS;
  const recent = (sec: number) => now.getTime() - sec * 1000 < grace;
  const v: AdjustmentVerdict = { findings: [], pending: [], review: [], refundInProgress: false, disputeOpen: false };
  // ---- 返金（A・B） ----
  const refundsValid = refunds.every((r) => r.charge === chargeId && r.currency === CURRENCY && r.amount !== null && r.amount > 0 && r.amount <= chargeAmount);
  let refundState: string | null = null;
  let succeededAmount = 0;
  if (!refundsValid) v.review.push("refund_invalid");
  else {
    const summary = summarizeRefunds(chargeId, chargeAmount, refunds.map((r) => ({ id: r.id, charge: r.charge, currency: r.currency, amount: r.amount, status: r.status }) as unknown as Stripe.Refund));
    refundState = summary.state;
    succeededAmount = summary.succeededAmount;
    if (summary.state === "none") {
      if (txHasRefund(tx)) v.findings.push({ kind: "refund_mismatch", details: ["not_in_stripe"] });
    } else if (tx.refundKey !== refundKeyOf(summary)) {
      const d: string[] = [];
      if (Number(tx.amountRefunded ?? 0) !== summary.succeededAmount) d.push("amount");
      if (Number(tx.refundPendingAmount ?? 0) !== summary.pendingAmount) d.push("pending_amount");
      if (Number(tx.refundFailedAmount ?? 0) !== summary.failedAmount) d.push("failed_amount");
      if (tx.refundStatus !== summary.state) d.push("status");
      if (arr(tx.stripeRefundIds).slice().sort().join(",") !== summary.refundIds.join(",")) d.push("refund_ids");
      if (!d.length) d.push("refund_key");
      if (recent(Math.max(...refunds.map((r) => r.created)))) v.pending.push("refund_sync");
      else v.findings.push({ kind: "refund_mismatch", details: d });
    } else {
      if (summary.state === "pending") v.refundInProgress = true;
      if ((summary.state === "partial" || summary.state === "failed") && tx.refundNeedsReview === true) v.review.push(summary.state === "partial" ? "refund_partial" : "refund_failed");
    }
  }
  // ---- 異議申し立て（C） ----
  let disputeLostFull = false;
  let disputeValid = true;
  if (disputes.length > 1) {
    v.review.push("multiple_disputes");
    disputeValid = false;
  } else if (disputes.length === 1) {
    const dp = disputes[0];
    if (dp.charge !== chargeId || dp.livemode !== input.livemode || dp.amount === null || disputeAmountProblem({ amount: dp.amount, currency: dp.currency ?? "" }, chargeAmount)) {
      v.review.push("dispute_invalid");
      disputeValid = false;
    } else {
      const state = disputeStateOf(dp.status);
      disputeLostFull = state === "lost" && chargebackCoversRemainder({ amount: chargeAmount, amountRefunded: succeededAmount, disputeStatus: "lost", disputeAmount: dp.amount });
      if (tx.disputeKey !== disputeKeyOf({ id: dp.id, status: dp.status, amount: dp.amount } as Stripe.Dispute)) {
        const d: string[] = [];
        if (tx.disputeId !== dp.id) d.push("dispute_id");
        if (tx.disputeStatus !== state) d.push((tx.disputeStatus === "won" || tx.disputeStatus === "lost") && state === "open" ? "regressed" : "status");
        if (tx.disputeAmount !== dp.amount) d.push("dispute_amount");
        if (!d.length) d.push("dispute_key");
        if (recent(dp.created) && !d.includes("regressed")) v.pending.push("dispute_sync");
        else v.findings.push({ kind: "dispute_mismatch", details: d });
      } else if (state === "open") v.disputeOpen = true;
    }
  } else if (typeof tx.disputeId === "string" && tx.disputeId) {
    v.findings.push({ kind: "dispute_mismatch", details: ["not_in_stripe"] });
  }
  // ---- 決済の状態（返金・異議申し立ての記録が一致しているときだけ。食い違いがあれば上で出ている） ----
  if (refundsValid && disputeValid && !v.findings.length && !v.pending.length) {
    const expected = disputeLostFull ? "CHARGEBACK" : refundState === "succeeded" ? "REFUNDED" : "SUCCEEDED";
    if (tx.paymentStatus !== expected) v.findings.push({ kind: expected === "CHARGEBACK" || tx.paymentStatus === "CHARGEBACK" ? "dispute_mismatch" : "refund_mismatch", details: ["payment_status"] });
  }
  return v;
}

const txHasRefund = (t: AdjustmentTxFact) => (t.refundKey !== null && t.refundKey !== undefined) || (t.refundStatus !== null && t.refundStatus !== undefined) || Number(t.amountRefunded ?? 0) > 0 || t.paymentStatus === "REFUNDED";

/** 精算の判定に使う取引の項目 */
export type SettlementTxFact = { settlementId: unknown; settledShare: unknown; adjustmentTotal: unknown; adjustmentCount: unknown; storeId: unknown };
/** 精算の記録（照合に使う値だけ） */
export type SettlementFact = { status: unknown; lockedAt: boolean };
/** 調整の記録（settlementAdjustments/{取引ID_連番}） */
export type AdjustmentDocFact = { transactionId: unknown; storeId: unknown; sourceSettlementId: unknown; amount: unknown };

/** 1件の取引について確かめる調整の記録の上限（超えたら要確認） */
export const RECONCILE_MAX_ADJUSTMENTS_PER_TX = 20;

export type SettlementVerdict = { kind: "not_applicable"; reason: "not_settlement_payment" | "unpaid_month" } | { kind: "ok" } | { kind: "review"; reason: string } | { kind: "anomaly"; details: string[]; delta: number };

/**
 * 確定済みの精算の調整（D）。entitled は今の時点で店舗に支払うべき取り分（entitledStoreShare）。
 *  - 精算に含めた取引（settlementId あり）：新しい仕組みで確定（lockedAt あり）なら、今の取り分 = 支払った額（settledShare）+ 調整の合計（adjustmentTotal）。
 *    調整の記録（取引ID_1〜n）がすべてあり、取引・店舗・精算が一致し、合計が adjustmentTotal と一致すること（n+1 番目が無いこと）。
 *    過去の精算に含めた取引が後から返金されても、調整が正しく作られていれば異常にしない
 *  - 以前の仕組みで確定（lockedAt なし）：支払った額が分からないので判定しない（要確認）
 *  - 精算に含めていない取引：その月が未払い・精算なしなら対象外（精算の作成で反映）。確定済み（lockedAt あり）なら取り込み待ち（要確認）
 */
export function classifySettlement(input: {
  settlementPayment: boolean;
  entitled: number;
  tx: SettlementTxFact;
  /** tx.settlementId の精算（無ければ null） */
  stamped: SettlementFact | null;
  /** 取引の月の精算（店舗ID_年月。無ければ null） */
  month: SettlementFact | null;
  /** 調整の記録（取引ID_1〜n の順。無いものは null） */
  adjustmentDocs: (AdjustmentDocFact | null)[];
  /** 取引ID_(n+1) の調整の記録があるか */
  extraAdjustmentDoc: boolean;
  txId: string;
}): SettlementVerdict {
  const { tx } = input;
  if (!input.settlementPayment) return { kind: "not_applicable", reason: "not_settlement_payment" };
  if (typeof tx.settlementId === "string" && tx.settlementId) {
    const st = input.stamped;
    if (!st) return { kind: "anomaly", details: ["settlement_not_found"], delta: 0 };
    if (!st.lockedAt) return { kind: "review", reason: "legacy_settlement" };
    const settled = Number(tx.settledShare ?? 0);
    const total = Number(tx.adjustmentTotal ?? 0);
    const count = Number(tx.adjustmentCount ?? 0);
    const d: string[] = [];
    const delta = input.entitled - settled - total;
    if (delta !== 0) d.push("adjustment_total");
    if (!Number.isSafeInteger(count) || count < 0 || count > RECONCILE_MAX_ADJUSTMENTS_PER_TX) return d.length ? { kind: "anomaly", details: d, delta } : { kind: "review", reason: "too_many_adjustments" };
    if (count === 0 && total !== 0) d.push("adjustment_doc_missing");
    const docs = input.adjustmentDocs.slice(0, count);
    if (docs.length < count || docs.some((x) => !x)) d.push("adjustment_doc_missing");
    if (docs.some((x) => x && (x.transactionId !== input.txId || x.storeId !== tx.storeId || x.sourceSettlementId !== tx.settlementId))) d.push("adjustment_doc_mismatch");
    if (count > 0 && docs.every((x) => x) && docs.reduce((a, x) => a + Number(x!.amount ?? 0), 0) !== total) d.push("adjustment_doc_sum");
    if (input.extraAdjustmentDoc) d.push("adjustment_count");
    return d.length ? { kind: "anomaly", details: [...new Set(d)], delta } : { kind: "ok" };
  }
  const m = input.month;
  if (!m || m.status === "UNPAID") return { kind: "not_applicable", reason: "unpaid_month" };
  if (!m.lockedAt) return { kind: "review", reason: "legacy_settlement" };
  return input.entitled > 0 ? { kind: "review", reason: "settlement_import_pending" } : { kind: "ok" };
}

// ===================== 第2段階b：Firestore の取引の一覧（逆方向） =====================

/** 逆方向の照合で、Stripe の一覧をさかのぼる時間（取引の支払日時より前。PaymentIntent は支払いの直前に作られる） */
export const REVERSE_LOOKBACK_SEC = 2 * 3600;

/** Firestore の取引から逆方向の照合に使う値 */
export type ReverseTxFact = { paymentProvider: unknown; livemode: unknown; stripePaymentIntentId: unknown; stripeChargeId: unknown };

export type ReversePrecheck = { kind: "other_provider" } | { kind: "other_mode" } | { kind: "invalid"; details: string[] } | { kind: "check"; paymentIntentId: string };

/**
 * Stripe に問い合わせる前の判定（Firestore の値だけ）。
 *  - Stripe 以外の決済会社（疑似決済・以前の決済会社）・モードが違う取引（本番の Firestore のテスト決済など）は対象外
 *    （本番のキーでテストの決済は取得できず、「Stripe に無い」と誤って判定しないため）
 *  - 文書 ID が stripe_{PaymentIntent} と一致しない・PaymentIntent の ID が無いのは紐付けの不正
 */
export function reversePrecheck(tx: ReverseTxFact, docId: string, live: boolean): ReversePrecheck {
  if (tx.paymentProvider !== "stripe") return { kind: "other_provider" };
  if (tx.livemode !== live) return { kind: "other_mode" };
  const pi = tx.stripePaymentIntentId;
  if (typeof pi !== "string" || !PI_ID_RE.test(pi)) return { kind: "invalid", details: ["tx_payment_intent_invalid"] };
  if (docId !== `stripe_${pi}`) return { kind: "invalid", details: ["tx_id_mismatch"] };
  return { kind: "check", paymentIntentId: pi };
}

export type ReverseVerdict =
  /** 元の決済が照合の期間の中：決済の一覧の段階で照合済み（重ねて数えない） */
  | { kind: "covered" }
  | { kind: "ok" }
  | { kind: "review"; reason: string }
  | { kind: "anomaly"; findings: ReconcileFinding[] };

/**
 * Stripe から得た PaymentIntent（完全な ID で一致したもの。Stripe に無ければ null＝404 を確かめたもの）と、取引の照合。
 * 取得の失敗（認証・通信・レート制限など）はここに来ない（呼び出し側で未完了にする）。
 */
export function classifyReverse(input: { tx: ReverseTxFact; pi: PiFact | null; from: number; to: number; live: boolean; envTag: string }): ReverseVerdict {
  const { tx, pi } = input;
  if (!pi) return { kind: "anomaly", findings: [{ kind: "stripe_payment_missing", details: ["stripe_not_found", "found_via_transactions"] }] };
  if (pi.created >= input.from && pi.created < input.to) return { kind: "covered" };
  const scope = scopeOf(pi, { live: input.live, envTag: input.envTag });
  if (scope === "other_mode") return { kind: "anomaly", findings: [{ kind: "duplicate_or_bad_link", details: ["stripe_livemode", "found_via_transactions"] }] };
  if (scope === "other_env" || scope === "bad_tag") return { kind: "anomaly", findings: [{ kind: "duplicate_or_bad_link", details: ["stripe_other_env", "found_via_transactions"] }] };
  if (scope === "untagged") return { kind: "review", reason: "untagged" };
  if (pi.status !== "succeeded") return { kind: "anomaly", findings: [{ kind: "duplicate_or_bad_link", details: ["stripe_not_paid", "found_via_transactions"] }] };
  if (!pi.latestChargeId || tx.stripeChargeId !== pi.latestChargeId) return { kind: "anomaly", findings: [{ kind: "amount_or_mode_mismatch", details: ["charge", "found_via_transactions"] }] };
  return { kind: "ok" };
}
