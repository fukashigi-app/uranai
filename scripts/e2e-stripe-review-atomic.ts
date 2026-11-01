/**
 * 返金・異議申し立ての反映と、それに伴う決済要確認の記録（以前の仕組みで確定した精算の月の取引の変化）の原子性の E2E 検証。
 * Firestore の決済要確認の記録（paymentReviews）を直接読み、保存内容と件数を確かめる。
 *  - トランザクションの途中で失敗：決済記録の更新・精算の調整・決済要確認の記録のどれも保存されない → 再送で1回だけ保存
 *  - トランザクションの直後に停止：決済要確認の記録は残っている → 再送で回数は増えない
 *  - 同じ通知の再送・同じ状態の別の通知・同時の通知：記録は1件、回数は1回、調整・返金は二重にならない
 *  - 確認済みの記録に同じ内容：確認済みのまま。内容が変わったら未確認に戻る。運営の確認済みの操作と通知が同時でも矛盾しない
 * 本物の Stripe・本番の Firebase には一切接続しない（localhost の模擬 Stripe と Firestore Emulator の demo- プロジェクトだけ。キーは形だけの偽物）。
 *
 *   firebase emulators:start --only firestore --project demo-uranai
 *   （別ターミナル）FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 FIREBASE_PROJECT_ID=demo-uranai-review-atomic DB_PROVIDER=firestore npm run e2e:stripe-review-atomic
 */
import "dotenv/config";
import assert from "node:assert/strict";
import Stripe from "stripe";
import { FieldValue } from "firebase-admin/firestore";
import { createFakeStripe } from "./lib/fake-stripe";
import { C, fsdb } from "@/lib/firestore/admin";
import { dataProvider } from "@/lib/data-provider";
import { createStore } from "@/lib/services/stores";
import { generateSettlements, updateSettlementStatus } from "@/lib/services/settlements";
import { paymentReviewId, resolvePaymentReview } from "@/lib/firestore/payment-reviews";
import { createCheckout } from "@/lib/firestore/payments";
import { jstYearMonth, shiftYearMonth } from "@/lib/time";
import { createSimulatedStripeRuntime, STRIPE_SESSION_TTL_MS, type StripeRuntime } from "@/lib/payments/stripe-checkout";
import { startStripeCheckout } from "@/lib/payments/stripe-confirm";
import { handleStripeWebhook } from "@/lib/payments/stripe-webhook";

const SYSTEM = { userId: null, role: "SYSTEM" as const };
const OPERATOR = { userId: "op-review-atomic", role: "OPERATOR" as const };
const step = (msg: string) => console.log(`  ✓ ${msg}`);
const ORIGIN = "http://localhost:3000";
const PORT = 12141;
const KEY = "sk_live_e2e_review_atomic_dummy";
const stripe = createFakeStripe({ port: PORT, mode: "live", apiKey: KEY });

/** 返金・異議申し立ての反映のトランザクションの中（すべての書き込みの後）と、成功の直後に止める（テスト専用のフック） */
const hook = { failInTx: new Set<string>(), stopAfterCommit: new Set<string>() };

const signer = new Stripe("sk_test_signer");
let evN = 0;
type Ev = { type: string; object: Record<string, unknown>; id: string };
const ev = (type: string, object: Record<string, unknown>): Ev => ({ type, object, id: `evt_rva_${++evN}_${Date.now()}` });
async function deliver(rt: StripeRuntime, e: Ev) {
  const payload = JSON.stringify({ id: e.id, object: "event", type: e.type, livemode: rt.mode === "live", data: { object: e.object } });
  const sig = signer.webhooks.generateTestHeaderString({ payload, secret: rt.webhookSecret });
  return handleStripeWebhook(payload, sig, rt);
}
const outcomeOf = (r: { body: unknown }) => (r.body as { outcome?: string }).outcome;

type Pay = { txId: string; charge: string; sessionId: string };
async function paid(rt: StripeRuntime, storeCode: string, ym: string): Promise<Pay> {
  const { checkoutId, accessToken } = await createCheckout(storeCode, "ZODIAC", { provider: "stripe", ttlMs: STRIPE_SESSION_TTL_MS });
  const r = await startStripeCheckout(accessToken, ORIGIN, rt);
  const sessionId = (r as { url: string }).url.split("/").pop()!;
  const created = Math.floor(new Date(`${ym}-15T12:00:00+09:00`).getTime() / 1000);
  const p = await stripe.ctl(`pay/${sessionId}`, { created, fee: 4 });
  assert.equal(outcomeOf(await deliver(rt, ev("checkout.session.completed", { id: sessionId, object: "checkout.session" }))), "confirmed");
  const [t] = (await fsdb().collection(C.transactions).where("checkoutId", "==", checkoutId).get()).docs;
  return { txId: t.id, charge: p.charge!, sessionId };
}
const refundEv = (p: Pay) => ev("charge.refunded", { id: p.charge, object: "charge" });
const txDoc = async (id: string) => (await fsdb().collection(C.transactions).doc(id).get()).data()!;
const fsDoc = async (id: string) => (await fsdb().collection(C.fortuneSessions).doc(id).get()).data()!;
const adjOf = async (txId: string) => (await fsdb().collection(C.settlementAdjustments).where("transactionId", "==", txId).get()).docs.map((d) => d.data());
const stDoc = async (id: string) => (await fsdb().collection(C.settlements).doc(id).get()).data()!;
const legacyReviewId = (txId: string) => paymentReviewId("legacy_settlement_change", txId);
const reviewDoc = async (txId: string) => (await fsdb().collection(C.paymentReviews).doc(legacyReviewId(txId)).get()).data() ?? null;
/** この決済の決済要確認の記録（種類を問わず、決済記録の ID で探す） */
const reviewsOf = async (txId: string) => (await fsdb().collection(C.paymentReviews).where("transactionId", "==", txId).get()).docs;
const newStore = async (label: string) => createStore({ name: `${label} ${Date.now()}`, contactName: "", postalCode: "", address: "", phone: "", email: "" }, SYSTEM);

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
    webhookSecret: "whsec_e2e_review_atomic_dummy",
    testHooks: {
      inSyncTransaction: (_kind, txId) => {
        if (hook.failInTx.delete(txId)) throw Object.assign(new Error("simulated failure inside the sync transaction"), { name: "SimulatedTxFailure" });
      },
      afterSyncCommit: (_kind, txId) => {
        if (hook.stopAfterCommit.delete(txId)) throw Object.assign(new Error("simulated stop right after the sync transaction"), { name: "SimulatedStop" });
      },
    },
  });
  console.log(`Stripe review atomicity E2E (emulator ${host} / ${process.env.FIREBASE_PROJECT_ID}, fake Stripe live :${PORT})`);
  const now = jstYearMonth(new Date());
  const [Ma, Mb] = [shiftYearMonth(now, -3), shiftYearMonth(now, -2)];

  // 以前の仕組みで確定した精算の月（支払った額の記録が無い：状態だけ支払済）の決済を用意する
  const storeL = await newStore("要確認原子性・旧精算");
  const L = await Promise.all(Array.from({ length: 6 }, () => paid(rt, storeL.storeCode, Ma)));
  await generateSettlements(Ma, SYSTEM);
  const legacyId = `${storeL.id}_${Ma}`;
  await fsdb().collection(C.settlements).doc(legacyId).update({ status: "PAID", paidAt: new Date(), updatedAt: FieldValue.serverTimestamp() });
  const legacyBefore = await stDoc(legacyId);
  // 新しい仕組みで確定した精算の月（調整を記録する）
  const storeN = await newStore("要確認原子性・新精算");
  const n1 = await paid(rt, storeN.storeCode, Mb);
  await generateSettlements(Mb, SYSTEM);
  await updateSettlementStatus(`${storeN.id}_${Mb}`, "PAID", "", SYSTEM);
  const lockedBefore = await stDoc(`${storeN.id}_${Mb}`);
  assert.ok(lockedBefore.lockedAt, "（前提）新しい仕組みで確定した精算");

  // ================= 1. トランザクションの途中で失敗：何も保存されない → 再送で1回だけ =================
  {
    const p = L[0];
    await stripe.ctl(`refund/${p.charge}`);
    hook.failInTx.add(p.txId);
    const e = refundEv(p);
    const r1 = await deliver(rt, e);
    assert.equal(r1.status, 500);
    assert.equal(hook.failInTx.has(p.txId), false, "（前提）トランザクションの中のフックが呼ばれていません");
    let t = await txDoc(p.txId);
    assert.deepEqual([t.refundStatus, t.paymentStatus, t.legacySettlementReview ?? null], [null, "SUCCEEDED", null], "失敗したトランザクションの決済記録の更新が保存されました");
    assert.equal(await reviewDoc(p.txId), null, "失敗したトランザクションの決済要確認の記録が保存されました");
    assert.equal((await fsDoc(p.txId)).status, "PAID", "失敗したトランザクションで権利が止まりました");
    // 同じ通知の再送で1回だけ保存
    assert.equal(outcomeOf(await deliver(rt, e)), "refunded");
    t = await txDoc(p.txId);
    assert.deepEqual([t.refundStatus, t.paymentStatus, t.legacySettlementReview], ["succeeded", "REFUNDED", true]);
    const rv = await reviewDoc(p.txId);
    assert.deepEqual([rv?.status, rv?.occurrences, rv?.amount, rv?.settlementId, rv?.yearMonth, rv?.eventType], ["OPEN", 1, -30, legacyId, Ma, "charge.refunded"]);
    assert.equal((await reviewsOf(p.txId)).length, 1);
    assert.equal((await adjOf(p.txId)).length, 0, "以前の仕組みの月で調整を作りました");

    // 新しい仕組みの月：精算の調整も保存されない → 再送で1件
    await stripe.ctl(`refund/${n1.charge}`);
    hook.failInTx.add(n1.txId);
    const en = refundEv(n1);
    assert.equal((await deliver(rt, en)).status, 500);
    assert.equal((await adjOf(n1.txId)).length, 0, "失敗したトランザクションの精算の調整が保存されました");
    assert.equal((await txDoc(n1.txId)).refundStatus, null);
    assert.equal(outcomeOf(await deliver(rt, en)), "refunded");
    const adj = await adjOf(n1.txId);
    assert.deepEqual(adj.map((a) => a.amount), [-30]);
    assert.equal((await reviewsOf(n1.txId)).length, 0, "新しい仕組みの月なのに決済要確認を記録しました");

    // 異議申し立て（敗訴）も同じ
    const q = L[1];
    const dp = (await stripe.ctl(`dispute/${q.charge}`, { status: "lost" })).dispute!;
    hook.failInTx.add(q.txId);
    const ed = ev("charge.dispute.closed", { id: dp, object: "dispute" });
    assert.equal((await deliver(rt, ed)).status, 500);
    assert.deepEqual([(await txDoc(q.txId)).disputeStatus ?? null, await reviewDoc(q.txId)], [null, null]);
    assert.equal(outcomeOf(await deliver(rt, ed)), "dispute_lost");
    assert.deepEqual([(await txDoc(q.txId)).paymentStatus, (await reviewDoc(q.txId))?.amount, (await reviewDoc(q.txId))?.occurrences], ["CHARGEBACK", -30, 1]);
    step("トランザクションの途中で失敗：決済記録・権利・精算の調整・決済要確認の記録のどれも保存されない → 同じ通知の再送で1回だけ保存（返金・異議申し立て）");
  }

  // ================= 2. トランザクションの直後に停止：記録は残る → 再送で回数は増えない =================
  {
    const p = L[2];
    await stripe.ctl(`refund/${p.charge}`);
    hook.stopAfterCommit.add(p.txId);
    const e = refundEv(p);
    assert.equal((await deliver(rt, e)).status, 500);
    let rv = await reviewDoc(p.txId);
    assert.ok(rv, "トランザクションの直後に止まったら、決済要確認の記録が失われました");
    assert.deepEqual([rv!.status, rv!.occurrences, rv!.amount], ["OPEN", 1, -30]);
    assert.equal((await txDoc(p.txId)).legacySettlementReview, true);
    assert.equal(outcomeOf(await deliver(rt, e)), "unchanged");
    rv = await reviewDoc(p.txId);
    assert.equal(rv!.occurrences, 1, "再送で決済要確認の回数が増えました");
    step("トランザクションの直後に停止：決済要確認の記録は決済記録と一緒に保存済み → 同じ通知の再送は「変化なし」で回数も増えない");
  }

  // ================= 3. 再送・同じ状態の別の通知・同時の通知：記録1件・回数1・返金1回 =================
  {
    const p = L[3];
    await stripe.ctl(`refund/${p.charge}`);
    const e = refundEv(p);
    const results = await Promise.all([deliver(rt, e), deliver(rt, refundEv(p)), deliver(rt, refundEv(p)), deliver(rt, refundEv(p)), deliver(rt, refundEv(p))]);
    for (const r of results) assert.equal(r.status, 200);
    const outs = results.map(outcomeOf).filter(Boolean);
    assert.equal(outs.filter((o) => o === "refunded").length, 1, `返金の反映が1回ではありません：${outs.join(",")}`);
    assert.deepEqual((await deliver(rt, e)).body, { received: true, duplicate: true }, "同じ通知の重複が処理されました");
    assert.equal(outcomeOf(await deliver(rt, refundEv(p))), "unchanged");
    const rs = await reviewsOf(p.txId);
    assert.equal(rs.length, 1, "決済要確認の記録が重複しました");
    assert.deepEqual([rs[0].get("occurrences"), rs[0].get("amount")], [1, -30]);
    assert.equal((await txDoc(p.txId)).amountRefunded, 100);
    step("同時の通知×5・同じ通知の重複・同じ状態の別の通知：決済要確認の記録は1件・回数1、返金は1回");
  }

  // ================= 4. 確認済みに同じ内容：確認済みのまま／内容が変われば未確認に戻る =================
  {
    const p = L[4];
    await stripe.ctl(`refund/${p.charge}`, { amount: 30 }); // 取り分 30 → 21（-9）
    assert.equal(outcomeOf(await deliver(rt, refundEv(p))), "partial");
    const id = legacyReviewId(p.txId);
    assert.deepEqual([(await reviewDoc(p.txId))?.amount, (await reviewDoc(p.txId))?.status], [-9, "OPEN"]);
    assert.equal(await resolvePaymentReview(id, OPERATOR), true);
    await stripe.ctl(`refund/${p.charge}`, { amount: 30 }); // 21 → 12（同じ -9）
    assert.equal(outcomeOf(await deliver(rt, refundEv(p))), "partial");
    let rv = await reviewDoc(p.txId);
    assert.deepEqual([rv!.status, rv!.occurrences, rv!.amount, rv!.resolvedBy], ["RESOLVED", 2, -9, OPERATOR.userId], "同じ内容で確認済みが未確認に戻りました");
    await stripe.ctl(`refund/${p.charge}`, { amount: 40 }); // 12 → 0（-12：内容が変わる）
    assert.equal(outcomeOf(await deliver(rt, refundEv(p))), "refunded");
    rv = await reviewDoc(p.txId);
    assert.deepEqual([rv!.status, rv!.occurrences, rv!.amount, rv!.resolvedBy], ["OPEN", 3, -12, null], "内容が変わったのに未確認に戻りません");
    assert.equal((await reviewsOf(p.txId)).length, 1);
    step("確認済みの記録に同じ内容：確認済みのまま（回数だけ増える）。内容が変わったら未確認に戻る（ID は同じ1件）");
  }

  // ================= 5. 運営の「確認済みにする」と通知が同時 =================
  {
    const p = L[5];
    await stripe.ctl(`refund/${p.charge}`, { amount: 30 });
    assert.equal(outcomeOf(await deliver(rt, refundEv(p))), "partial");
    const id = legacyReviewId(p.txId);
    await stripe.ctl(`refund/${p.charge}`, { amount: 30 }); // 同じ内容（-9）
    const [resolved, r] = await Promise.all([resolvePaymentReview(id, OPERATOR), deliver(rt, refundEv(p))]);
    assert.equal(resolved, true);
    assert.equal(outcomeOf(r), "partial");
    const rv = await reviewDoc(p.txId);
    assert.deepEqual([rv!.status, rv!.occurrences, rv!.resolvedBy], ["RESOLVED", 2, OPERATOR.userId], "同時の操作で確認済み・回数が失われました");
    const audits = await fsdb().collection(C.auditLogs).where("targetId", "==", id).where("action", "==", "payment_review.resolved").get();
    assert.equal(audits.size, 1, "確認済みの監査ログが1件ではありません");
    step("運営の「確認済みにする」と通知が同時：どちらの順でも確認済み・回数2・監査ログ1件（更新が失われない）");
  }

  // ================= 6. 精算の計算は変わらない =================
  {
    const legacyAfter = await stDoc(legacyId);
    assert.deepEqual([legacyAfter.storeShare, legacyAfter.status, legacyAfter.payableAmount ?? null], [legacyBefore.storeShare, "PAID", legacyBefore.payableAmount ?? null], "以前に確定した精算を書き換えました");
    for (const p of L) assert.equal((await adjOf(p.txId)).length, 0, "以前の仕組みの月で調整を作りました");
    const lockedAfter = await stDoc(`${storeN.id}_${Mb}`);
    assert.deepEqual([lockedAfter.storeShare, lockedAfter.status], [lockedBefore.storeShare, "PAID"], "確定済みの精算を書き換えました");
    const t = await txDoc(n1.txId);
    assert.equal(Number(t.settledShare) + Number(t.adjustmentTotal), 0, "支払った額＋調整が今の取り分（0円）と一致しません");
    step("精算：以前に確定した精算は書き換えず調整も作らない。新しい仕組みの精算は調整1件（-30円）で、支払った額＋調整＝今の取り分");
  }

  console.log("\nSTRIPE REVIEW ATOMICITY E2E PASSED");
}

main()
  .then(async () => {
    await stripe.stop();
    process.exit(0);
  })
  .catch(async (e) => {
    console.error("\nSTRIPE REVIEW ATOMICITY E2E FAILED:", e);
    await stripe.stop().catch(() => {});
    process.exit(1);
  });
