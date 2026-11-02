/**
 * 決済確定より先に届いた返金・異議申し立ての通知（課題2・対策A）の E2E 検証。
 * この環境の注文があり Session が紐付いている決済（正常な先着）は、先に決済を確定してから反映し、決済要確認を記録しない。
 * 注文が無い・Session が紐付いていない・PaymentIntent と Session が一致しない・確定が拒否されるときは、本当の異常として
 * 今までどおり transaction_not_found を記録する。Stripe API の一時的な失敗・支払いの確定待ちは 500（処理済みにしない）で、再送で処理する。
 * Firestore（決済記録・占い権利・注文・決済要確認・通知の記録）を直接読んで確かめる。
 * 本物の Stripe・本番の Firebase には一切接続しない（localhost の模擬 Stripe と Firestore Emulator の demo- プロジェクトだけ。キーは形だけの偽物）。
 *
 *   firebase emulators:start --only firestore --project demo-uranai
 *   （別ターミナル）FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 FIREBASE_PROJECT_ID=demo-uranai-early-sync DB_PROVIDER=firestore npm run e2e:stripe-early-sync
 */
import "dotenv/config";
import assert from "node:assert/strict";
import Stripe from "stripe";
import { createFakeStripe } from "./lib/fake-stripe";
import { C, fsdb, safeId } from "@/lib/firestore/admin";
import { dataProvider } from "@/lib/data-provider";
import { createStore } from "@/lib/services/stores";
import { paymentReviewId } from "@/lib/firestore/payment-reviews";
import { createCheckout } from "@/lib/firestore/payments";
import { createSimulatedStripeRuntime, STRIPE_SESSION_TTL_MS, type StripeRuntime } from "@/lib/payments/stripe-checkout";
import { confirmStripeCheckout, startStripeCheckout } from "@/lib/payments/stripe-confirm";
import { handleStripeWebhook } from "@/lib/payments/stripe-webhook";

const SYSTEM = { userId: null, role: "SYSTEM" as const };
const step = (msg: string) => console.log(`  ✓ ${msg}`);
const ORIGIN = "http://localhost:3000";
const PORT = 12161;
const KEY = "sk_live_e2e_early_sync_dummy";
const WHSEC = "whsec_e2e_early_sync_dummy";
const stripe = createFakeStripe({ port: PORT, mode: "live", apiKey: KEY });

const signer = new Stripe("sk_test_signer");
let evN = 0;
type Ev = { type: string; object: Record<string, unknown>; id: string };
const ev = (type: string, object: Record<string, unknown>): Ev => ({ type, object, id: `evt_esy_${++evN}_${Date.now()}` });
async function deliver(rt: StripeRuntime, e: Ev) {
  const payload = JSON.stringify({ id: e.id, object: "event", type: e.type, livemode: rt.mode === "live", data: { object: e.object } });
  const sig = signer.webhooks.generateTestHeaderString({ payload, secret: rt.webhookSecret });
  return handleStripeWebhook(payload, sig, rt);
}
const outcomeOf = (r: { body: unknown }) => (r.body as { outcome?: string }).outcome;

type Pay = { checkoutId: string; sessionId: string; charge: string; pi: string; txId: string };
async function paidOnly(rt: StripeRuntime, storeCode: string, opts: { async?: boolean } = {}): Promise<Pay> {
  const { checkoutId, accessToken } = await createCheckout(storeCode, "ZODIAC", { provider: "stripe", ttlMs: STRIPE_SESSION_TTL_MS });
  const r = await startStripeCheckout(accessToken, ORIGIN, rt);
  const sessionId = (r as { url: string }).url.split("/").pop()!;
  const p = await stripe.ctl(`pay/${sessionId}`, { fee: 4, ...(opts.async ? { method: "paypay", async: true } : {}) });
  return { checkoutId, sessionId, charge: p.charge!, pi: p.paymentIntent!, txId: `stripe_${p.paymentIntent!}` };
}
const completedEv = (p: Pay) => ev("checkout.session.completed", { id: p.sessionId, object: "checkout.session" });
const refundEv = (p: Pay) => ev("charge.refunded", { id: p.charge, object: "charge" });
const disputeEv = (dpId: string, type = "charge.dispute.created") => ev(type, { id: dpId, object: "dispute" });

const txDoc = async (p: Pay) => (await fsdb().collection(C.transactions).doc(p.txId).get()).data() ?? null;
const fsDoc = async (p: Pay) => (await fsdb().collection(C.fortuneSessions).doc(p.txId).get()).data() ?? null;
const coDoc = async (p: Pay) => (await fsdb().collection(C.checkouts).doc(p.checkoutId).get()).data() ?? null;
const eventDoc = async (eventId: string) => (await fsdb().collection(C.webhookEvents).doc(safeId("stripe", eventId)).get()).data() ?? null;
/** その決済（Charge）の決済要確認の件数（種類を問わない） */
const reviewsOfCharge = async (chargeId: string) => (await fsdb().collection(C.paymentReviews).where("chargeId", "==", chargeId).get()).docs.map((d) => d.data());
const reviewOf = async (objectId: string) => (await fsdb().collection(C.paymentReviews).doc(paymentReviewId("transaction_not_found", objectId)).get()).data() ?? null;
const txCountOfCharge = async (chargeId: string) => (await fsdb().collection(C.transactions).where("stripeChargeId", "==", chargeId).get()).size;
const sessionGets = (sessionId: string) => stripe.fake.callLog.filter((c) => c === `GET /v1/checkout/sessions/${sessionId}`).length;

/** 本当の異常：transaction_not_found（指定の対象）を1件記録して 200（処理済み）。決済記録は作らない */
async function expectAnomaly(p: Pay, e: Ev, objectId: string, objectType: "charge" | "dispute", label: string) {
  const r = await deliver(rtLive(), e);
  assert.equal(r.status, 200, `${label}: 応答 ${r.status}`);
  assert.equal(outcomeOf(r), "ignored", `${label}: 結果`);
  const rv = await reviewOf(objectId);
  assert.deepEqual([rv?.status, rv?.occurrences, rv?.objectType, rv?.chargeId, rv?.paymentIntentId, rv?.eventType], ["OPEN", 1, objectType, p.charge, p.pi, e.type], `${label}: 決済要確認の記録`);
  assert.deepEqual((await eventDoc(e.id))?.recordedReviewIds, [paymentReviewId("transaction_not_found", objectId)], `${label}: 通知の文書の記録の ID`);
  assert.ok((await eventDoc(e.id))?.processedAt, `${label}: 処理済みになっていません`);
  assert.equal(await txDoc(p), null, `${label}: 決済記録を作りました`);
}

let RT: StripeRuntime | null = null;
const rtLive = () => RT!;

async function main() {
  const host = process.env.FIRESTORE_EMULATOR_HOST ?? "";
  assert.match(host, /^(127\.0\.0\.1|localhost|\[::1\]):\d+$/, "FIRESTORE_EMULATOR_HOST（localhost の Emulator）が必要です");
  assert.match(process.env.FIREBASE_PROJECT_ID ?? "", /^demo-/, "FIREBASE_PROJECT_ID は demo- で始まる Emulator 用の ID にしてください");
  assert.equal(dataProvider(), "firestore");
  for (const k of ["STRIPE_SECRET_KEY", "STRIPE_LIVE_CHECKOUT", "STRIPE_LIVE_OPERATOR_TEST", "VERCEL_ENV"]) delete process.env[k];
  await stripe.start();
  const rt = createSimulatedStripeRuntime("live", { apiBase: `http://127.0.0.1:${PORT}`, secretKey: KEY, webhookSecret: WHSEC });
  RT = rt;
  console.log(`Stripe early refund/dispute E2E (emulator ${host} / ${process.env.FIREBASE_PROJECT_ID}, fake Stripe live :${PORT})`);
  const store = await createStore({ name: `先着通知検証店舗 ${Date.now()}`, contactName: "", postalCode: "", address: "", phone: "", email: "" }, SYSTEM);
  const code = store.storeCode;

  // ================= 1. 返金の通知が先着：決済確定の通知なしで正常に処理（記録しない） =================
  {
    const p = await paidOnly(rt, code);
    await stripe.ctl(`refund/${p.charge}`);
    const e = refundEv(p);
    const r = await deliver(rt, e);
    assert.equal(r.status, 200);
    assert.equal(outcomeOf(r), "unchanged"); // 確定の中で返金済みとして記録済み（やり直しの反映は変化なし）
    const [t, fs, co] = [await txDoc(p), await fsDoc(p), await coDoc(p)];
    assert.deepEqual([t?.paymentStatus, t?.refundStatus, t?.amountRefunded, t?.countable, fs?.status, fs?.suspendedByRefund, co?.status, co?.refundReason], ["REFUNDED", "succeeded", 100, false, "EXPIRED", true, "REFUNDED", "refund"]);
    assert.deepEqual(await reviewsOfCharge(p.charge), [], "正常な先着の返金で決済要確認を記録しました");
    assert.equal((await eventDoc(e.id))?.recordedReviewIds, undefined);
    assert.equal(await txCountOfCharge(p.charge), 1);
    step("返金の通知が先着（確定の通知なし）：先に確定して返金済みとして記録（REFUNDED・権利 EXPIRED・注文 REFUNDED）。決済要確認は0件");
  }

  // ================= 2. 異議申し立ての通知が先着：対応中・敗訴とも、決済確定の通知なしで正常に処理（記録しない） =================
  {
    const p = await paidOnly(rt, code);
    const dp = stripe.addDispute(p.charge); // needs_response（対応中）
    const r = await deliver(rt, disputeEv(dp));
    assert.equal(r.status, 200);
    let [t, fs, co] = [await txDoc(p), await fsDoc(p), await coDoc(p)];
    assert.deepEqual([t?.paymentStatus, t?.disputeStatus, t?.disputeId, t?.disputeAmount, fs?.status, co?.status], ["SUCCEEDED", "open", dp, 100, "PAID", "SUCCEEDED"]);
    // その後 敗訴：通常の反映（決済記録がある）
    await stripe.ctl(`dispute-status/${dp}`, { status: "lost" });
    assert.equal(outcomeOf(await deliver(rt, disputeEv(dp, "charge.dispute.closed"))), "dispute_lost");
    [t, fs, co] = [await txDoc(p), await fsDoc(p), await coDoc(p)];
    assert.deepEqual([t?.paymentStatus, t?.disputeStatus, fs?.status, fs?.suspendedByDispute, co?.status, co?.refundReason], ["CHARGEBACK", "lost", "EXPIRED", true, "REFUNDED", "chargeback"]);
    assert.deepEqual(await reviewsOfCharge(p.charge), [], "正常な先着の異議申し立てで決済要確認を記録しました");

    // 敗訴の状態で初めて届く（確定より先・確定の通知なし）：最初から権利を止めて記録
    const q = await paidOnly(rt, code);
    const dq = stripe.addDispute(q.charge, { status: "lost" });
    assert.equal((await deliver(rt, disputeEv(dq, "charge.dispute.closed"))).status, 200);
    const [tq, fq, cq] = [await txDoc(q), await fsDoc(q), await coDoc(q)];
    assert.deepEqual([tq?.paymentStatus, tq?.disputeStatus, fq?.status, fq?.usedAt, cq?.status, cq?.refundReason], ["CHARGEBACK", "lost", "EXPIRED", null, "REFUNDED", "chargeback"]);
    assert.deepEqual(await reviewsOfCharge(q.charge), []);
    assert.equal(await txCountOfCharge(q.charge), 1);
    step("異議申し立ての通知が先着（確定の通知なし）：対応中は権利 PAID・注文 SUCCEEDED で記録 → 敗訴で CHARGEBACK。敗訴が先着でも最初から止めて記録。決済要確認は0件");
  }

  // ================= 3. 注文が存在しない（返金・異議申し立て）：本当の異常として記録 =================
  {
    const p = await paidOnly(rt, code);
    await fsdb().collection(C.checkouts).doc(p.checkoutId).delete();
    await stripe.ctl(`refund/${p.charge}`);
    const before = sessionGets(p.sessionId);
    await expectAnomaly(p, refundEv(p), p.charge, "charge", "注文が無い（返金）");
    assert.equal(sessionGets(p.sessionId), before, "注文が無いのに Session を取りに行きました（確定を試みた）");

    const q = await paidOnly(rt, code);
    await fsdb().collection(C.checkouts).doc(q.checkoutId).delete();
    const dq = stripe.addDispute(q.charge);
    await expectAnomaly(q, disputeEv(dq), dq, "dispute", "注文が無い（異議申し立て）");
    step("注文が存在しない：返金・異議申し立てとも transaction_not_found を記録して 200。確定は試みない・決済記録は作らない");
  }

  // ================= 4. Checkout Session が注文に紐付いていない：本当の異常（推測で Session を探さない） =================
  {
    const p = await paidOnly(rt, code);
    await fsdb().collection(C.checkouts).doc(p.checkoutId).update({ providerPaymentId: null });
    await stripe.ctl(`refund/${p.charge}`);
    const before = sessionGets(p.sessionId);
    await expectAnomaly(p, refundEv(p), p.charge, "charge", "Session が紐付いていない");
    assert.equal(sessionGets(p.sessionId), before, "紐付いていない Session を取りに行きました");
    step("Checkout Session が注文に紐付いていない：transaction_not_found を記録して 200。Session を探さない・確定しない");
  }

  // ================= 5. PaymentIntent と Checkout Session が一致しない：本当の異常。通知の対象ではない B は確定しない =================
  {
    // A の PaymentIntent の注文IDが、別の注文 B を指している（B の Session は B の決済。支払い済み・未払いの両方）
    for (const bPaid of [true, false]) {
      const a = await paidOnly(rt, code);
      let b: Pay;
      if (bPaid) b = await paidOnly(rt, code);
      else {
        // B は Session を作っただけ（未払い）
        const { checkoutId, accessToken } = await createCheckout(code, "ZODIAC", { provider: "stripe", ttlMs: STRIPE_SESSION_TTL_MS });
        const r = await startStripeCheckout(accessToken, ORIGIN, rt);
        b = { checkoutId, sessionId: (r as { url: string }).url.split("/").pop()!, charge: "", pi: "", txId: "" };
      }
      const coBefore = await coDoc(b);
      await stripe.ctl(`pi-metadata/${a.pi}`, { metadataCheckoutId: b.checkoutId });
      await stripe.ctl(`refund/${a.charge}`);
      // 未払いの B でも「確定待ち（500）」にせず、A の本当の異常として記録して 200
      await expectAnomaly(a, refundEv(a), a.charge, "charge", `PaymentIntent と Session が一致しない（B ${bPaid ? "支払い済み" : "未払い"}）`);
      // B は何も変わらない：決済記録・占い権利なし、注文はそのまま
      const coAfter = await coDoc(b);
      assert.deepEqual([coAfter?.status, coAfter?.providerPaymentKey ?? null, coAfter?.refundReason ?? null], [coBefore?.status, coBefore?.providerPaymentKey ?? null, coBefore?.refundReason ?? null], "通知の対象ではない B の注文を変えました");
      if (bPaid) {
        assert.equal(await txDoc(b), null, "A の通知で B の決済を確定しました");
        assert.equal(await fsDoc(b), null, "A の通知で B の占い権利を作りました");
        // B 自身の正しい通知では確定される（A の返金は反映しない）
        assert.equal(outcomeOf(await deliver(rt, completedEv(b))), "confirmed");
        const tb = await txDoc(b);
        assert.deepEqual([tb?.paymentStatus, tb?.stripeChargeId, tb?.refundStatus ?? null, (await fsDoc(b))?.status, (await coDoc(b))?.status], ["SUCCEEDED", b.charge, null, "PAID", "SUCCEEDED"], "B の確定が正しくありません");
        assert.deepEqual(await reviewsOfCharge(b.charge), []);
      }
      assert.equal(await txCountOfCharge(a.charge), 0);
    }
    step("PaymentIntent と Checkout Session が一致しない：A の返金は transaction_not_found（A の決済記録は作らない）。B は支払い済み・未払いとも何も変えない（確定しない）→ B 自身の確定の通知で正しく確定（A の返金は反映しない）");
  }

  // ================= 6. 決済確定が拒否される（注文と決済の金額が一致しない）：本当の異常 =================
  {
    const p = await paidOnly(rt, code);
    await fsdb().collection(C.checkouts).doc(p.checkoutId).update({ amount: 200 });
    await stripe.ctl(`refund/${p.charge}`);
    await expectAnomaly(p, refundEv(p), p.charge, "charge", "確定が拒否される");
    assert.equal(outcomeOf(await deliver(rt, completedEv(p))), "rejected", "（前提）確定の通知でも拒否される");
    step("決済確定が拒否される（金額の不一致）：transaction_not_found を記録して 200。決済記録は作らない");
  }

  // ================= 7. Stripe API の一時的な失敗 → 500（処理済みにしない・記録しない）→ 再送で正常に処理 =================
  {
    const p = await paidOnly(rt, code);
    await stripe.ctl(`refund/${p.charge}`);
    stripe.fake.failCalls.push({ path: new RegExp(`^/v1/checkout/sessions/${p.sessionId}$`), method: "GET", skip: 0, count: 1 });
    const e = refundEv(p);
    const r1 = await deliver(rt, e);
    assert.equal(r1.status, 500, "一時的な失敗を 200 で握りつぶしました");
    let d = await eventDoc(e.id);
    assert.deepEqual([Boolean(d?.processedAt), d?.state], [false, "RETRYABLE"]);
    assert.deepEqual(await reviewsOfCharge(p.charge), [], "一時的な失敗で決済要確認を記録しました");
    assert.equal(await txDoc(p), null);
    // 再送：正常に処理
    const r2 = await deliver(rt, e);
    assert.equal(r2.status, 200);
    d = await eventDoc(e.id);
    assert.deepEqual([Boolean(d?.processedAt), d?.state], [true, "PROCESSED"]);
    assert.deepEqual([(await txDoc(p))?.paymentStatus, (await fsDoc(p))?.status, (await coDoc(p))?.status], ["REFUNDED", "EXPIRED", "REFUNDED"]);
    assert.deepEqual(await reviewsOfCharge(p.charge), []);
    assert.equal(await txCountOfCharge(p.charge), 1);
    step("Stripe API の一時的な失敗（確定の Session の取得）：500・RETRYABLE・記録しない → 同じ通知の再送で確定と返金を反映（決済記録1件・決済要確認0件）");
  }

  // ================= 8. 支払いの確定待ち（PayPay の非同期）→ 500 → 確定の後の再送で正常に処理 =================
  {
    const p = await paidOnly(rt, code, { async: true });
    const dp = stripe.addDispute(p.charge);
    const e = disputeEv(dp);
    const r1 = await deliver(rt, e);
    assert.equal(r1.status, 500, "確定待ちを 200 で握りつぶしました");
    assert.equal((await eventDoc(e.id))?.lastError, "StripeConfirmNotReadyError");
    assert.deepEqual([await txDoc(p), await reviewOf(dp)], [null, null]);
    await stripe.ctl(`async-succeed/${p.sessionId}`);
    const r2 = await deliver(rt, e);
    assert.equal(r2.status, 200);
    assert.deepEqual([(await txDoc(p))?.disputeStatus, (await fsDoc(p))?.status, (await coDoc(p))?.status], ["open", "PAID", "SUCCEEDED"]);
    assert.deepEqual(await reviewsOfCharge(p.charge), []);
    step("支払いの確定待ち：500（StripeConfirmNotReadyError・記録しない）→ 支払いの確定の後の再送で確定と異議申し立てを反映。決済要確認0件");
  }

  // ================= 9. 同時実行・重複通知：決済記録・権利は1件、返金は1回、決済要確認0件 =================
  {
    const p = await paidOnly(rt, code);
    await stripe.ctl(`refund/${p.charge}`);
    const same = refundEv(p);
    const evs = [same, same, refundEv(p), ev("refund.updated", { id: `re_x_${Date.now()}`, object: "refund", charge: p.charge }), completedEv(p), completedEv(p)];
    const results = await Promise.all([...evs.map((e) => deliver(rt, e)), confirmStripeCheckout(p.sessionId, rt)]);
    // 処理中の同じ通知は 409、競合で 500 になったものは Stripe と同じく再送する
    for (const [i, r] of results.slice(0, evs.length).entries()) {
      const rr = r as { status: number };
      assert.ok([200, 409, 500].includes(rr.status), `想定外の応答 ${rr.status}`);
      if (rr.status !== 200) assert.equal((await deliver(rt, evs[i])).status, 200, "再送で処理できません");
    }
    for (const e of evs) assert.ok((await eventDoc(e.id))?.processedAt, "通知が処理済みになっていません");
    assert.equal(await txCountOfCharge(p.charge), 1, "決済記録が重複しました");
    assert.equal((await fsdb().collection(C.fortuneSessions).where("transactionId", "==", p.txId).get()).size, 1, "占い権利が重複しました");
    const t = await txDoc(p);
    assert.deepEqual([t?.paymentStatus, t?.amountRefunded, (await fsDoc(p))?.status, (await coDoc(p))?.status], ["REFUNDED", 100, "EXPIRED", "REFUNDED"]);
    assert.deepEqual(await reviewsOfCharge(p.charge), [], "同時の通知で決済要確認を記録しました");
    step(`同時実行（同じ返金の通知×2・別の返金の通知×2・確定の通知×2・戻り先の確定。再送 ${results.slice(0, evs.length).filter((r) => (r as { status: number }).status !== 200).length} 件）：決済記録・権利は1件、返金は1回、決済要確認0件`);
  }

  console.log("\nSTRIPE EARLY SYNC E2E PASSED");
}

main()
  .then(async () => {
    await stripe.stop();
    process.exit(0);
  })
  .catch(async (e) => {
    console.error("\nSTRIPE EARLY SYNC E2E FAILED:", e);
    await stripe.stop().catch(() => {});
    process.exit(1);
  });
