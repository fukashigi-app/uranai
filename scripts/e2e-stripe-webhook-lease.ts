/**
 * Stripe の Webhook の通知の処理権（lease：処理ごとのランダムな値と期限）の E2E 検証（Firestore Emulator と模擬 Stripe だけ）。
 * webhookEvents・決済記録・決済要確認を直接読んで確かめる。
 *  - 同じ通知が同時に届いても、処理権を取った1つだけが処理する（ほかは 409。処理済みにしない）
 *  - 期限内の処理権は奪えない。期限ちょうど・期限の後は取り直せる
 *  - 古い処理（処理権を失った処理）の完了・失敗の記録は、新しい処理の状態を上書きしない
 *  - 期限の後に古い処理が動いている間に新しい処理が取り直しても、決済・返金・異議申し立て・決済要確認は二重にならない
 *  - 処理済みの再送・以前の形の記録・処理の失敗（処理権を外してすぐ取り直せる）
 * 本物の Stripe・本番の Firebase には一切接続しない（localhost の模擬 Stripe と Firestore Emulator の demo- プロジェクトだけ。キーは形だけの偽物）。
 *
 *   firebase emulators:start --only firestore --project demo-uranai
 *   （別ターミナル）FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 FIREBASE_PROJECT_ID=demo-uranai-webhook-lease DB_PROVIDER=firestore npm run e2e:stripe-webhook-lease
 */
import "dotenv/config";
import assert from "node:assert/strict";
import Stripe from "stripe";
import { FieldValue } from "firebase-admin/firestore";
import { createFakeStripe } from "./lib/fake-stripe";
import { C, fsdb, safeId } from "@/lib/firestore/admin";
import { dataProvider } from "@/lib/data-provider";
import { createStore } from "@/lib/services/stores";
import { paymentReviewId } from "@/lib/firestore/payment-reviews";
import { acquireWebhookEventLease, createCheckout, finishWebhookEventWithLease, recordWebhookEventFailure } from "@/lib/firestore/payments";
import { WEBHOOK_LEASE_TTL_MS } from "@/lib/payments/webhook-event-state";
import { createSimulatedStripeRuntime, STRIPE_SESSION_TTL_MS, type StripeRuntime } from "@/lib/payments/stripe-checkout";
import { startStripeCheckout } from "@/lib/payments/stripe-confirm";
import { handleStripeWebhook } from "@/lib/payments/stripe-webhook";

const SYSTEM = { userId: null, role: "SYSTEM" as const };
const step = (msg: string) => console.log(`  ✓ ${msg}`);
const ORIGIN = "http://localhost:3000";
const PORT = 12191;
const KEY = "sk_live_e2e_webhook_lease_dummy";
const stripe = createFakeStripe({ port: PORT, mode: "live", apiKey: KEY });

/** 処理済みにする直前（処理の後）に1回だけ実行する処理（通知ごと。テスト専用のフック） */
const beforeFinish = new Map<string, () => Promise<void>>();

const signer = new Stripe("sk_test_signer");
let evN = 0;
type Ev = { type: string; object: Record<string, unknown>; id: string };
const ev = (type: string, object: Record<string, unknown>): Ev => ({ type, object, id: `evt_lse_${++evN}_${Date.now()}` });
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
const evRef = (id: string) => fsdb().collection(C.webhookEvents).doc(safeId("stripe", id));
const evDoc = async (id: string) => (await evRef(id).get()).data() ?? null;
const ms = (v: unknown) => (v as { toMillis?: () => number })?.toMillis?.() ?? NaN;
const txDoc = async (id: string) => (await fsdb().collection(C.transactions).doc(id).get()).data()!;
const txCount = async (sessionId: string) => (await fsdb().collection(C.transactions).where("stripeCheckoutSessionId", "==", sessionId).get()).size;
const adjCount = async (txId: string) => (await fsdb().collection(C.settlementAdjustments).where("transactionId", "==", txId).get()).size;
/** Stripe と同じく、処理済み（200）になるまで再送する（409・500 は後で再送） */
async function untilProcessed(rt: StripeRuntime, e: Ev) {
  for (let i = 0; i < 10; i++) {
    const r = await deliver(rt, e);
    if (r.status === 200) return r;
    assert.ok(r.status === 409 || r.status === 500, `想定外の応答 ${r.status}`);
    await new Promise((ok) => setTimeout(ok, 200));
  }
  throw new Error("processed にならない");
}

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
    webhookSecret: "whsec_e2e_webhook_lease_dummy",
    testHooks: {
      beforeFinishWebhookEvent: async (id) => {
        const f = beforeFinish.get(id);
        if (!f) return;
        beforeFinish.delete(id);
        await f();
      },
    },
  });
  console.log(`Stripe webhook lease E2E (emulator ${host} / ${process.env.FIREBASE_PROJECT_ID}, fake Stripe live :${PORT})`);
  const store = await createStore({ name: `処理権検証店舗 ${Date.now()}`, contactName: "", postalCode: "", address: "", phone: "", email: "" }, SYSTEM);
  const code = store.storeCode;

  // 1. 同じ通知を3件同時に受信：処理権を取った1件だけが処理する（ほかは 409 か、処理済みなら 200 の重複）
  {
    const p = await paidOnly(rt, code);
    const e = completedEv(p);
    const rs = await Promise.all([deliver(rt, e), deliver(rt, e), deliver(rt, e)]);
    const processed = rs.filter((r) => r.status === 200 && outcomeOf(r) === "confirmed").length;
    assert.equal(processed, 1, `処理した件数が1件ではありません：${rs.map((r) => `${r.status}:${outcomeOf(r) ?? JSON.stringify(r.body)}`).join(",")}`);
    for (const r of rs) assert.ok(r.status === 409 || (r.status === 200 && (outcomeOf(r) === "confirmed" || (r.body as { duplicate?: boolean }).duplicate)), `想定外の応答 ${r.status}`);
    const d = (await evDoc(e.id))!;
    assert.deepEqual([d.state, d.attempts, d.leaseOwner, d.leaseExpiresAt, Boolean(d.processedAt)], ["PROCESSED", 1, null, null, true]);
    assert.equal(await txCount(p.sessionId), 1);
    step(`同じ通知×3が同時：処理は1件だけ（ほかは 409 ${rs.filter((r) => r.status === 409).length} 件・重複 ${rs.filter((r) => r.status === 200 && (r.body as { duplicate?: boolean }).duplicate).length} 件）。処理権を取った回数1・完了で処理権を外す`);
  }

  // 2. 処理中（期限内）の処理権は奪えない／6. 処理済みの再送
  {
    const p = await paidOnly(rt, code);
    const e = completedEv(p);
    const held = await acquireWebhookEventLease("stripe", e.id, e.type);
    assert.equal(held.status, "acquired");
    const before = await evDoc(e.id);
    const r = await deliver(rt, e);
    assert.equal(r.status, 409, "期限内の処理権がある通知を処理しました");
    assert.equal(await txCount(p.sessionId), 0, "処理権を取れなかった配信が処理しました");
    assert.deepEqual(await evDoc(e.id), before, "処理権を取れなかった配信が記録を書き換えました");
    // 処理権を持つ処理が完了 → 再送は処理済み
    assert.equal(await finishWebhookEventWithLease("stripe", e.id, (held as { token: string }).token), "finished");
    assert.deepEqual((await deliver(rt, e)).body, { received: true, duplicate: true });
    const snap = JSON.stringify(await evDoc(e.id));
    assert.deepEqual((await deliver(rt, e)).body, { received: true, duplicate: true });
    assert.equal(JSON.stringify(await evDoc(e.id)), snap, "処理済みの通知の再送で記録が変わりました");
    step("期限内の処理権は奪えない（409・処理しない・記録も変えない）。処理権の持ち主の完了の後の再送は処理済み（何も書かない）");
  }

  // 3・10. 期限の境界：期限の1ms前は取れない、期限ちょうど・期限の後は取れる
  {
    const id = `evt_lse_boundary_${Date.now()}`;
    const t0 = new Date();
    const a = await acquireWebhookEventLease("stripe", id, "charge.refunded", undefined, { now: t0 });
    assert.equal(a.status, "acquired");
    const exp = ms((await evDoc(id))!.leaseExpiresAt);
    assert.equal(exp, t0.getTime() + WEBHOOK_LEASE_TTL_MS);
    assert.equal((await acquireWebhookEventLease("stripe", id, "charge.refunded", undefined, { now: new Date(exp - 1) })).status, "busy");
    const b = await acquireWebhookEventLease("stripe", id, "charge.refunded", undefined, { now: new Date(exp) });
    assert.equal(b.status, "acquired");
    assert.notEqual((b as { token: string }).token, (a as { token: string }).token, "処理権の値が同じです");
    const d = (await evDoc(id))!;
    assert.deepEqual([d.attempts, d.leaseOwner], [2, (b as { token: string }).token]);
    // 4・5. 古い持ち主の完了・失敗の記録は拒否（新しい持ち主の状態を上書きしない）
    assert.equal(await finishWebhookEventWithLease("stripe", id, (a as { token: string }).token), "lease_lost");
    assert.equal(await recordWebhookEventFailure("stripe", id, "OldOwnerError", (a as { token: string }).token), false);
    const after = (await evDoc(id))!;
    assert.deepEqual([after.processedAt, after.state, after.lastError, after.leaseOwner], [null, "RECEIVED", null, (b as { token: string }).token], "古い持ち主の記録が新しい持ち主の状態を上書きしました");
    assert.equal(await finishWebhookEventWithLease("stripe", id, (b as { token: string }).token), "finished");
    assert.equal(await finishWebhookEventWithLease("stripe", id, (a as { token: string }).token), "already_processed");
    step("期限の境界：期限の1ms前は busy、期限ちょうどで取り直せる（別の値・回数2）。古い持ち主の完了（lease_lost）・失敗の記録は拒否され、新しい持ち主が完了できる");
  }

  // 9. 処理権を取った後の処理の失敗：500・RETRYABLE・処理権を外す → すぐの再送で取り直して処理
  {
    const p = await paidOnly(rt, code);
    assert.equal(outcomeOf(await deliver(rt, completedEv(p))), "confirmed");
    await stripe.ctl(`refund/${p.charge}`);
    stripe.fake.failCalls.push({ path: /^\/v1\/refunds$/, method: "GET", skip: 0, count: 1 });
    const e = refundEv(p);
    assert.equal((await deliver(rt, e)).status, 500);
    const d = (await evDoc(e.id))!;
    assert.deepEqual([d.state, d.processedAt, d.leaseOwner, d.leaseExpiresAt, d.attempts], ["RETRYABLE", null, null, null, 1], "失敗した処理が処理権を外していません");
    const r2 = await deliver(rt, e);
    assert.deepEqual([r2.status, outcomeOf(r2)], [200, "refunded"]);
    assert.deepEqual([(await evDoc(e.id))!.state, (await evDoc(e.id))!.attempts, (await txDoc(p.txId)).amountRefunded], ["PROCESSED", 2, 100]);
    step("処理権を取った後の失敗：500・RETRYABLE・処理権を外す → すぐの再送で取り直して処理（回数2・返金は1回）");
  }

  // 11・12. 期限の後、古い処理がまだ動いている間に新しい処理が取り直す（返金・異議申し立て・決済要確認が二重にならない）
  {
    // 返金：古い処理が反映を終えて処理済みにする直前に、期限切れ → 新しい処理が取り直して処理・完了 → 古い処理は「先に完了済み」で 200（何も書かない）
    const p = await paidOnly(rt, code);
    assert.equal(outcomeOf(await deliver(rt, completedEv(p))), "confirmed");
    await stripe.ctl(`refund/${p.charge}`);
    const e = refundEv(p);
    let newer: Awaited<ReturnType<typeof deliver>> | null = null;
    beforeFinish.set(e.id, async () => {
      await evRef(e.id).update({ leaseExpiresAt: new Date(Date.now() - 1) }); // 古い処理の処理権が期限切れになった
      newer = await deliver(rt, e); // 新しい配信が取り直して処理する
    });
    const older = await deliver(rt, e);
    assert.deepEqual([newer!.status, outcomeOf(newer!)], [200, "unchanged"], "新しい処理が取り直せません（または二重に反映）");
    assert.equal(older.status, 200, "先に完了した通知を、古い処理が失敗にしました");
    const d = (await evDoc(e.id))!;
    assert.deepEqual([d.state, Boolean(d.processedAt), d.attempts, d.leaseOwner], ["PROCESSED", true, 2, null], "古い処理が新しい処理の完了を上書きしました");
    assert.deepEqual([(await txDoc(p.txId)).amountRefunded, (await txDoc(p.txId)).paymentStatus, await adjCount(p.txId)], [100, "REFUNDED", 0]);
    assert.deepEqual((await deliver(rt, e)).body, { received: true, duplicate: true });

    // 返金：新しい処理がまだ処理中（処理権を持ったまま）のときに古い処理が終わる → lease_lost で 500・何も書かない → 新しい処理が完了
    const p2 = await paidOnly(rt, code);
    assert.equal(outcomeOf(await deliver(rt, completedEv(p2))), "confirmed");
    await stripe.ctl(`refund/${p2.charge}`);
    const e2 = refundEv(p2);
    let newToken = "";
    beforeFinish.set(e2.id, async () => {
      const taken = await acquireWebhookEventLease("stripe", e2.id, e2.type, undefined, { now: new Date(Date.now() + WEBHOOK_LEASE_TTL_MS) }); // 期限の後の新しい処理
      assert.equal(taken.status, "acquired");
      newToken = (taken as { token: string }).token;
    });
    assert.equal((await deliver(rt, e2)).status, 500, "処理権を失った古い処理が処理済みにしました");
    let d2 = (await evDoc(e2.id))!;
    assert.deepEqual([d2.processedAt, d2.state, d2.leaseOwner, d2.lastError], [null, "RECEIVED", newToken, null], "処理権を失った古い処理が新しい処理の状態を上書きしました");
    assert.equal(await finishWebhookEventWithLease("stripe", e2.id, newToken), "finished");
    d2 = (await evDoc(e2.id))!;
    assert.deepEqual([d2.state, Boolean(d2.processedAt), (await txDoc(p2.txId)).amountRefunded], ["PROCESSED", true, 100]);

    // 異議申し立て（敗訴）も同じ
    const q = await paidOnly(rt, code);
    assert.equal(outcomeOf(await deliver(rt, completedEv(q))), "confirmed");
    const dp = stripe.addDispute(q.charge, { status: "lost" });
    const de = ev("charge.dispute.closed", { id: dp, object: "dispute" });
    let newerD: Awaited<ReturnType<typeof deliver>> | null = null;
    beforeFinish.set(de.id, async () => {
      await evRef(de.id).update({ leaseExpiresAt: new Date(Date.now() - 1) });
      newerD = await deliver(rt, de);
    });
    const olderD = await deliver(rt, de);
    assert.deepEqual([newerD!.status, outcomeOf(newerD!), olderD.status], [200, "unchanged", 200]);
    assert.deepEqual([(await txDoc(q.txId)).paymentStatus, (await txDoc(q.txId)).disputeStatus, (await evDoc(de.id))!.state], ["CHARGEBACK", "lost", "PROCESSED"]);

    // 決済要確認（決済記録の無い返金）：古い処理と新しい処理の両方が記録しても回数1。
    // この環境の注文がある決済の先着の返金は先に確定する（記録しない）ので、本当の異常（注文が無い決済）で確かめる
    const r = await paidOnly(rt, code);
    await fsdb().collection(C.checkouts).doc(r.checkoutId).delete();
    await stripe.ctl(`refund/${r.charge}`);
    const re = refundEv(r);
    beforeFinish.set(re.id, async () => {
      await evRef(re.id).update({ leaseExpiresAt: new Date(Date.now() - 1) });
      await deliver(rt, re);
    });
    assert.equal((await deliver(rt, re)).status, 200);
    const rv = (await fsdb().collection(C.paymentReviews).doc(paymentReviewId("transaction_not_found", r.charge)).get()).data()!;
    assert.equal(rv.occurrences, 1, "古い処理と新しい処理の両方で決済要確認を数えました");
    assert.deepEqual((await evDoc(re.id))!.recordedReviewIds, [paymentReviewId("transaction_not_found", r.charge)]);
    step("期限の後に古い処理が動いている間に新しい処理が取り直す：新しい処理が先に完了なら古い処理は 200（何も書かない）、新しい処理が処理中なら古い処理は lease_lost で 500（上書きしない）。返金1回・敗訴1回・決済要確認は回数1");
  }

  // 7. 以前の形の記録（処理権の項目なし）
  {
    const p = await paidOnly(rt, code);
    const e = completedEv(p);
    await evRef(e.id).set({ provider: "stripe", eventId: e.id, type: e.type, processedAt: null, createdAt: FieldValue.serverTimestamp() }); // 手順3-4より前の形（途中で止まった）
    const r = await deliver(rt, e);
    assert.deepEqual([r.status, outcomeOf(r)], [200, "confirmed"]);
    const d = (await evDoc(e.id))!;
    assert.deepEqual([d.state, d.attempts, d.leaseOwner, d.leaseExpiresAt, d.replayLeaseUntil], ["PROCESSED", 1, null, null, null]);
    const p2 = await paidOnly(rt, code);
    const e2 = completedEv(p2);
    await evRef(e2.id).set({ provider: "stripe", eventId: e2.id, type: e2.type, processedAt: null, createdAt: FieldValue.serverTimestamp(), state: "RECEIVED", attempts: 3, lastAttemptAt: new Date(), lastError: null, replayLeaseUntil: null }); // 手順3-4前半の形
    assert.equal((await deliver(rt, e2)).status, 200);
    assert.equal((await evDoc(e2.id))!.attempts, 4);
    step("以前の形の記録（処理権の項目なし）：処理権を取って処理し、完了で外す（回数は既存の値＋1）");
  }

  // 13. 決済・返金の回帰（同時の通知でも最後は正しい状態）
  {
    const p = await paidOnly(rt, code);
    await stripe.ctl(`refund/${p.charge}`);
    const c = completedEv(p);
    const f = refundEv(p);
    const rs = await Promise.all([deliver(rt, c), deliver(rt, c), deliver(rt, f), deliver(rt, f)]);
    for (const [i, r] of rs.entries()) if (r.status !== 200) await untilProcessed(rt, i < 2 ? c : f);
    const t = await txDoc(p.txId);
    assert.deepEqual([await txCount(p.sessionId), t.paymentStatus, t.amountRefunded], [1, "REFUNDED", 100]);
    step("決済確定と返金の通知が同時・同じ通知が2件ずつ：決済記録1件・返金済み・返金は1回（409・500 は再送で処理済み）");
  }

  console.log("\nSTRIPE WEBHOOK LEASE E2E PASSED");
}

main()
  .then(async () => {
    await stripe.stop();
    process.exit(0);
  })
  .catch(async (e) => {
    console.error("\nSTRIPE WEBHOOK LEASE E2E FAILED:", e);
    await stripe.stop().catch(() => {});
    process.exit(1);
  });
