/**
 * 記録が必須の決済要確認を、同じ Stripe の通知では1回だけ数える仕組み（webhookEvents.recordedReviewIds）の E2E 検証。
 * Firestore の決済要確認（paymentReviews）と通知の文書（webhookEvents）を直接読んで確かめる。
 *  - 決済要確認の更新と通知の文書への ID の追加は同じトランザクション（両方か、どちらも無しか）
 *  - 同じ通知：同時・時間差の再送・A→B→A・21件以上の後の古い通知でも1回だけ（件数で切り捨てない）
 *  - 途中の失敗・保存されたか不明（後から保存）でも二重に数えない
 *  - 以前の方式（記録の recentOccurrenceKeys）で記録済みの通知も二重に数えない（新しくは追記しない）
 *  - 通知の文書が無い：回数を増やさず 500。Stripe の再送（beginWebhookEvent が文書を作る）で記録される
 *  - 確認済みの記録への同じ通知の再送は何も変えない
 * 処理済みになる前に止まった通知の再送は、通知の文書の processedAt を空に戻して再現する（処理済みの通知は処理そのものに進まない）。
 * 本物の Stripe・本番の Firebase には一切接続しない（localhost の模擬 Stripe と Firestore Emulator の demo- プロジェクトだけ。キーは形だけの偽物）。
 *
 *   firebase emulators:start --only firestore --project demo-uranai
 *   （別ターミナル）FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 FIREBASE_PROJECT_ID=demo-uranai-review-dedupe DB_PROVIDER=firestore npm run e2e:stripe-review-dedupe
 */
import "dotenv/config";
import assert from "node:assert/strict";
import Stripe from "stripe";
import { createFakeStripe } from "./lib/fake-stripe";
import { C, fsdb, safeId } from "@/lib/firestore/admin";
import { dataProvider } from "@/lib/data-provider";
import { createStore } from "@/lib/services/stores";
import { paymentReviewId, recordRequiredPaymentReview, resolvePaymentReview } from "@/lib/firestore/payment-reviews";
import { beginWebhookEvent, createCheckout } from "@/lib/firestore/payments";
import { createSimulatedStripeRuntime, STRIPE_SESSION_TTL_MS, type StripeRuntime } from "@/lib/payments/stripe-checkout";
import { startStripeCheckout } from "@/lib/payments/stripe-confirm";
import { handleStripeWebhook } from "@/lib/payments/stripe-webhook";

const SYSTEM = { userId: null, role: "SYSTEM" as const };
const OPERATOR = { userId: "op-review-dedupe", role: "OPERATOR" as const };
const step = (msg: string) => console.log(`  ✓ ${msg}`);
const ORIGIN = "http://localhost:3000";
const PORT = 12171;
const KEY = "sk_live_e2e_review_dedupe_dummy";
const WHSEC = "whsec_e2e_review_dedupe_dummy";
const stripe = createFakeStripe({ port: PORT, mode: "live", apiKey: KEY });
const failRecord = new Map<string, number>();

const signer = new Stripe("sk_test_signer");
let evN = 0;
type Ev = { type: string; object: Record<string, unknown>; id: string };
const ev = (type: string, object: Record<string, unknown>): Ev => ({ type, object, id: `evt_rdd_${++evN}_${Date.now()}` });
async function deliver(rt: StripeRuntime, e: Ev) {
  const payload = JSON.stringify({ id: e.id, object: "event", type: e.type, livemode: rt.mode === "live", data: { object: e.object } });
  const sig = signer.webhooks.generateTestHeaderString({ payload, secret: rt.webhookSecret });
  return handleStripeWebhook(payload, sig, rt);
}
const outcomeOf = (r: { body: unknown }) => (r.body as { outcome?: string }).outcome;

type Pay = { checkoutId: string; sessionId: string; charge: string; pi: string; txId: string };
async function paidOnly(rt: StripeRuntime, storeCode: string): Promise<Pay> {
  const { checkoutId, accessToken } = await createCheckout(storeCode, "ZODIAC", { provider: "stripe", ttlMs: STRIPE_SESSION_TTL_MS });
  const r = await startStripeCheckout(accessToken, ORIGIN, rt);
  const sessionId = (r as { url: string }).url.split("/").pop()!;
  const p = await stripe.ctl(`pay/${sessionId}`, { fee: 4 });
  return { checkoutId, sessionId, charge: p.charge!, pi: p.paymentIntent!, txId: `stripe_${p.paymentIntent!}` };
}
/** 決済確定より先の返金（transaction_not_found の記録になる）を用意する */
async function refundedBeforeConfirm(rt: StripeRuntime, code: string) {
  const p = await paidOnly(rt, code);
  await stripe.ctl(`refund/${p.charge}`);
  return p;
}
const refundEv = (p: Pay) => ev("charge.refunded", { id: p.charge, object: "charge" });
const tnfId = (p: Pay) => paymentReviewId("transaction_not_found", p.charge);
const reviewDoc = async (id: string) => (await fsdb().collection(C.paymentReviews).doc(id).get()).data() ?? null;
const eventRef = (eventId: string) => fsdb().collection(C.webhookEvents).doc(safeId("stripe", eventId));
const eventDoc = async (eventId: string) => (await eventRef(eventId).get()).data() ?? null;
/** 処理済みになる前に止まった状態に戻す（同じ通知の再送で、処理そのものをもう一度行わせる） */
const unprocess = (eventId: string) => eventRef(eventId).update({ processedAt: null, state: "RETRYABLE" });

async function main() {
  const host = process.env.FIRESTORE_EMULATOR_HOST ?? "";
  assert.match(host, /^(127\.0\.0\.1|localhost|\[::1\]):\d+$/, "FIRESTORE_EMULATOR_HOST（localhost の Emulator）が必要です");
  assert.match(process.env.FIREBASE_PROJECT_ID ?? "", /^demo-/, "FIREBASE_PROJECT_ID は demo- で始まる Emulator 用の ID にしてください");
  assert.equal(dataProvider(), "firestore");
  for (const k of ["STRIPE_SECRET_KEY", "STRIPE_LIVE_CHECKOUT", "STRIPE_LIVE_OPERATOR_TEST", "VERCEL_ENV"]) delete process.env[k];
  await stripe.start();
  const hooks = {
    beforeReviewRecord: (kind: string) => {
      const n = failRecord.get(kind) ?? 0;
      if (n <= 0) return;
      failRecord.set(kind, n - 1);
      throw Object.assign(new Error("simulated failure of the review record"), { name: "PaymentReviewRecordError" });
    },
  };
  const rt = createSimulatedStripeRuntime("live", { apiBase: `http://127.0.0.1:${PORT}`, secretKey: KEY, webhookSecret: WHSEC, testHooks: hooks });
  const quick = createSimulatedStripeRuntime("live", { apiBase: `http://127.0.0.1:${PORT}`, secretKey: KEY, webhookSecret: WHSEC, testHooks: { reviewRecordTimeoutMs: 1 } });
  console.log(`Stripe review dedupe E2E (emulator ${host} / ${process.env.FIREBASE_PROJECT_ID}, fake Stripe live :${PORT})`);
  const store = await createStore({ name: `要確認重複防止検証店舗 ${Date.now()}`, contactName: "", postalCode: "", address: "", phone: "", email: "" }, SYSTEM);
  const code = store.storeCode;

  // 1. 同じ通知が3件同時（処理そのものは3件とも進む）→ 回数1・通知の文書に ID が1つ
  {
    const p = await refundedBeforeConfirm(rt, code);
    const e = refundEv(p);
    const rs = await Promise.all([deliver(rt, e), deliver(rt, e), deliver(rt, e)]);
    for (const [i, r] of rs.entries()) if (r.status === 500 || r.status === 409) assert.equal((await deliver(rt, e)).status, 200, `${i}: 再送で記録できません`); // 409：処理中の同じ通知（処理権を取れない）
    assert.equal((await reviewDoc(tnfId(p)))?.occurrences, 1, "同時の同じ通知で回数が増えました");
    assert.deepEqual((await eventDoc(e.id))?.recordedReviewIds, [tnfId(p)]);
    // 処理の開始を待たずに、同じ通知の記録を3件同時に書く（記録の書き込みどうしの競合そのもの）
    const q = await refundedBeforeConfirm(rt, code);
    const eq = refundEv(q);
    assert.equal(await beginWebhookEvent("stripe", eq.id, eq.type), true);
    const input = { kind: "transaction_not_found" as const, objectType: "charge" as const, objectId: q.charge, livemode: true };
    const ws = await Promise.allSettled([1, 2, 3].map(() => recordRequiredPaymentReview(input, { webhookEvent: { provider: "stripe", eventId: eq.id } })));
    for (const w of ws) if (w.status === "rejected") await recordRequiredPaymentReview(input, { webhookEvent: { provider: "stripe", eventId: eq.id } }); // 時間切れは再送と同じくもう一度
    assert.equal((await reviewDoc(tnfId(q)))?.occurrences, 1, "同じ通知の記録が同時に書かれて二重に数えました");
    assert.deepEqual((await eventDoc(eq.id))?.recordedReviewIds, [tnfId(q)]);
    step(`同じ通知×3が同時（Webhook で 500 は ${rs.filter((r) => r.status === 500).length} 件。記録の書き込み3件の同時でも）：回数1・通知の文書に ID が1つ`);
  }

  // 2〜4. 時間差の再送・A→B→A・21件以上の後の古い通知（処理済みになる前に止まった通知の再送）
  {
    const p = await refundedBeforeConfirm(rt, code);
    const evs = Array.from({ length: 23 }, () => refundEv(p));
    assert.equal((await deliver(rt, evs[0])).status, 200);
    await unprocess(evs[0].id);
    assert.equal((await deliver(rt, evs[0])).status, 200); // 時間差の再送
    assert.equal((await reviewDoc(tnfId(p)))?.occurrences, 1, "時間差の再送で回数が増えました");
    assert.equal((await deliver(rt, evs[1])).status, 200); // B
    await unprocess(evs[0].id);
    assert.equal((await deliver(rt, evs[0])).status, 200); // A（A→B→A）
    assert.equal((await reviewDoc(tnfId(p)))?.occurrences, 2, "A→B→A で A を二重に数えました");
    for (const e of evs.slice(2)) assert.equal((await deliver(rt, e)).status, 200);
    assert.equal((await reviewDoc(tnfId(p)))?.occurrences, 23);
    for (const e of evs.slice(0, 3)) {
      await unprocess(e.id);
      assert.equal((await deliver(rt, e)).status, 200); // 21件以上の後の古い通知の再送
    }
    assert.equal((await reviewDoc(tnfId(p)))?.occurrences, 23, "古い通知の再送で回数が増えました（件数で切り捨てている）");
    assert.equal((await reviewDoc(tnfId(p)))?.recentOccurrenceKeys, undefined, "以前の方式の項目を新しく書きました");
    step("時間差の再送・A→B→A・23件の後の古い通知3件の再送：回数は通知の数（23）のまま。以前の方式の項目は書かない");
  }

  // 5. 途中の書き込みの失敗：500・どちらにも書かない → 再送で両方
  {
    const p = await refundedBeforeConfirm(rt, code);
    const e = refundEv(p);
    failRecord.set("transaction_not_found", 1);
    assert.equal((await deliver(rt, e)).status, 500);
    assert.deepEqual([await reviewDoc(tnfId(p)), (await eventDoc(e.id))?.recordedReviewIds ?? null], [null, null]);
    assert.equal((await deliver(rt, e)).status, 200);
    assert.deepEqual([(await reviewDoc(tnfId(p)))?.occurrences, (await eventDoc(e.id))?.recordedReviewIds], [1, [tnfId(p)]]);
    step("途中の失敗：500・決済要確認にも通知の文書にも書かない → 再送で両方を1回");
  }

  // 6. 保存されたか不明（待ち時間 1ms）→ 後から両方保存 → 再送で増えない
  {
    const p = await refundedBeforeConfirm(rt, code);
    const e = refundEv(p);
    assert.equal((await deliver(quick, e)).status, 500);
    let rv = null;
    for (let i = 0; i < 50 && !rv; i++) {
      await new Promise((ok) => setTimeout(ok, 100));
      rv = await reviewDoc(tnfId(p));
    }
    assert.ok(rv, "（前提）待つのをやめた後の書き込みが保存されていません");
    assert.deepEqual((await eventDoc(e.id))?.recordedReviewIds, [tnfId(p)], "後から保存された決済要確認と通知の印が一緒ではありません");
    assert.equal((await deliver(rt, e)).status, 200);
    assert.equal((await reviewDoc(tnfId(p)))?.occurrences, 1);
    step("保存されたか不明：後から決済要確認と通知の印が一緒に保存され、再送で二重に数えない");
  }

  // 7. 以前の方式（記録の recentOccurrenceKeys に同じ通知）
  {
    const p = await refundedBeforeConfirm(rt, code);
    const e = refundEv(p);
    await fsdb().collection(C.paymentReviews).doc(tnfId(p)).set({ kind: "transaction_not_found", objectType: "charge", objectId: p.charge, causeKey: JSON.stringify(["transaction_not_found", [], null]), status: "OPEN", occurrences: 7, recentOccurrenceKeys: [`event:${e.id}`], firstSeenAt: new Date(), lastSeenAt: new Date(), resolvedAt: null, resolvedBy: null });
    assert.equal((await deliver(rt, e)).status, 200);
    const d = (await reviewDoc(tnfId(p)))!;
    assert.deepEqual([d.occurrences, d.recentOccurrenceKeys], [7, [`event:${e.id}`]], "以前の方式で記録済みの通知を二重に数えました");
    assert.equal((await eventDoc(e.id))?.recordedReviewIds, undefined);
    assert.equal((await deliver(rt, refundEv(p))).status, 200); // 別の通知
    assert.deepEqual([(await reviewDoc(tnfId(p)))!.occurrences, (await reviewDoc(tnfId(p)))!.recentOccurrenceKeys], [8, [`event:${e.id}`]], "以前の方式の項目に追記しました");
    step("以前の方式で記録済みの通知：二重に数えない（回数7のまま）。別の通知は数え、以前の方式の項目には追記しない");
  }

  // 8. 通知の文書が無い：回数を増やさず例外 → Webhook の再送（文書が作られる）で記録
  {
    const p = await refundedBeforeConfirm(rt, code);
    const e = refundEv(p);
    const input = { kind: "transaction_not_found" as const, objectType: "charge" as const, objectId: p.charge, livemode: true };
    await assert.rejects(recordRequiredPaymentReview(input, { webhookEvent: { provider: "stripe", eventId: e.id } }), { name: "PaymentReviewRecordError" });
    assert.deepEqual([await reviewDoc(tnfId(p)), await eventDoc(e.id)], [null, null], "通知の文書が無いのに記録した・文書を作りました");
    assert.equal((await deliver(rt, e)).status, 200);
    assert.deepEqual([(await reviewDoc(tnfId(p)))?.occurrences, (await eventDoc(e.id))?.recordedReviewIds], [1, [tnfId(p)]]);
    step("通知の文書が無い：回数を増やさず記録もしない（例外＝Webhook では 500）→ 再送で文書が作られて1回記録");
  }

  // 9. 確認済みの記録への同じ通知の再送：何も変えない
  {
    const p = await refundedBeforeConfirm(rt, code);
    const e = refundEv(p);
    assert.equal((await deliver(rt, e)).status, 200);
    assert.equal(await resolvePaymentReview(tnfId(p), OPERATOR), true);
    await unprocess(e.id);
    assert.equal((await deliver(rt, e)).status, 200);
    const d = (await reviewDoc(tnfId(p)))!;
    assert.deepEqual([d.status, d.occurrences, d.resolvedBy], ["RESOLVED", 1, OPERATOR.userId], "確認済みの記録が同じ通知の再送で変わりました");
    step("確認済みの記録への同じ通知の再送：確認済みのまま・回数1のまま");
  }

  // 10. 1件の通知から複数の種類の決済要確認
  {
    const dpId = `dp_live_multi_${Date.now()}`; // 実行ごとに別の対象（Emulator のデータは実行をまたいで残る）
    const e = ev("charge.dispute.updated", { id: dpId, object: "dispute" });
    assert.equal(await beginWebhookEvent("stripe", e.id, e.type), true);
    const a = { kind: "transaction_not_found" as const, objectType: "dispute" as const, objectId: dpId, livemode: true };
    const b = { kind: "dispute_amount_invalid" as const, objectType: "dispute" as const, objectId: dpId, livemode: true, amount: 100 };
    for (let i = 0; i < 2; i++) for (const x of [a, b]) await recordRequiredPaymentReview(x, { webhookEvent: { provider: "stripe", eventId: e.id } });
    assert.deepEqual([(await reviewDoc(paymentReviewId(a.kind, a.objectId)))?.occurrences, (await reviewDoc(paymentReviewId(b.kind, b.objectId)))?.occurrences], [1, 1]);
    assert.deepEqual((await eventDoc(e.id))?.recordedReviewIds, [paymentReviewId(a.kind, a.objectId), paymentReviewId(b.kind, b.objectId)]);
    step("1件の通知から2種類の決済要確認（2回ずつ記録）：それぞれ1回。通知の文書に両方の ID");
  }

  // 11. 決済確定より先の返金：記録して 200 → 決済確定で正しい状態（記録は変わらない）
  {
    const p = await refundedBeforeConfirm(rt, code);
    const e = refundEv(p);
    assert.equal(outcomeOf(await deliver(rt, e)), "ignored");
    assert.equal(outcomeOf(await deliver(rt, ev("checkout.session.completed", { id: p.sessionId, object: "checkout.session" }))), "refunded");
    const t = (await fsdb().collection(C.transactions).doc(p.txId).get()).data()!;
    assert.deepEqual([t.paymentStatus, (await reviewDoc(tnfId(p)))?.occurrences], ["REFUNDED", 1]);
    step("決済確定より先の返金：記録（回数1）→ 後の決済確定で返金済み。記録は増えない");
  }

  assert.equal([...failRecord.values()].reduce((x, n) => x + n, 0), 0, "（前提）用意した記録の失敗がすべて使われていません");
  console.log("\nSTRIPE REVIEW DEDUPE E2E PASSED");
}

main()
  .then(async () => {
    await stripe.stop();
    process.exit(0);
  })
  .catch(async (e) => {
    console.error("\nSTRIPE REVIEW DEDUPE E2E FAILED:", e);
    await stripe.stop().catch(() => {});
    process.exit(1);
  });
