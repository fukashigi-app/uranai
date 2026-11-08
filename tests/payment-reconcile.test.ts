import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/firestore/admin", () => ({ C: {}, fsdb: () => { throw new Error("no firestore in unit tests"); }, safeId: (...p: string[]) => p.join("_") }));
vi.mock("@/lib/firestore/payment-reviews", () => ({ paymentReviewId: (k: string, id: string) => `${k}_${id}` }));

import {
  classifyPayment,
  jstDayRangeToSec,
  normalizeRange,
  piFactOf,
  reconcileVerdict,
  RECONCILE_GRACE_MS,
  scopeOf,
  type CheckoutFact,
  type PiFact,
  type TxFact,
} from "@/lib/payments/reconcile-rules";
import { decodeReconcileToken, encodeReconcileToken, ReconcileInputError, RECONCILE_LIMITS, RECONCILE_TOKEN_MAX_LENGTH, resumeReconcile, startReconcile, type ReconcileState } from "@/lib/payments/stripe-reconcile";
import { classifyAdjustments, classifyReverse, classifySettlement, chargeFactOf, chargeNeedsAdjustmentCheck, disputeFactOf, refundFactOf, reversePrecheck, type AdjustmentTxFact, type DisputeFact, type RefundFact } from "@/lib/payments/reconcile-rules";

const TAG = "fp_0123456789abcdef";
const OTHER = "fp_fedcba9876543210";
const SECRET = "k8Jq2mZx9Lp4Rt7Vw1Ny6Hb3Gc5Fd0Se!";
const NOW = new Date("2026-11-08T12:00:00Z");
const OLD = Math.floor(NOW.getTime() / 1000) - 3 * 3600;

const rawPi = (o: Record<string, unknown> = {}) => ({
  id: "pi_abc123",
  object: "payment_intent",
  created: OLD,
  livemode: true,
  status: "succeeded",
  amount: 100,
  amount_received: 100,
  currency: "jpy",
  latest_charge: "ch_abc123",
  metadata: { checkoutId: "co_1", storeId: "st_1", fortuneType: "ZODIAC", uranaiEnv: TAG },
  receipt_email: "buyer@example.com",
  client_secret: "pi_abc123_secret_xyz",
  shipping: { name: "山田 太郎" },
  ...o,
});
const fact = (o: Record<string, unknown> = {}) => piFactOf(rawPi(o)) as PiFact;
const TXID = "stripe_pi_abc123";
const checkout = (o: Partial<CheckoutFact> = {}): CheckoutFact => ({ provider: "stripe", status: "SUCCEEDED", amount: 100, storeId: "st_1", fortuneType: "ZODIAC", stripeLivemode: true, providerPaymentId: "cs_live_1", providerPaymentKey: TXID, ...o });
const tx = (o: Partial<TxFact> = {}): TxFact => ({ paymentProvider: "stripe", amount: 100, livemode: true, storeId: "st_1", fortuneType: "ZODIAC", checkoutId: "co_1", stripePaymentIntentId: "pi_abc123", stripeChargeId: "ch_abc123", stripeCheckoutSessionId: "cs_live_1", ...o });

describe("piFactOf：Stripe の応答から決まった項目だけを取り出す", () => {
  it("個人情報・client_secret を含めない", () => {
    const f = fact();
    expect(Object.keys(f).sort()).toEqual(["amount", "amountReceived", "checkoutId", "created", "currency", "envTag", "fortuneType", "id", "latestChargeId", "livemode", "status", "storeId"]);
    const text = JSON.stringify(f);
    for (const s of ["buyer@example.com", "secret", "山田"]) expect(text).not.toContain(s);
  });
  it("形の正しくない応答は null（照合できない）", () => {
    for (const o of [{ id: "ch_1" }, { id: 1 }, { created: "1" }, { livemode: "true" }, { status: 3 }, { object: "charge" }]) expect(piFactOf(rawPi(o))).toBeNull();
    expect(piFactOf(null)).toBeNull();
  });
  it("環境を表す値：無い・空は null、形が違えば invalid。展開された latest_charge は ID を使う", () => {
    expect(fact({ metadata: { checkoutId: "co_1" } }).envTag).toBeNull();
    expect(fact({ metadata: { uranaiEnv: "" } }).envTag).toBeNull();
    expect(fact({ metadata: { uranaiEnv: "prod" } }).envTag).toBe("invalid");
    expect(fact({ latest_charge: { id: "ch_x", object: "charge" } }).latestChargeId).toBe("ch_x");
    expect(fact({ metadata: { checkoutId: "../x", uranaiEnv: TAG } }).checkoutId).toBeNull();
  });
});

describe("scopeOf：対象の判定", () => {
  const rt = { live: true, envTag: TAG };
  it("この環境・別の環境・値なし・形違い・モード違い", () => {
    expect(scopeOf(fact(), rt)).toBe("in_scope");
    expect(scopeOf(fact({ metadata: { uranaiEnv: OTHER } }), rt)).toBe("other_env");
    expect(scopeOf(fact({ metadata: {} }), rt)).toBe("untagged");
    expect(scopeOf(fact({ metadata: { uranaiEnv: "x" } }), rt)).toBe("bad_tag");
    expect(scopeOf(fact({ livemode: false }), rt)).toBe("other_mode");
    expect(scopeOf(fact(), { live: false, envTag: TAG })).toBe("other_mode");
  });
});

describe("classifyPayment：決済1件の判定", () => {
  it("一致", () => expect(classifyPayment(fact(), TXID, checkout(), tx(), NOW)).toEqual({ kind: "ok" }));
  it("支払いが完了していないものは照合しない", () => {
    for (const status of ["processing", "requires_payment_method", "requires_action", "canceled"]) expect(classifyPayment(fact({ status }), TXID, null, null, NOW)).toEqual({ kind: "not_paid", status });
  });
  it("注文が無い：処理待ちの時間を過ぎたら異常。取引があれば時間によらず異常", () => {
    expect(classifyPayment(fact(), TXID, null, null, NOW)).toEqual({ kind: "anomaly", findings: [{ kind: "stripe_paid_no_checkout", details: [] }] });
    const recent = fact({ created: Math.floor((NOW.getTime() - RECONCILE_GRACE_MS + 60_000) / 1000) });
    expect(classifyPayment(recent, TXID, null, null, NOW)).toEqual({ kind: "pending" });
    expect(classifyPayment(recent, TXID, null, tx(), NOW)).toEqual({ kind: "anomaly", findings: [{ kind: "stripe_paid_no_checkout", details: ["transaction_exists"] }] });
  });
  it("処理待ちの境界（ちょうど60分は異常）", () => {
    const at = (ms: number) => fact({ created: Math.floor((NOW.getTime() - ms) / 1000) });
    expect(classifyPayment(at(RECONCILE_GRACE_MS - 1000), TXID, checkout({ providerPaymentKey: null, status: "PROCESSING" }), null, NOW).kind).toBe("pending");
    expect(classifyPayment(at(RECONCILE_GRACE_MS), TXID, checkout({ providerPaymentKey: null, status: "PROCESSING" }), null, NOW).kind).toBe("anomaly");
  });
  it("取引が無い", () => {
    expect(classifyPayment(fact(), TXID, checkout({ providerPaymentKey: null, status: "PROCESSING" }), null, NOW)).toEqual({ kind: "anomaly", findings: [{ kind: "stripe_paid_no_transaction", details: [] }] });
  });
  it("注文が別の決済と紐付いている（同じ注文への2回目の支払い）は、処理待ちにせず重複", () => {
    const recent = fact({ created: Math.floor(NOW.getTime() / 1000) - 60 });
    expect(classifyPayment(recent, TXID, checkout({ providerPaymentKey: "stripe_pi_other" }), null, NOW)).toEqual({ kind: "anomaly", findings: [{ kind: "duplicate_or_bad_link", details: ["checkout_linked_to_other_payment"] }] });
  });
  it("metadata に注文の ID が無い", () => {
    expect(classifyPayment(fact({ metadata: { uranaiEnv: TAG } }), TXID, null, null, NOW)).toEqual({ kind: "anomaly", findings: [{ kind: "duplicate_or_bad_link", details: ["metadata_checkout_missing"] }] });
  });
  it("金額・モード・店舗・種類・Charge の不一致", () => {
    const cases: [Partial<TxFact>, Partial<CheckoutFact>, Record<string, unknown>, string][] = [
      [{ amount: 200 }, {}, {}, "amount"],
      [{}, { amount: 200 }, {}, "amount"],
      [{}, {}, { amount_received: 50 }, "amount"],
      [{}, {}, { currency: "usd" }, "currency"],
      [{ livemode: false }, {}, {}, "livemode"],
      [{}, { stripeLivemode: false }, {}, "checkout_livemode"],
      [{ paymentProvider: "mock" }, {}, {}, "provider"],
      [{ storeId: "st_2" }, {}, {}, "store"],
      [{ fortuneType: "BLOOD" }, {}, {}, "fortune_type"],
      [{ stripeChargeId: "ch_other" }, {}, {}, "charge"],
    ];
    for (const [t, co, p, detail] of cases) {
      const v = classifyPayment(fact(p), TXID, checkout(co), tx(t), NOW);
      expect(v.kind, detail).toBe("anomaly");
      if (v.kind === "anomaly") expect(v.findings.find((f) => f.kind === "amount_or_mode_mismatch")?.details, detail).toContain(detail);
    }
  });
  it("不正な紐付け", () => {
    const cases: [Partial<TxFact>, Partial<CheckoutFact>, string][] = [
      [{ checkoutId: "co_2" }, {}, "transaction_checkout"],
      [{ stripePaymentIntentId: "pi_other" }, {}, "transaction_payment_intent"],
      [{}, { providerPaymentKey: "stripe_pi_other" }, "checkout_link"],
      [{ stripeCheckoutSessionId: "cs_live_2" }, {}, "session_link"],
      [{}, { status: "PROCESSING" }, "checkout_status"],
    ];
    for (const [t, co, detail] of cases) {
      const v = classifyPayment(fact(), TXID, checkout(co), tx(t), NOW);
      expect(v.kind === "anomaly" && v.findings.find((f) => f.kind === "duplicate_or_bad_link")?.details, detail).toContain(detail);
    }
    // 返金済みの注文は確定済みとして扱う（返金の照合は第2段階）
    expect(classifyPayment(fact(), TXID, checkout({ status: "REFUNDED" }), tx(), NOW)).toEqual({ kind: "ok" });
  });
});

describe("期間・結果の分類", () => {
  it("normalizeRange：to は今の時刻まで・最長31日・未来の開始は不可", () => {
    const now = NOW.getTime();
    const n = Math.floor(now / 1000);
    expect(normalizeRange(n - 86_400, n + 86_400, now)).toEqual({ ok: true, from: n - 86_400, to: n });
    expect(normalizeRange(n - 32 * 86_400, n, now)).toEqual({ ok: false, reason: "too_long" });
    expect(normalizeRange(n + 10, n + 20, now)).toEqual({ ok: false, reason: "future" });
    expect(normalizeRange(n, n - 1, now)).toEqual({ ok: false, reason: "invalid" });
    expect(normalizeRange(1.5, n, now)).toEqual({ ok: false, reason: "invalid" });
  });
  it("jstDayRangeToSec：日本時間の日付（終了日を含む）。存在しない日付は null", () => {
    expect(jstDayRangeToSec("2026-11-01", "2026-11-07")).toEqual({ from: Date.parse("2026-10-31T15:00:00Z") / 1000, to: Date.parse("2026-11-07T15:00:00Z") / 1000 });
    for (const [a, b] of [["2026-02-31", "2026-03-01"], ["2026/11/01", "2026-11-02"], [1, "2026-11-02"]]) expect(jstDayRangeToSec(a, b)).toBeNull();
  });
  it("reconcileVerdict：全ページを読み終えるまで異常なしにしない", () => {
    expect(reconcileVerdict({ complete: false, anomalies: 0, needsReview: 0, pending: 0 })).toBe("incomplete");
    expect(reconcileVerdict({ complete: true, anomalies: 1, needsReview: 1, pending: 1 })).toBe("issues");
    expect(reconcileVerdict({ complete: true, anomalies: 0, needsReview: 1, pending: 1 })).toBe("needs_review");
    expect(reconcileVerdict({ complete: true, anomalies: 0, needsReview: 0, pending: 1 })).toBe("pending");
    expect(reconcileVerdict({ complete: true, anomalies: 0, needsReview: 0, pending: 0 })).toBe("ok");
  });
});

describe("再開用の値（署名）", () => {
  const base = (): ReconcileState => ({
    v: 3, runId: "r1", userId: "u1", mode: "live", envTag: TAG, accountKey: "k", from: 1, to: 2, startedAt: NOW.getTime(), phase: "payments", cursor: "pi_x", done: false, pages: 1,
    counts: { scanned: 0, inScope: 0, matched: 0, notPaid: 0, pending: 0, anomalyPayments: 0, anomalies: 0, otherMode: 0, otherEnv: 0, untagged: 0, badTag: 0, needsReview: 0, adjustmentChecks: 0, adjustmentIssues: 0, refundsSeen: 0, disputesSeen: 0, refundInProgress: 0, disputeOpen: 0, settlementChecked: 0, txScanned: 0, txOtherProvider: 0, txOtherMode: 0, txCovered: 0, txMatched: 0, reverseLookups: 0 },
    byKind: { stripe_paid_no_checkout: 0, stripe_paid_no_transaction: 0, amount_or_mode_mismatch: 0, duplicate_or_bad_link: 0, refund_mismatch: 0, dispute_mismatch: 0, settlement_adjustment_mismatch: 0, stripe_payment_missing: 0 },
    anomalies: [], pendingItems: [], reviewItems: [], truncated: { anomalies: false, pending: false, review: false, dupIndex: false, checked: false }, dupIndex: {}, dupIndexSize: 0, checked: [], metrics: { stripeCalls: 0, firestoreReads: 0 },
  });
  it("署名を確かめて取り出す。書き換え・別の鍵・形違いは invalid_token", () => {
    const t = encodeReconcileToken(base(), SECRET);
    expect(decodeReconcileToken(t, SECRET).cursor).toBe("pi_x");
    const [body, sig] = t.split(".");
    const forged = Buffer.from(JSON.stringify({ ...base(), from: 0 })).toString("base64url");
    for (const bad of [`${forged}.${sig}`, `${body}.x${sig.slice(1)}`, `${body}`, `${body}.${sig}.x`, 123]) {
      expect(() => decodeReconcileToken(bad, SECRET)).toThrow(ReconcileInputError);
    }
    expect(() => decodeReconcileToken(t, "another-strong-secret-value-0123456789")).toThrow(/invalid_token/);
  });
  it("以前の版（v2：第2段階a まで）の再開用の値は、正しい鍵で署名されていても読まない（最初から照合し直す）", async () => {
    const old = encodeReconcileToken({ ...base(), v: 2 } as unknown as ReconcileState, SECRET);
    expect(() => decodeReconcileToken(old, SECRET)).toThrow(/invalid_token/);
    const client = { paymentIntents: { list: vi.fn() } };
    await expect(resumeReconcile({ rt: { mode: "live", envTag: TAG, accountId: undefined, client } as never, userId: "u1", token: old, now: NOW, secret: SECRET })).rejects.toThrow(/invalid_token/);
    expect(client.paymentIntents.list).not.toHaveBeenCalled();
  });
  it("弱い鍵では作らない・読まない", () => {
    expect(() => encodeReconcileToken(base(), "short")).toThrow(/secret_unavailable/);
    expect(() => decodeReconcileToken("a.b", undefined)).toThrow(/secret_unavailable/);
  });
  it("再開：運営者・モード・環境・アカウント・期限・完了済みが違えば再開しない（Stripe には接続しない）", async () => {
    const client = { paymentIntents: { list: vi.fn() }, accounts: { retrieveCurrent: vi.fn() } };
    const rt = { mode: "live", envTag: TAG, accountId: undefined, client } as never;
    const tok = (o: Partial<ReconcileState>) => encodeReconcileToken({ ...base(), accountKey: "x", ...o }, SECRET);
    const run = (token: string, opts: { userId?: string; now?: Date; rt?: never } = {}) => resumeReconcile({ rt: opts.rt ?? rt, userId: opts.userId ?? "u1", token, now: opts.now ?? NOW, secret: SECRET });
    await expect(run(tok({}), { userId: "u2" })).rejects.toThrow(/token_user_mismatch/);
    await expect(run(tok({ mode: "test" }))).rejects.toThrow(/token_environment_mismatch/);
    await expect(run(tok({ envTag: OTHER }))).rejects.toThrow(/token_environment_mismatch/);
    await expect(run(tok({}))).rejects.toThrow(/token_environment_mismatch/); // accountKey が接続のものと違う
    await expect(run(tok({}), { now: new Date(NOW.getTime() + 3 * 3600_000) })).rejects.toThrow(/expired_token/);
    expect(client.paymentIntents.list).not.toHaveBeenCalled();
  });
  it("開始：期間の検証（最長31日・未来・形）。署名の鍵が無ければ始めない", async () => {
    const rt = { mode: "live", envTag: TAG, accountId: undefined, client: { paymentIntents: { list: vi.fn() } } } as never;
    const n = Math.floor(NOW.getTime() / 1000);
    await expect(startReconcile({ rt, userId: "u1", fromSec: n - 40 * 86_400, toSec: n, now: NOW, secret: SECRET })).rejects.toThrow(/range_too_long/);
    await expect(startReconcile({ rt, userId: "u1", fromSec: n + 100, toSec: n + 200, now: NOW, secret: SECRET })).rejects.toThrow(/range_future/);
    await expect(startReconcile({ rt, userId: "u1", fromSec: n - 100, toSec: n, now: NOW, secret: "weak" })).rejects.toThrow(/secret_unavailable/);
  });
});

describe("第2段階a：返金・異議申し立て（classifyAdjustments）", () => {
  const CH = "ch_abc123";
  const old = Math.floor(NOW.getTime() / 1000) - 3 * 3600;
  const recentSec = Math.floor(NOW.getTime() / 1000) - 60;
  const re = (o: Partial<RefundFact> = {}): RefundFact => ({ id: "re_1", charge: CH, paymentIntent: "pi_abc123", amount: 100, currency: "jpy", status: "succeeded", created: old, ...o });
  const dp = (o: Partial<DisputeFact> = {}): DisputeFact => ({ id: "dp_1", charge: CH, paymentIntent: "pi_abc123", amount: 100, currency: "jpy", status: "needs_response", created: old, livemode: true, reason: "fraudulent", ...o });
  const none: AdjustmentTxFact = { paymentStatus: "SUCCEEDED", amount: 100, amountRefunded: 0, refundStatus: null, refundKey: null, refundPendingAmount: 0, refundFailedAmount: 0, stripeRefundIds: [], refundNeedsReview: false, disputeId: null, disputeStatus: null, disputeKey: null, disputeAmount: null };
  const synced = (state: string, ok: number, pend: number, fail: number, ids: string[], extra: Partial<AdjustmentTxFact> = {}): AdjustmentTxFact => ({
    ...none, refundStatus: state, refundKey: `${state}:${ok}:${pend}:${fail}:${ids.join(",")}`, amountRefunded: ok, refundPendingAmount: pend, refundFailedAmount: fail, stripeRefundIds: ids, refundNeedsReview: state === "partial" || state === "failed", paymentStatus: state === "succeeded" ? "REFUNDED" : "SUCCEEDED", ...extra,
  });
  const run = (tx: AdjustmentTxFact, refunds: RefundFact[] = [], disputes: DisputeFact[] = []) => classifyAdjustments({ tx, chargeId: CH, chargeAmount: 100, livemode: true, refunds, disputes, now: NOW });
  it("返金なし・返金の記録なし：一致", () => expect(run(none)).toEqual({ findings: [], pending: [], review: [], refundInProgress: false, disputeOpen: false }));
  it("A：全額返金を反映済みなら一致。反映が無ければ異常（作成から60分以内は処理待ち）", () => {
    expect(run(synced("succeeded", 100, 0, 0, ["re_1"]), [re()]).findings).toEqual([]);
    expect(run(none, [re()]).findings).toEqual([{ kind: "refund_mismatch", details: ["amount", "status", "refund_ids"] }]);
    expect(run(none, [re({ created: recentSec })])).toMatchObject({ findings: [], pending: ["refund_sync"] });
  });
  it("A：返金済みの額だけ違う・決済の状態だけ違う", () => {
    expect(run(synced("succeeded", 100, 0, 0, ["re_1"], { paymentStatus: "SUCCEEDED" }), [re()]).findings).toEqual([{ kind: "refund_mismatch", details: ["payment_status"] }]);
    expect(run({ ...synced("succeeded", 100, 0, 0, ["re_1"]), refundKey: "x", amountRefunded: 50 }, [re()]).findings).toEqual([{ kind: "refund_mismatch", details: ["amount"] }]);
  });
  it("A：取引に返金の記録があるのに Stripe に無い（時間によらず異常）", () => {
    expect(run(synced("succeeded", 100, 0, 0, ["re_1"])).findings).toEqual([{ kind: "refund_mismatch", details: ["not_in_stripe"] }]);
  });
  it("B：返金の処理中を反映済みなら一時状態（異常にしない）。部分返金・失敗は要確認（確認済みなら要確認にしない）", () => {
    expect(run(synced("pending", 0, 100, 0, ["re_1"]), [re({ status: "pending" })])).toMatchObject({ findings: [], refundInProgress: true, review: [] });
    expect(run(synced("partial", 50, 0, 0, ["re_1"]), [re({ amount: 50 })])).toMatchObject({ findings: [], review: ["refund_partial"] });
    expect(run(synced("failed", 0, 0, 100, ["re_1"]), [re({ status: "failed" })])).toMatchObject({ findings: [], review: ["refund_failed"] });
    expect(run(synced("partial", 50, 0, 0, ["re_1"], { refundNeedsReview: false }), [re({ amount: 50 })])).toMatchObject({ findings: [], review: [] });
  });
  it("B：Stripe は成功に変わったのに取引は処理中のまま（状態の変化の直後でも Stripe に日時が無いので異常として出る）", () => {
    expect(run(synced("pending", 0, 100, 0, ["re_1"]), [re()]).findings).toEqual([{ kind: "refund_mismatch", details: ["amount", "pending_amount", "status"] }]);
  });
  it("返金の内容がおかしい（別の Charge・通貨・金額）は要確認（判定しない）", () => {
    for (const r of [re({ charge: "ch_other" }), re({ currency: "usd" }), re({ amount: 0 }), re({ amount: 200 })]) expect(run(none, [r])).toMatchObject({ findings: [], review: ["refund_invalid"] });
  });
  it("C：異議申し立ての対応中・勝訴・敗訴を反映済みなら一致。反映が無い・状態が違う・Stripe に無いは異常", () => {
    const tx = (status: string, state: string, extra: Partial<AdjustmentTxFact> = {}) => ({ ...none, disputeId: "dp_1", disputeStatus: state, disputeKey: `dp_1:${status}:100`, disputeAmount: 100, ...extra });
    expect(run(tx("needs_response", "open"), [], [dp()])).toMatchObject({ findings: [], disputeOpen: true });
    expect(run(tx("won", "won"), [], [dp({ status: "won" })]).findings).toEqual([]);
    expect(run(tx("lost", "lost", { paymentStatus: "CHARGEBACK" }), [], [dp({ status: "lost" })]).findings).toEqual([]);
    expect(run(tx("lost", "lost"), [], [dp({ status: "lost" })]).findings).toEqual([{ kind: "dispute_mismatch", details: ["payment_status"] }]);
    expect(run(none, [], [dp()]).findings).toEqual([{ kind: "dispute_mismatch", details: ["dispute_id", "status", "dispute_amount"] }]);
    expect(run(none, [], [dp({ created: recentSec })])).toMatchObject({ findings: [], pending: ["dispute_sync"] });
    expect(run(tx("needs_response", "open"), [], [dp({ status: "won" })]).findings).toEqual([{ kind: "dispute_mismatch", details: ["status"] }]);
    expect(run(tx("won", "won"), [], [dp({ status: "under_review", created: recentSec })]).findings).toEqual([{ kind: "dispute_mismatch", details: ["regressed"] }]);
    expect(run(tx("needs_response", "open")).findings).toEqual([{ kind: "dispute_mismatch", details: ["not_in_stripe"] }]);
  });
  it("C：異議申し立てが複数・内容がおかしいは要確認", () => {
    expect(run(none, [], [dp(), dp({ id: "dp_2" })]).review).toEqual(["multiple_disputes"]);
    for (const d of [dp({ charge: "ch_x" }), dp({ livemode: false }), dp({ amount: 500 }), dp({ currency: "usd" })]) expect(run(none, [], [d]).review).toEqual(["dispute_invalid"]);
  });
  it("詳しく確かめる条件：Stripe（返金額・全額返金・異議申し立て）か取引に記録があるとき", () => {
    const c = chargeFactOf({ id: CH, amount: 100, amount_refunded: 0, refunded: false, disputed: false, livemode: true, billing_details: { email: "a@example.com" } })!;
    expect(Object.keys(c).sort()).toEqual(["amount", "amountRefunded", "disputed", "id", "livemode", "refunded"]);
    expect(chargeNeedsAdjustmentCheck(c, none)).toBe(false);
    expect(chargeNeedsAdjustmentCheck({ ...c, amountRefunded: 10 }, none)).toBe(true);
    expect(chargeNeedsAdjustmentCheck({ ...c, disputed: true }, none)).toBe(true);
    expect(chargeNeedsAdjustmentCheck(c, synced("pending", 0, 100, 0, ["re_1"]))).toBe(true);
    expect(chargeNeedsAdjustmentCheck(c, { ...none, disputeId: "dp_1" })).toBe(true);
    expect(chargeNeedsAdjustmentCheck(null, none)).toBe(true);
  });
  it("Stripe の応答から決まった項目だけを取り出す（形の違うものは null）", () => {
    expect(refundFactOf({ id: "re_1", charge: CH, payment_intent: "pi_abc123", amount: 100, currency: "jpy", status: "succeeded", created: old, metadata: { x: "y" } })).toEqual(re());
    expect(refundFactOf({ id: "ch_1", created: old })).toBeNull();
    expect(disputeFactOf({ id: "dp_1", charge: { id: CH }, payment_intent: "pi_abc123", amount: 100, currency: "jpy", status: "needs_response", created: old, livemode: true, reason: "fraudulent", evidence: { customer_email_address: "a@example.com" } })).toEqual(dp());
    expect(disputeFactOf({ id: "dp_1" })).toBeNull();
  });
});

describe("第2段階a：確定済みの精算の調整（classifySettlement）", () => {
  const TX = "stripe_pi_abc123";
  const locked = { status: "PAID", lockedAt: true };
  const adj = (amount: number, o: Record<string, unknown> = {}) => ({ transactionId: TX, storeId: "st_1", sourceSettlementId: "st_1_2026-10", amount, ...o });
  const base = { settlementPayment: true, entitled: 30, tx: { settlementId: "st_1_2026-10", settledShare: 30, adjustmentTotal: 0, adjustmentCount: 0, storeId: "st_1" }, stamped: locked, month: null, adjustmentDocs: [], extraAdjustmentDoc: false, txId: TX };
  it("精算に含めた取引：支払った額＋調整＝今の取り分なら一致", () => expect(classifySettlement(base)).toEqual({ kind: "ok" }));
  it("精算の後に返金され、調整が正しく作られていれば一致（過去の精算に返金済みの取引が含まれるだけでは異常にしない）", () => {
    expect(classifySettlement({ ...base, entitled: 0, tx: { ...base.tx, adjustmentTotal: -30, adjustmentCount: 1 }, adjustmentDocs: [adj(-30)] })).toEqual({ kind: "ok" });
  });
  it("D：調整が無い（差額あり）", () => {
    expect(classifySettlement({ ...base, entitled: 0 })).toEqual({ kind: "anomaly", details: ["adjustment_total"], delta: -30 });
  });
  it("D：adjustmentTotal だけ一致して、調整の記録が欠けている・合計が違う・取引が違う・件数が違う", () => {
    const t = { ...base.tx, adjustmentTotal: -30, adjustmentCount: 1 };
    expect(classifySettlement({ ...base, entitled: 0, tx: t, adjustmentDocs: [null] })).toEqual({ kind: "anomaly", details: ["adjustment_doc_missing"], delta: 0 });
    expect(classifySettlement({ ...base, entitled: 0, tx: t, adjustmentDocs: [adj(-10)] })).toEqual({ kind: "anomaly", details: ["adjustment_doc_sum"], delta: 0 });
    expect(classifySettlement({ ...base, entitled: 0, tx: t, adjustmentDocs: [adj(-30, { transactionId: "stripe_pi_other" })] })).toEqual({ kind: "anomaly", details: ["adjustment_doc_mismatch"], delta: 0 });
    expect(classifySettlement({ ...base, entitled: 0, tx: t, adjustmentDocs: [adj(-30)], extraAdjustmentDoc: true })).toEqual({ kind: "anomaly", details: ["adjustment_count"], delta: 0 });
    expect(classifySettlement({ ...base, entitled: 0, tx: { ...t, adjustmentCount: 0 } })).toEqual({ kind: "anomaly", details: ["adjustment_doc_missing"], delta: 0 });
  });
  it("以前の仕組みで確定した精算は判定しない（要確認）。精算の記録が無いのは異常", () => {
    expect(classifySettlement({ ...base, stamped: { status: "PAID", lockedAt: false } })).toEqual({ kind: "review", reason: "legacy_settlement" });
    expect(classifySettlement({ ...base, tx: { ...base.tx, settlementId: null }, stamped: null, month: { status: "PAID", lockedAt: false } })).toEqual({ kind: "review", reason: "legacy_settlement" });
    expect(classifySettlement({ ...base, stamped: null })).toEqual({ kind: "anomaly", details: ["settlement_not_found"], delta: 0 });
  });
  it("精算に含めていない取引：未払い・精算なしは対象外。確定済みの月なら取り込み待ち（要確認。取り分0なら一致）。テスト決済は対象外", () => {
    const nos = { ...base, tx: { ...base.tx, settlementId: null }, stamped: null };
    expect(classifySettlement({ ...nos, month: null })).toEqual({ kind: "not_applicable", reason: "unpaid_month" });
    expect(classifySettlement({ ...nos, month: { status: "UNPAID", lockedAt: false } })).toEqual({ kind: "not_applicable", reason: "unpaid_month" });
    expect(classifySettlement({ ...nos, month: locked })).toEqual({ kind: "review", reason: "settlement_import_pending" });
    expect(classifySettlement({ ...nos, month: locked, entitled: 0 })).toEqual({ kind: "ok" });
    expect(classifySettlement({ ...base, settlementPayment: false })).toEqual({ kind: "not_applicable", reason: "not_settlement_payment" });
  });
});

describe("再開用の値の最大の大きさ（すべての上限まで埋めた状態）", () => {
  it("API の要求の上限（RECONCILE_TOKEN_MAX_LENGTH）を十分下回る", () => {
    const L = RECONCILE_LIMITS;
    const id = (p: string, i: number, n = 24) => `${p}_3${String(i).padStart(n, "0")}`;
    const uuid = (i: number) => `${String(i).padStart(8, "0")}-0000-4000-8000-000000000000`;
    const s: ReconcileState = {
      v: 3, runId: uuid(1), userId: uuid(2), mode: "live", envTag: TAG, accountKey: "k".repeat(24), from: 1, to: 2, startedAt: NOW.getTime(), phase: "transactions", cursor: `1800000000000|stripe_${id("pi", 1)}`, done: false, pages: 999,
      counts: { scanned: 1e6, inScope: 1e6, matched: 1e6, notPaid: 1e6, pending: 1e6, anomalyPayments: 1e6, anomalies: 1e6, otherMode: 1e6, otherEnv: 1e6, untagged: 1e6, badTag: 1e6, needsReview: 1e6, adjustmentChecks: 1e6, adjustmentIssues: 1e6, refundsSeen: 1e6, disputesSeen: 1e6, refundInProgress: 1e6, disputeOpen: 1e6, settlementChecked: 1e6, txScanned: 1e6, txOtherProvider: 1e6, txOtherMode: 1e6, txCovered: 1e6, txMatched: 1e6, reverseLookups: 1e6 },
      byKind: { stripe_paid_no_checkout: 1e6, stripe_paid_no_transaction: 1e6, amount_or_mode_mismatch: 1e6, duplicate_or_bad_link: 1e6, refund_mismatch: 1e6, dispute_mismatch: 1e6, settlement_adjustment_mismatch: 1e6, stripe_payment_missing: 1e6 },
      anomalies: Array.from({ length: L.maxListed }, (_, i) => ({ kind: "settlement_adjustment_mismatch" as const, details: ["adjustment_total", "adjustment_doc_missing", "adjustment_doc_mismatch", "adjustment_doc_sum", "adjustment_count"], paymentIntentId: id("pi", i), chargeId: id("ch", i), checkoutId: uuid(i), transactionId: `stripe_${id("pi", i)}`, storeId: uuid(i), created: 1_800_000_000, existingReview: true, delta: -100 })),
      pendingItems: Array.from({ length: L.maxListed }, (_, i) => ({ paymentIntentId: id("pi", i), checkoutId: uuid(i), created: 1_800_000_000, reason: "dispute_sync", chargeId: id("ch", i), transactionId: `stripe_${id("pi", i)}` })),
      reviewItems: Array.from({ length: L.maxListed }, (_, i) => ({ paymentIntentId: id("pi", i), checkoutId: uuid(i), created: 1_800_000_000, scope: "other_env", reason: "settlement_import_pending", chargeId: id("ch", i), transactionId: `stripe_${id("pi", i)}` })),
      truncated: { anomalies: true, pending: true, review: true, dupIndex: true, checked: true },
      dupIndex: Object.fromEntries(Array.from({ length: L.maxDupIndex }, (_, i) => [uuid(i), [{ p: id("pi", i), t: 1_800_000_000, ch: id("ch", i), s: uuid(i), st: "anomaly" as const, dup: true }]])),
      dupIndexSize: L.maxDupIndex,
      checked: Array.from({ length: L.maxChecked }, (_, i) => String(i).padStart(12, "a")),
      metrics: { stripeCalls: 1e6, firestoreReads: 1e6 },
    };
    const token = encodeReconcileToken(s, SECRET);
    const req = JSON.stringify({ action: "resume", token });
    console.info(`worst-case token ${(token.length / 1024).toFixed(1)}KB / request ${(req.length / 1024).toFixed(1)}KB / limit ${(RECONCILE_TOKEN_MAX_LENGTH / 1024).toFixed(1)}KB`);
    expect(token.length).toBeLessThan(RECONCILE_TOKEN_MAX_LENGTH * 0.85);
    expect(decodeReconcileToken(token, SECRET).checked).toHaveLength(L.maxChecked);
  });
  it("上限（800KB）を超える再開用の値は読まずに拒否し、Stripe に接続しない（途中の結果は未完了のまま。正常終了にしない）", async () => {
    const big = `${"a".repeat(RECONCILE_TOKEN_MAX_LENGTH)}.sig`;
    expect(() => decodeReconcileToken(big, SECRET)).toThrow(/invalid_token/);
    const client = { paymentIntents: { list: vi.fn() }, accounts: { retrieveCurrent: vi.fn() } };
    await expect(resumeReconcile({ rt: { mode: "live", envTag: TAG, accountId: undefined, client } as never, userId: "u1", token: big, now: NOW, secret: SECRET })).rejects.toThrow(/invalid_token/);
    expect(client.paymentIntents.list).not.toHaveBeenCalled();
  });
});

describe("第2段階b：Firestore の取引の一覧（逆方向）", () => {
  const tx = (o: Record<string, unknown> = {}) => ({ paymentProvider: "stripe", livemode: true, stripePaymentIntentId: "pi_abc123", stripeChargeId: "ch_abc123", ...o });
  it("Stripe に問い合わせる前：決済会社・モードの違いは対象外、文書 ID・PaymentIntent の ID の不正は紐付けの異常", () => {
    expect(reversePrecheck(tx(), "stripe_pi_abc123", true)).toEqual({ kind: "check", paymentIntentId: "pi_abc123" });
    expect(reversePrecheck(tx({ paymentProvider: "mock" }), "stripe_pi_abc123", true)).toEqual({ kind: "other_provider" });
    expect(reversePrecheck(tx({ livemode: false }), "stripe_pi_abc123", true)).toEqual({ kind: "other_mode" });
    expect(reversePrecheck(tx({ livemode: undefined }), "stripe_pi_abc123", true)).toEqual({ kind: "other_mode" });
    expect(reversePrecheck(tx(), "stripe_pi_other", true)).toEqual({ kind: "invalid", details: ["tx_id_mismatch"] });
    expect(reversePrecheck(tx({ stripePaymentIntentId: null }), "stripe_x", true)).toEqual({ kind: "invalid", details: ["tx_payment_intent_invalid"] });
  });
  const from = Math.floor(NOW.getTime() / 1000) - 86_400;
  const to = Math.floor(NOW.getTime() / 1000);
  const run = (pi: PiFact | null, t = tx()) => classifyReverse({ tx: t, pi, from, to, live: true, envTag: TAG });
  it("Stripe に無い（404 を確かめたもの）は stripe_payment_missing", () => {
    expect(run(null)).toEqual({ kind: "anomaly", findings: [{ kind: "stripe_payment_missing", details: ["stripe_not_found", "found_via_transactions"] }] });
  });
  it("元の決済が期間の中なら照合済み（決済の一覧の段階の結果と重ねない）。状態によらない", () => {
    expect(run(fact({ created: from }))).toEqual({ kind: "covered" });
    expect(run(fact({ created: to - 1, status: "canceled" }))).toEqual({ kind: "covered" });
  });
  it("期間の境目（作成は期間より前・支払いは期間の中）：一致すれば正常。返金済みでも PaymentIntent は支払い済みのまま", () => {
    expect(run(fact({ created: from - 1 }))).toEqual({ kind: "ok" });
  });
  it("期間の外の決済の不一致：モード・環境・未払い・Charge・環境を表す値なし", () => {
    const before = { created: from - 100 };
    expect(run(fact({ ...before, livemode: false }))).toMatchObject({ kind: "anomaly", findings: [{ kind: "duplicate_or_bad_link", details: ["stripe_livemode", "found_via_transactions"] }] });
    expect(run(fact({ ...before, metadata: { checkoutId: "co_1", uranaiEnv: OTHER } }))).toMatchObject({ findings: [{ details: ["stripe_other_env", "found_via_transactions"] }] });
    expect(run(fact({ ...before, status: "requires_payment_method" }))).toMatchObject({ findings: [{ details: ["stripe_not_paid", "found_via_transactions"] }] });
    expect(run(fact(before), tx({ stripeChargeId: "ch_other" }))).toEqual({ kind: "anomaly", findings: [{ kind: "amount_or_mode_mismatch", details: ["charge", "found_via_transactions"] }] });
    expect(run(fact({ ...before, metadata: { checkoutId: "co_1" } }))).toEqual({ kind: "review", reason: "untagged" });
  });
});

describe("第2段階b：取引の段階で Firestore を読めないとき", () => {
  it("未完了（firestore_error）。取引の段階で止まり、異常なしと表示しない", async () => {
    const empty = { object: "list", data: [], has_more: false };
    const client = { paymentIntents: { list: vi.fn(async () => empty), retrieve: vi.fn() }, refunds: { list: vi.fn(async () => empty) }, disputes: { list: vi.fn(async () => empty) } };
    const rt = { mode: "live", envTag: TAG, accountId: undefined, client } as never;
    const n = Math.floor(NOW.getTime() / 1000);
    const r = await startReconcile({ rt, userId: "u1", fromSec: n - 3600, toSec: n, now: NOW, secret: SECRET });
    expect([r.verdict, r.stoppedBy, r.state.phase, r.state.done]).toEqual(["incomplete", "firestore_error", "transactions", false]);
    expect(r.token).toBeTruthy();
    expect(client.paymentIntents.retrieve).not.toHaveBeenCalled();
  });
});
