/**
 * 通知の ID が無い経路（決済確定の後の再確認 confirm_recheck・運営の権利の復旧 entitlement_restore）の、記録が必須の決済要確認の E2E 検証。
 * Firestore の決済要確認（paymentReviews）を直接読んで確かめる。
 *  - 新規は回数1。くり返し・同時でも回数を増やさない（最初の日時・既存の回数は変えない。最後の日時は更新）
 *  - 確認済みの記録は、同じ内容なら確認済みのまま
 *  - 通知の ID がある Webhook は、今までどおり通知ごとに1回だけ数える（方式A）
 *  - 通知の文書・新しい重複防止のキーは作らない
 * 本物の Stripe・本番の Firebase には一切接続しない（localhost の模擬 Stripe と Firestore Emulator の demo- プロジェクトだけ。キーは形だけの偽物）。
 *
 *   firebase emulators:start --only firestore --project demo-uranai
 *   （別ターミナル）FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 FIREBASE_PROJECT_ID=demo-uranai-review-noevent DB_PROVIDER=firestore npm run e2e:stripe-review-noevent
 */
import "dotenv/config";
import assert from "node:assert/strict";
import Stripe from "stripe";
import { createFakeStripe } from "./lib/fake-stripe";
import { C, fsdb, safeId } from "@/lib/firestore/admin";
import { dataProvider } from "@/lib/data-provider";
import { createStore } from "@/lib/services/stores";
import { paymentReviewId, resolvePaymentReview } from "@/lib/firestore/payment-reviews";
import { createCheckout } from "@/lib/firestore/payments";
import { createSimulatedStripeRuntime, STRIPE_SESSION_TTL_MS, type StripeRuntime } from "@/lib/payments/stripe-checkout";
import { restoreStripeEntitlement, startStripeCheckout } from "@/lib/payments/stripe-confirm";
import { handleStripeWebhook } from "@/lib/payments/stripe-webhook";

const SYSTEM = { userId: null, role: "SYSTEM" as const };
const OPERATOR = { userId: "op-review-noevent", role: "OPERATOR" as const };
const step = (msg: string) => console.log(`  ✓ ${msg}`);
const ORIGIN = "http://localhost:3000";
const PORT = 12181;
const KEY = "sk_live_e2e_review_noevent_dummy";
const stripe = createFakeStripe({ port: PORT, mode: "live", apiKey: KEY });
/** 決済確定のトランザクションの直後（再確認の前）に実行する処理（テスト専用のフック） */
const hook = { onCommit: null as null | (() => Promise<void>) };

const signer = new Stripe("sk_test_signer");
let evN = 0;
type Ev = { type: string; object: Record<string, unknown>; id: string };
const ev = (type: string, object: Record<string, unknown>): Ev => ({ type, object, id: `evt_rne_${++evN}_${Date.now()}` });
async function deliver(rt: StripeRuntime, e: Ev) {
  const payload = JSON.stringify({ id: e.id, object: "event", type: e.type, livemode: rt.mode === "live", data: { object: e.object } });
  const sig = signer.webhooks.generateTestHeaderString({ payload, secret: rt.webhookSecret });
  return handleStripeWebhook(payload, sig, rt);
}
const outcomeOf = (r: { body: unknown }) => (r.body as { outcome?: string }).outcome;

type Pay = { sessionId: string; charge: string; pi: string; txId: string };
async function paidOnly(rt: StripeRuntime, storeCode: string): Promise<Pay> {
  const { accessToken } = await createCheckout(storeCode, "ZODIAC", { provider: "stripe", ttlMs: STRIPE_SESSION_TTL_MS });
  const r = await startStripeCheckout(accessToken, ORIGIN, rt);
  const sessionId = (r as { url: string }).url.split("/").pop()!;
  const p = await stripe.ctl(`pay/${sessionId}`, { fee: 4 });
  return { sessionId, charge: p.charge!, pi: p.paymentIntent!, txId: `stripe_${p.paymentIntent!}` };
}
const completedEv = (p: Pay) => ev("checkout.session.completed", { id: p.sessionId, object: "checkout.session" });
const reviewRef = (id: string) => fsdb().collection(C.paymentReviews).doc(id);
const reviewDoc = async (id: string) => (await reviewRef(id).get()).data() ?? null;
const ms = (v: unknown) => (v as { toMillis?: () => number })?.toMillis?.() ?? (v instanceof Date ? v.getTime() : NaN);
const webhookEventCount = async () => (await fsdb().collection(C.webhookEvents).count().get()).data().count;

async function main() {
  const host = process.env.FIRESTORE_EMULATOR_HOST ?? "";
  assert.match(host, /^(127\.0\.0\.1|localhost|\[::1\]):\d+$/, "FIRESTORE_EMULATOR_HOST（localhost の Emulator）が必要です");
  assert.match(process.env.FIREBASE_PROJECT_ID ?? "", /^demo-/, "FIREBASE_PROJECT_ID は demo- で始まる Emulator 用の ID にしてください");
  assert.equal(dataProvider(), "firestore");
  for (const k of ["STRIPE_SECRET_KEY", "STRIPE_LIVE_CHECKOUT", "STRIPE_LIVE_OPERATOR_TEST", "VERCEL_ENV"]) delete process.env[k];
  await stripe.start();
  const rt = createSimulatedStripeRuntime("live", {
    apiBase: `http://127.0.0.1:${PORT}`,
    secretKey: KEY,
    webhookSecret: "whsec_e2e_review_noevent_dummy",
    testHooks: { afterConfirmCommit: async () => void (await hook.onCommit?.()) },
  });
  console.log(`Stripe no-event review E2E (emulator ${host} / ${process.env.FIREBASE_PROJECT_ID}, fake Stripe live :${PORT})`);
  const store = await createStore({ name: `通知なし要確認検証店舗 ${Date.now()}`, contactName: "", postalCode: "", address: "", phone: "", email: "" }, SYSTEM);
  const code = store.storeCode;

  // ================= 1. 運営の復旧（entitlement_restore）：くり返し・同時でも回数を増やさない =================
  const p = await paidOnly(rt, code);
  assert.equal(outcomeOf(await deliver(rt, completedEv(p))), "confirmed");
  const dp = stripe.addDispute(p.charge, { status: "lost" });
  assert.equal(outcomeOf(await deliver(rt, ev("charge.dispute.closed", { id: dp, object: "dispute" }))), "dispute_lost");
  await stripe.ctl(`dispute-status/${dp}`, { status: "needs_response" }); // 結果が出た申し立てが対応中に戻る（反映しない＝決済要確認）
  const rid = paymentReviewId("dispute_state_regressed", dp);
  const eventsBefore = await webhookEventCount();
  {
    await restoreStripeEntitlement(p.txId, OPERATOR, "確認のため", rt);
    const first = (await reviewDoc(rid))!;
    assert.deepEqual([first.occurrences, first.status, first.eventType], [1, "OPEN", "entitlement_restore"], "（前提）復旧の操作で決済要確認が記録されていません");
    for (let i = 0; i < 3; i++) await restoreStripeEntitlement(p.txId, OPERATOR, "確認のため", rt);
    await Promise.all([1, 2, 3].map(() => restoreStripeEntitlement(p.txId, OPERATOR, "確認のため", rt)));
    const after = (await reviewDoc(rid))!;
    assert.equal(after.occurrences, 1, "運営の復旧のくり返し・同時で回数が増えました");
    assert.equal(ms(after.firstSeenAt), ms(first.firstSeenAt), "最初の日時が変わりました");
    assert.ok(ms(after.lastSeenAt) > ms(first.lastSeenAt), "最後の日時が更新されていません");
    assert.equal(after.recentOccurrenceKeys, undefined, "新しい重複防止のキーを作りました");
    assert.equal(await webhookEventCount(), eventsBefore, "通知の ID が無い経路で通知の文書を作りました");
    assert.equal((await fsdb().collection(C.transactions).doc(p.txId).get()).get("disputeStatus"), "lost", "敗訴を対応中に戻しました");
    // 確認済みの記録：同じ内容なら確認済みのまま
    assert.equal(await resolvePaymentReview(rid, OPERATOR), true);
    await restoreStripeEntitlement(p.txId, OPERATOR, "確認のため", rt);
    const resolved = (await reviewDoc(rid))!;
    assert.deepEqual([resolved.status, resolved.occurrences, resolved.resolvedBy], ["RESOLVED", 1, OPERATOR.userId], "確認済みの記録が復旧の操作で未確認に戻りました");
    step("運営の復旧（entitlement_restore）×1→×3→同時×3→確認済みの後×1：回数1のまま・最初の日時は不変・最後の日時は更新・確認済みのまま。通知の文書・キーは作らない");
  }

  // ================= 2. 通知の ID がある Webhook：今までどおり通知ごとに数える（方式A） =================
  {
    const e = ev("charge.dispute.updated", { id: dp, object: "dispute" });
    assert.equal((await deliver(rt, e)).status, 200);
    assert.equal((await reviewDoc(rid))!.occurrences, 2, "通知の ID がある Webhook を数えていません");
    await fsdb().collection(C.webhookEvents).doc(safeId("stripe", e.id)).update({ processedAt: null, state: "RETRYABLE" }); // 処理済みの前で止まった再送
    assert.equal((await deliver(rt, e)).status, 200);
    assert.equal((await reviewDoc(rid))!.occurrences, 2, "同じ通知の再送で回数が増えました");
    await restoreStripeEntitlement(p.txId, OPERATOR, "確認のため", rt);
    assert.equal((await reviewDoc(rid))!.occurrences, 2, "Webhook の後の復旧の操作で回数が増えました");
    step("通知の ID がある Webhook は通知ごとに1回（回数2）。同じ通知の再送・その後の復旧の操作では増えない");
  }

  // ================= 3. 決済確定の後の再確認（confirm_recheck）：新規は回数1・既存の記録は回数を増やさない =================
  async function recheckWithStoreMismatch(seed: ((charge: string) => Record<string, unknown>) | null) {
    const q = await paidOnly(rt, code);
    const id = paymentReviewId("charge_mismatch", q.charge);
    if (seed) await reviewRef(id).set(seed(q.charge));
    // 決済確定の直後（再確認の前）に、Stripe 側で店舗の食い違い＋返金が起きる → 再確認の返金の反映で charge_mismatch
    hook.onCommit = async () => {
      hook.onCommit = null;
      await stripe.ctl(`pi-metadata/${q.pi}`, { metadataStoreId: "other-store" });
      await stripe.ctl(`refund/${q.charge}`);
    };
    const r = await deliver(rt, completedEv(q));
    assert.equal(r.status, 500, "（前提）再確認が照合できない返金で PENDING のまま（手順3-1）");
    assert.equal((await fsdb().collection(C.transactions).doc(q.txId).get()).get("recheckState"), "PENDING");
    return { id, doc: (await reviewDoc(id))! };
  }
  {
    const fresh = await recheckWithStoreMismatch(null);
    assert.deepEqual([fresh.doc.occurrences, fresh.doc.eventType, fresh.doc.mismatches, fresh.doc.status], [1, "confirm_recheck", ["store"], "OPEN"]);
    const old = new Date("2026-01-01T00:00:00Z");
    const seeded = await recheckWithStoreMismatch(
      // 以前の仕様で回数が増えた、確認済みの記録（同じ内容）
      (charge) => ({ kind: "charge_mismatch", objectType: "charge", objectId: charge, chargeId: charge, mismatches: ["store"], amount: null, causeKey: JSON.stringify(["charge_mismatch", ["store"], null]), status: "RESOLVED", occurrences: 6, firstSeenAt: old, lastSeenAt: old, resolvedAt: old, resolvedBy: OPERATOR.userId }),
    );
    assert.deepEqual([seeded.doc.occurrences, seeded.doc.status, seeded.doc.resolvedBy, ms(seeded.doc.firstSeenAt), seeded.doc.eventType], [6, "RESOLVED", OPERATOR.userId, old.getTime(), "confirm_recheck"], "再確認で既存の記録の回数・確認済み・最初の日時が変わりました");
    assert.ok(ms(seeded.doc.lastSeenAt) > old.getTime(), "最後の日時が更新されていません");
    step("決済確定の後の再確認（confirm_recheck）：新規は回数1。以前の仕様で回数6の確認済みの記録は、回数6・確認済み・最初の日時のまま（最後の日時は更新）");
  }

  console.log("\nSTRIPE NO-EVENT REVIEW E2E PASSED");
}

main()
  .then(async () => {
    await stripe.stop();
    process.exit(0);
  })
  .catch(async (e) => {
    console.error("\nSTRIPE NO-EVENT REVIEW E2E FAILED:", e);
    await stripe.stop().catch(() => {});
    process.exit(1);
  });
