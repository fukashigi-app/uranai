/**
 * 記録だけで異常を知らせる決済要確認（決済記録が無い・照合できない・申し立ての額の不正・状態の後戻り）の E2E 検証。
 * Firestore の決済要確認の記録（paymentReviews）・通知の処理済みの記録（webhookEvents）を直接読んで確かめる。
 *  - 記録できたら 200（処理済み）。記録に失敗したら 500 で処理済みにしない → 同じ通知の再送で記録し直す
 *  - 同じ通知の重複・記録の後に処理済みにする前で止まった再送・同時の通知でも、回数は通知ごとに1回
 *  - 確認済みの記録に同じ内容：確認済みのまま。内容が変わったら未確認に戻る
 *  - 返金の通知が決済確定より先に届いても、決済確定で Stripe の今の状態を読むので、最後は正しい状態になる
 * 本物の Stripe・本番の Firebase には一切接続しない（localhost の模擬 Stripe と Firestore Emulator の demo- プロジェクトだけ。キーは形だけの偽物）。
 *
 *   firebase emulators:start --only firestore --project demo-uranai
 *   （別ターミナル）FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 FIREBASE_PROJECT_ID=demo-uranai-review-required DB_PROVIDER=firestore npm run e2e:stripe-review-required
 */
import "dotenv/config";
import assert from "node:assert/strict";
import Stripe from "stripe";
import { createFakeStripe } from "./lib/fake-stripe";
import { C, fsdb, safeId } from "@/lib/firestore/admin";
import { dataProvider } from "@/lib/data-provider";
import { createStore } from "@/lib/services/stores";
import { paymentReviewId, resolvePaymentReview, type PaymentReviewKind } from "@/lib/firestore/payment-reviews";
import { paymentAlertId } from "@/lib/firestore/payment-alerts";
import { createCheckout } from "@/lib/firestore/payments";
import { createSimulatedStripeRuntime, STRIPE_SESSION_TTL_MS, type StripeRuntime } from "@/lib/payments/stripe-checkout";
import { startStripeCheckout } from "@/lib/payments/stripe-confirm";
import { handleStripeWebhook } from "@/lib/payments/stripe-webhook";

const SYSTEM = { userId: null, role: "SYSTEM" as const };
const OPERATOR = { userId: "op-review-required", role: "OPERATOR" as const };
const step = (msg: string) => console.log(`  ✓ ${msg}`);
const ORIGIN = "http://localhost:3000";
const PORT = 12151;
const KEY = "sk_live_e2e_review_required_dummy";
const stripe = createFakeStripe({ port: PORT, mode: "live", apiKey: KEY });

/** 記録が必須の決済要確認を記録する直前に、記録の失敗を起こす（テスト専用のフック。種類ごとの回数） */
const failRecord = new Map<string, number>();

const signer = new Stripe("sk_test_signer");
let evN = 0;
type Ev = { type: string; object: Record<string, unknown>; id: string };
const ev = (type: string, object: Record<string, unknown>): Ev => ({ type, object, id: `evt_rrq_${++evN}_${Date.now()}` });
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
const completedEv = (p: Pay) => ev("checkout.session.completed", { id: p.sessionId, object: "checkout.session" });
const refundEv = (p: Pay) => ev("charge.refunded", { id: p.charge, object: "charge" });
const disputeEv = (dpId: string) => ev("charge.dispute.updated", { id: dpId, object: "dispute" });
const reviewOf = async (kind: PaymentReviewKind, objectId: string) => (await fsdb().collection(C.paymentReviews).doc(paymentReviewId(kind, objectId)).get()).data() ?? null;
const reviewCount = async (objectId: string) => (await fsdb().collection(C.paymentReviews).where("objectId", "==", objectId).get()).size;
const eventDoc = async (eventId: string) => (await fsdb().collection(C.webhookEvents).doc(safeId("stripe", eventId)).get()).data() ?? null;
const alertOf = async (kind: Parameters<typeof paymentAlertId>[0], objectId: string) => (await fsdb().collection(C.paymentAlerts).doc(paymentAlertId(kind, objectId)).get()).data() ?? null;

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
    webhookSecret: "whsec_e2e_review_required_dummy",
    testHooks: {
      beforeReviewRecord: (kind) => {
        const n = failRecord.get(kind) ?? 0;
        if (n <= 0) return;
        failRecord.set(kind, n - 1);
        throw Object.assign(new Error("simulated failure of the review record"), { name: "PaymentReviewRecordError" });
      },
    },
  });
  console.log(`Stripe required review E2E (emulator ${host} / ${process.env.FIREBASE_PROJECT_ID}, fake Stripe live :${PORT})`);
  const store = await createStore({ name: `要確認必須検証店舗 ${Date.now()}`, contactName: "", postalCode: "", address: "", phone: "", email: "" }, SYSTEM);
  const code = store.storeCode;

  // ================= 1. 決済確定より先の返金（transaction_not_found）：記録して 200 → 決済確定で正しい状態 =================
  {
    const p = await paidOnly(rt, code);
    await stripe.ctl(`refund/${p.charge}`);
    const e = refundEv(p);
    const r = await deliver(rt, e);
    assert.equal(r.status, 200);
    assert.equal(outcomeOf(r), "ignored");
    const rv = await reviewOf("transaction_not_found", p.charge);
    assert.deepEqual([rv?.status, rv?.occurrences, rv?.objectType, rv?.chargeId, rv?.paymentIntentId, rv?.eventType, rv?.recentOccurrenceKeys], ["OPEN", 1, "charge", p.charge, p.pi, "charge.refunded", undefined]);
    assert.deepEqual((await eventDoc(e.id))?.recordedReviewIds, [paymentReviewId("transaction_not_found", p.charge)], "通知の文書に記録した決済要確認の ID がありません");
    assert.ok((await eventDoc(e.id))?.processedAt, "記録できたのに処理済みになっていません");
    // 後から決済確定：Stripe の今の状態（返金済み）を読むので、権利を付与せず REFUNDED
    assert.equal(outcomeOf(await deliver(rt, completedEv(p))), "refunded");
    const t = (await fsdb().collection(C.transactions).doc(p.txId).get()).data()!;
    const fs = (await fsdb().collection(C.fortuneSessions).doc(p.txId).get()).data()!;
    const co = (await fsdb().collection(C.checkouts).doc(p.checkoutId).get()).data()!;
    assert.deepEqual([t.paymentStatus, t.refundStatus, fs.status, co.status, co.refundReason], ["REFUNDED", "succeeded", "EXPIRED", "REFUNDED", "refund"]);
    // その後の返金の通知は「変化なし」（記録は増えない。確認待ちは運営が確認する＝自動では解消しない）
    assert.equal(outcomeOf(await deliver(rt, refundEv(p))), "unchanged");
    assert.equal((await reviewOf("transaction_not_found", p.charge))?.occurrences, 1);
    step("決済確定より先の返金：transaction_not_found を記録して 200（処理済み）→ 後の決済確定で返金済みとして記録（権利なし・REFUNDED）");
  }

  // ================= 2. 記録の失敗：500・処理済みにしない → 同じ通知の再送で記録 =================
  {
    const p = await paidOnly(rt, code);
    await stripe.ctl(`refund/${p.charge}`);
    failRecord.set("transaction_not_found", 1);
    const e = refundEv(p);
    const r1 = await deliver(rt, e);
    assert.equal(r1.status, 500, "記録に失敗したのに Webhook が成功を返しました");
    assert.equal(await reviewOf("transaction_not_found", p.charge), null);
    const evd = await eventDoc(e.id);
    assert.ok(evd && !evd.processedAt, "記録に失敗したのに通知が処理済みになりました（再送されません）");
    const al = await alertOf("refund_sync_failed", e.id);
    assert.equal(al?.errorName, "PaymentReviewRecordError", "決済監視に記録の失敗（検証の失敗と区別できる名前）が残っていません");
    const r2 = await deliver(rt, e);
    assert.equal(r2.status, 200);
    assert.equal(outcomeOf(r2), "ignored");
    assert.deepEqual([(await reviewOf("transaction_not_found", p.charge))?.occurrences, Boolean((await eventDoc(e.id))?.processedAt)], [1, true]);
    // 記録の後、処理済みにする前に止まった場合（処理済みの印だけが無い状態）の再送：回数は増えない
    await fsdb().collection(C.webhookEvents).doc(safeId("stripe", e.id)).update({ processedAt: null });
    assert.equal((await deliver(rt, e)).status, 200);
    assert.equal((await reviewOf("transaction_not_found", p.charge))?.occurrences, 1, "同じ通知の再送で回数が増えました");
    // 同じ通知の重複（処理済み）
    assert.deepEqual((await deliver(rt, e)).body, { received: true, duplicate: true });
    assert.equal((await reviewOf("transaction_not_found", p.charge))?.occurrences, 1);
    step("記録の失敗：500・処理済みにしない・決済監視に PaymentReviewRecordError → 同じ通知の再送で記録（回数1）。処理済みの前で止まった再送・重複でも回数は増えない");
  }

  // ================= 3. 同時の通知：記録は1件、回数は通知ごとに1回 =================
  {
    const p = await paidOnly(rt, code);
    await stripe.ctl(`refund/${p.charge}`);
    const same = refundEv(p);
    const evs = [same, same, same, refundEv(p), refundEv(p)];
    const results = await Promise.all(evs.map((e) => deliver(rt, e)));
    // 同じ記録への同時の書き込みが重なると、記録の待ち時間の上限で 500 になることがある（処理済みにならない）。Stripe と同じく再送する
    for (const [i, r] of results.entries()) {
      assert.ok(r.status === 200 || r.status === 500, `想定外の応答 ${r.status}`);
      if (r.status === 500) assert.equal((await deliver(rt, evs[i])).status, 200, "再送で記録できません");
    }
    for (const e of evs) assert.ok((await eventDoc(e.id))?.processedAt, "通知が処理済みになっていません");
    assert.equal(await reviewCount(p.charge), 1, "決済要確認の記録が重複しました");
    assert.equal((await reviewOf("transaction_not_found", p.charge))?.occurrences, 3, "回数が通知ごと（同じ通知×3＝1回、別の通知×2＝2回）になっていません");
    step(`同時の通知（同じ通知×3・別の通知×2。500 になった ${results.filter((r) => r.status === 500).length} 件は再送）：記録は1件、回数は通知ごと（3）`);
  }

  // ================= 4. 申し立ての額の不正（dispute_amount_invalid）：記録の失敗で 500／確認済みへの再通知／内容の変化 =================
  {
    const p = await paidOnly(rt, code);
    assert.equal(outcomeOf(await deliver(rt, completedEv(p))), "confirmed");
    const dp = stripe.addDispute(p.charge, { currency: "usd" });
    failRecord.set("dispute_amount_invalid", 1);
    const e1 = disputeEv(dp);
    assert.equal((await deliver(rt, e1)).status, 500);
    assert.equal(await reviewOf("dispute_amount_invalid", dp), null);
    assert.equal(outcomeOf(await deliver(rt, e1)), "rejected");
    const id = paymentReviewId("dispute_amount_invalid", dp);
    assert.deepEqual([(await reviewOf("dispute_amount_invalid", dp))?.status, (await reviewOf("dispute_amount_invalid", dp))?.amount], ["OPEN", 100]);
    assert.equal(await resolvePaymentReview(id, OPERATOR), true);
    assert.equal(outcomeOf(await deliver(rt, disputeEv(dp))), "rejected"); // 同じ内容の別の通知
    let rv = await reviewOf("dispute_amount_invalid", dp);
    assert.deepEqual([rv?.status, rv?.occurrences, rv?.resolvedBy], ["RESOLVED", 2, OPERATOR.userId], "同じ内容で確認済みが未確認に戻りました");
    stripe.fake.disputes.get(dp)!.amount = 150; // 内容が変わる（額）
    assert.equal(outcomeOf(await deliver(rt, disputeEv(dp))), "rejected");
    rv = await reviewOf("dispute_amount_invalid", dp);
    assert.deepEqual([rv?.status, rv?.occurrences, rv?.amount, rv?.resolvedBy], ["OPEN", 3, 150, null], "内容が変わったのに未確認に戻りません");
    assert.equal((await fsdb().collection(C.transactions).doc(p.txId).get()).get("disputeStatus") ?? null, null, "照合できない申し立てを反映しました");
    step("申し立ての額の不正：記録の失敗で 500 → 再送で記録。確認済みに同じ内容は確認済みのまま、額が変わったら未確認に戻る（反映はしない）");
  }

  // ================= 5. 照合できない返金（charge_mismatch）・状態の後戻り（dispute_state_regressed）も同じ =================
  {
    const p = await paidOnly(rt, code);
    assert.equal(outcomeOf(await deliver(rt, completedEv(p))), "confirmed");
    await stripe.ctl(`pi-metadata/${p.pi}`, { metadataStoreId: "other-store" });
    await stripe.ctl(`refund/${p.charge}`);
    failRecord.set("charge_mismatch", 1);
    const e = refundEv(p);
    assert.equal((await deliver(rt, e)).status, 500);
    assert.equal(await reviewOf("charge_mismatch", p.charge), null);
    assert.equal(outcomeOf(await deliver(rt, e)), "rejected");
    assert.deepEqual((await reviewOf("charge_mismatch", p.charge))?.mismatches, ["store"]);
    assert.equal((await fsdb().collection(C.transactions).doc(p.txId).get()).get("refundStatus"), null, "照合できない返金を反映しました");

    const q = await paidOnly(rt, code);
    assert.equal(outcomeOf(await deliver(rt, completedEv(q))), "confirmed");
    const dp = stripe.addDispute(q.charge, { status: "lost" });
    assert.equal(outcomeOf(await deliver(rt, disputeEv(dp))), "dispute_lost");
    await stripe.ctl(`dispute-status/${dp}`, { status: "needs_response" }); // 結果が出た申し立てが対応中に戻る
    failRecord.set("dispute_state_regressed", 1);
    const e2 = disputeEv(dp);
    assert.equal((await deliver(rt, e2)).status, 500);
    assert.equal(await reviewOf("dispute_state_regressed", dp), null);
    assert.equal(outcomeOf(await deliver(rt, e2)), "unchanged");
    assert.equal((await reviewOf("dispute_state_regressed", dp))?.occurrences, 1);
    assert.equal((await fsdb().collection(C.transactions).doc(q.txId).get()).get("disputeStatus"), "lost", "敗訴を対応中に戻しました");
    step("照合できない返金・状態の後戻り：記録の失敗で 500 → 再送で記録（反映はしない・敗訴を戻さない）");
  }

  // ================= 6. 待つのをやめた（保存されたか不明）→ 500 → 裏で保存 → 再送で回数は増えない =================
  {
    // 待ち時間だけを 1ms にした接続（同じ模擬 Stripe・同じ Emulator）。書き込みは止まらずに続く
    const quick = createSimulatedStripeRuntime("live", { apiBase: `http://127.0.0.1:${PORT}`, secretKey: KEY, webhookSecret: "whsec_e2e_review_required_dummy", testHooks: { reviewRecordTimeoutMs: 1 } });
    const p = await paidOnly(rt, code);
    await stripe.ctl(`refund/${p.charge}`);
    const e = refundEv(p);
    const r1 = await deliver(quick, e);
    assert.equal(r1.status, 500, "保存されたか不明なのに Webhook が成功を返しました");
    assert.ok(!(await eventDoc(e.id))?.processedAt, "保存されたか不明なのに通知が処理済みになりました");
    assert.equal((await alertOf("refund_sync_failed", e.id))?.errorName, "PaymentReviewRecordUnknownError", "決済監視で「保存されたか不明」と「保存の失敗」を区別できません");
    let rv = null;
    for (let i = 0; i < 50 && !rv; i++) {
      await new Promise((ok) => setTimeout(ok, 100));
      rv = await reviewOf("transaction_not_found", p.charge);
    }
    assert.ok(rv, "待つのをやめた後の書き込みが保存されていません（この場面の前提）");
    assert.equal(rv!.occurrences, 1);
    const r2 = await deliver(rt, e); // Stripe の再送（通常の待ち時間）
    assert.equal(r2.status, 200);
    assert.equal(outcomeOf(r2), "ignored");
    assert.deepEqual([(await reviewOf("transaction_not_found", p.charge))?.occurrences, Boolean((await eventDoc(e.id))?.processedAt)], [1, true], "後から保存された記録を、再送で二重に数えました");
    step("待つのをやめた：500・処理済みにしない・決済監視に PaymentReviewRecordUnknownError → 裏で保存された記録を、同じ通知の再送で二重に数えない（回数1・処理済み）");
  }

  assert.equal([...failRecord.values()].reduce((a, n) => a + n, 0), 0, "（前提）用意した記録の失敗がすべて使われていません");
  console.log("\nSTRIPE REQUIRED REVIEW E2E PASSED");
}

main()
  .then(async () => {
    await stripe.stop();
    process.exit(0);
  })
  .catch(async (e) => {
    console.error("\nSTRIPE REQUIRED REVIEW E2E FAILED:", e);
    await stripe.stop().catch(() => {});
    process.exit(1);
  });
