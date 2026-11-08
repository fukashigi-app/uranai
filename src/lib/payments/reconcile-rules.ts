import { CURRENCY, PRICE_JPY } from "@/config/pricing";
import { STUCK_PROCESSING_MINUTES } from "./monitor-rules";

/**
 * Stripe 起点の決済照合（F2 第1段階）の判定（純粋な処理。Stripe・Firestore には接続しない）。
 * Stripe の PaymentIntent の一覧を起点に、この環境（metadata の環境を表す値・livemode）の支払い済みの決済が、
 * Firestore の注文（checkouts）・取引（transactions）に正しく記録されているかを判定する。
 * 返金・異議申し立て・精算の照合は第2段階（ここでは扱わない）。
 */

export const RECONCILE_ANOMALY_KINDS = ["stripe_paid_no_checkout", "stripe_paid_no_transaction", "amount_or_mode_mismatch", "duplicate_or_bad_link"] as const;
export type ReconcileAnomalyKind = (typeof RECONCILE_ANOMALY_KINDS)[number];

export const RECONCILE_ANOMALY_LABEL: Record<ReconcileAnomalyKind, string> = {
  stripe_paid_no_checkout: "Stripe で支払い済みだが、注文の記録が無い",
  stripe_paid_no_transaction: "Stripe で支払い済みだが、取引（決済記録）が無い",
  amount_or_mode_mismatch: "Stripe と記録で、金額・モード・店舗などが一致しない",
  duplicate_or_bad_link: "同じ注文への重複した支払い・不正な紐付け",
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
