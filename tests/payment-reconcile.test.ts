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
import { decodeReconcileToken, encodeReconcileToken, ReconcileInputError, resumeReconcile, startReconcile, type ReconcileState } from "@/lib/payments/stripe-reconcile";

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
    v: 1, runId: "r1", userId: "u1", mode: "live", envTag: TAG, accountKey: "k", from: 1, to: 2, startedAt: NOW.getTime(), cursor: "pi_x", done: false, pages: 1,
    counts: { scanned: 0, inScope: 0, matched: 0, notPaid: 0, pending: 0, anomalyPayments: 0, anomalies: 0, otherMode: 0, otherEnv: 0, untagged: 0, badTag: 0, needsReview: 0 },
    byKind: { stripe_paid_no_checkout: 0, stripe_paid_no_transaction: 0, amount_or_mode_mismatch: 0, duplicate_or_bad_link: 0 },
    anomalies: [], pendingItems: [], reviewItems: [], truncated: { anomalies: false, pending: false, review: false, dupIndex: false }, dupIndex: {}, dupIndexSize: 0,
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
