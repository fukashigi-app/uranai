import "server-only";
import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import type { DocumentReference, DocumentSnapshot } from "firebase-admin/firestore";
import { C, fsdb, safeId } from "@/lib/firestore/admin";
import { paymentReviewId } from "@/lib/firestore/payment-reviews";
import { isSessionSecretStrong } from "@/lib/env-rules";
import { ensureStripeAccount, StripeAccountMismatchError, type StripeMode, type StripeRuntime } from "./stripe-checkout";
import {
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
};
/**
 * 重複の判定の索引の1件（注文 ID ごと。ページをまたいで判定するため、再開用の値に入れる）。
 * p=PaymentIntent・t=作成日時・ch=Charge・s=店舗・st=結果に数えた分類・dup=重複として数えたか
 */
export type ReconcileDupEntry = { p: string; t: number; ch: string | null; s: string | null; st: "pending" | "anomaly"; dup: boolean };
/** 処理待ち・要確認の1件 */
export type ReconcileRef = { paymentIntentId: string; checkoutId: string | null; created: number; scope?: ReconcileScope };

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
  /** 要確認：照合できなかった支払い済みの決済（値が無い・形が違う・本番の接続での別の環境） */
  needsReview: number;
};

export type ReconcileState = {
  v: 1;
  runId: string;
  userId: string;
  mode: StripeMode;
  envTag: string;
  accountKey: string;
  from: number;
  to: number;
  startedAt: number;
  cursor: string | null;
  done: boolean;
  pages: number;
  counts: ReconcileCounts;
  byKind: Record<ReconcileAnomalyKind, number>;
  anomalies: ReconcileItem[];
  pendingItems: ReconcileRef[];
  reviewItems: ReconcileRef[];
  /** dupIndex＝重複の判定の索引が上限に達し、それ以降の決済の重複を判定していない */
  truncated: { anomalies: boolean; pending: boolean; review: boolean; dupIndex: boolean };
  /** 重複の判定の索引（注文 ID → 未確定の支払い済みの決済） */
  dupIndex: Record<string, ReconcileDupEntry[]>;
  dupIndexSize: number;
};

export type ReconcileStop = "time" | "page_limit" | "stripe_error" | "firestore_error" | "unexpected_response" | "account_mismatch";

export const RECONCILE_STOP_LABEL: Record<ReconcileStop, string> = {
  time: "1回の実行の時間の上限に達した",
  page_limit: "1回の実行で読むページの上限に達した",
  stripe_error: "Stripe の一覧を取得できなかった",
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

const emptyCounts = (): ReconcileCounts => ({ scanned: 0, inScope: 0, matched: 0, notPaid: 0, pending: 0, anomalyPayments: 0, anomalies: 0, otherMode: 0, otherEnv: 0, untagged: 0, badTag: 0, needsReview: 0 });
const emptyByKind = (): Record<ReconcileAnomalyKind, number> => ({ stripe_paid_no_checkout: 0, stripe_paid_no_transaction: 0, amount_or_mode_mismatch: 0, duplicate_or_bad_link: 0 });

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
  if (!s || s.v !== 1 || typeof s.runId !== "string" || typeof s.startedAt !== "number" || typeof s.from !== "number" || typeof s.to !== "number") throw new ReconcileInputError("invalid_token");
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
    v: 1,
    runId: randomUUID(),
    userId: opts.userId,
    mode: opts.rt.mode,
    envTag: opts.rt.envTag,
    accountKey: accountKeyOf(opts.rt),
    from: range.from,
    to: range.to,
    startedAt: now.getTime(),
    cursor: null,
    done: false,
    pages: 0,
    counts: emptyCounts(),
    byKind: emptyByKind(),
    anomalies: [],
    pendingItems: [],
    reviewItems: [],
    truncated: { anomalies: false, pending: false, review: false, dupIndex: false },
    dupIndex: {},
    dupIndexSize: 0,
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
  if (!s.dupIndex || typeof s.dupIndex !== "object" || !Number.isSafeInteger(s.dupIndexSize) || typeof s.truncated?.dupIndex !== "boolean") throw new ReconcileInputError("invalid_token");
  return runSegment(s, opts.rt, L, secret);
}

const clone = (s: ReconcileState): ReconcileState => JSON.parse(JSON.stringify(s)) as ReconcileState;

function pushCapped<T>(list: T[], item: T, max: number): boolean {
  if (list.length >= max) return false;
  list.push(item);
  return true;
}

const CHECKOUT_FIELDS = ["provider", "status", "amount", "storeId", "fortuneType", "stripeLivemode", "providerPaymentId", "providerPaymentKey"];
const TX_FIELDS = ["paymentProvider", "amount", "livemode", "storeId", "fortuneType", "checkoutId", "stripePaymentIntentId", "stripeChargeId", "stripeCheckoutSessionId"];

/** ID で読む（照合に使う項目だけ。注文のトークンなどは読まない）。存在しなければ null */
async function readByIds(refs: DocumentReference[], fields: string[]): Promise<Map<string, DocumentSnapshot>> {
  const out = new Map<string, DocumentSnapshot>();
  for (let i = 0; i < refs.length; i += 100) {
    const part = refs.slice(i, i + 100);
    if (!part.length) continue;
    const snaps = await fsdb().getAll(...part, { fieldMask: fields });
    for (const s of snaps) out.set(s.ref.path, s);
  }
  return out;
}

class Stop extends Error {
  constructor(public readonly reason: ReconcileStop) {
    super(reason);
    this.name = "ReconcileStop";
  }
}

async function runSegment(start: ReconcileState, rt: StripeRuntime, L: ReconcileLimits, secret: string | undefined): Promise<ReconcileRun> {
  let state = start;
  const t0 = Date.now();
  let segmentPages = 0;
  let stoppedBy: ReconcileStop | null = null;
  const live = rt.mode === "live";
  try {
    try {
      await ensureStripeAccount(rt); // 本番：キーが設定したアカウントのものか（GET /v1/account。読むだけ）
    } catch (e) {
      throw new Stop(e instanceof StripeAccountMismatchError ? "account_mismatch" : "stripe_error");
    }
    while (!state.done) {
      if (segmentPages >= L.maxPagesPerSegment) throw new Stop("page_limit");
      if (Date.now() - t0 > L.deadlineMs) throw new Stop("time");
      // 1. Stripe の一覧（1ページ）。取得系だけ（展開は使わない：latest_charge は ID のまま返る）
      let page: { data?: unknown; has_more?: unknown };
      try {
        page = await rt.client.paymentIntents.list({ created: { gte: state.from, lt: state.to }, limit: L.pageSize, ...(state.cursor ? { starting_after: state.cursor } : {}) });
      } catch (e) {
        console.error("[payment-reconcile] stripe list failed", { error: (e as Error)?.name });
        throw new Stop("stripe_error");
      }
      if (!Array.isArray(page.data) || typeof page.has_more !== "boolean" || page.data.length > L.pageSize) throw new Stop("unexpected_response");
      const facts: PiFact[] = [];
      for (const raw of page.data) {
        const f = piFactOf(raw); // ここで ID・状態・金額・metadata の決まった項目だけにする（元の応答は保存しない）
        if (!f || f.created < state.from || f.created >= state.to) throw new Stop("unexpected_response");
        facts.push(f);
      }
      if (page.has_more && facts.length === 0) throw new Stop("unexpected_response"); // 続きがあるのに空（続きの位置を進められない）
      if (state.cursor && facts.some((f) => f.id === state.cursor)) throw new Stop("unexpected_response"); // 同じページの繰り返し

      // 2. この環境の支払い済みの決済について、Firestore の注文・取引を ID で読む
      const next = clone(state);
      const c = next.counts;
      const now = new Date();
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
      const coRef = (id: string) => fsdb().collection(C.checkouts).doc(id);
      const txRef = (pi: string) => fsdb().collection(C.transactions).doc(safeId("stripe", pi));
      try {
        const coIds = [...new Set(paid.map((f) => f.checkoutId).filter((x): x is string => !!x))];
        [checkouts, txs] = await Promise.all([readByIds(coIds.map(coRef), CHECKOUT_FIELDS), readByIds(paid.map((f) => txRef(f.id)), TX_FIELDS)]);
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
      const found: ReconcileItem[] = [];
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
      // 4. 異常の決済が、決済要確認（F1：Webhook の受信のときの記録）に記録済みか（ID で読むだけ。新しく記録はしない）
      const charges = [...new Set(found.map((x) => x.chargeId).filter((x): x is string => !!x))];
      if (charges.length) {
        try {
          const reviews = await readByIds(charges.map((ch) => fsdb().collection(C.paymentReviews).doc(paymentReviewId("paid_checkout_unconfirmable", ch))), ["status"]);
          const has = new Set(charges.filter((ch) => reviews.get(fsdb().collection(C.paymentReviews).doc(paymentReviewId("paid_checkout_unconfirmable", ch)).path)?.exists));
          for (const x of found) x.existingReview = !!x.chargeId && has.has(x.chargeId);
        } catch (e) {
          console.error("[payment-reconcile] firestore read failed", { error: (e as Error)?.name });
          throw new Stop("firestore_error");
        }
      }
      for (const x of found) if (!pushCapped(next.anomalies, x, L.maxListed)) next.truncated.anomalies = true;

      // 5. このページを結果に加え、続きの位置を進める（ここまですべて成功したときだけ）
      next.pages++;
      next.cursor = facts.length ? facts[facts.length - 1].id : next.cursor;
      if (!page.has_more) next.done = true;
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
