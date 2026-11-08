/**
 * 支払い済みなのに注文・店舗の記録と照合できない決済の通知（F1：Webhook の取りこぼし対策）の E2E 検証。
 * 本物の Stripe・本番の Firebase には一切接続しない（localhost の模擬 Stripe（本番モード）と Firestore Emulator の demo- プロジェクトだけ。キーは形だけの偽物）。
 *
 *  1. 正常な決済：今までどおり確定（100円・店舗30円・運営70円）。決済要確認・決済監視に記録しない
 *  2. 注文が無い決済：決済要確認（paid_checkout_unconfirmable）・決済監視（stripe_paid_not_confirmed）に記録し、500（処理済みにしない）。
 *     再送しても記録は1件・回数1。注文が戻った後の Stripe の再送で確定（100円・30円・70円）。その後の再送は重複
 *  3. 店舗が無い決済：同じく記録して 500。Webhook の自動の復旧（Stripe から通知を取り直す）で、店舗が戻った後に確定。
 *     決済監視の点検と同じ記録（種類・対象）に1件でまとまる
 *  4. 記録に失敗：500（処理済みにしない・決済記録なし）。再送で記録される
 *  5. 照合できない理由が戻らないもの（注文が別の Session と紐付いている）：記録して 200（処理済み）。再送は重複
 *  6. 返金済み・異議申し立て：今までどおり反映（売上から除く・異議申し立てを記録）
 *  7. 記録に入るのは ID・金額・モード・理由の名前だけ
 *
 *   firebase emulators:start --only firestore --project demo-uranai
 *   （別ターミナル）FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 FIREBASE_PROJECT_ID=demo-uranai-paid-unconfirmable DB_PROVIDER=firestore npm run e2e:stripe-paid-unconfirmable
 */
import "dotenv/config";
import assert from "node:assert/strict";
import Stripe from "stripe";
import { createFakeStripe } from "./lib/fake-stripe";
import { C, fsdb, safeId } from "@/lib/firestore/admin";
import { dataProvider } from "@/lib/data-provider";
import { createStore } from "@/lib/services/stores";
import { paymentReviewId } from "@/lib/firestore/payment-reviews";
import { paymentAlertId } from "@/lib/firestore/payment-alerts";
import { createCheckout } from "@/lib/firestore/payments";
import { createSimulatedStripeRuntime, STRIPE_SESSION_TTL_MS, type StripeRuntime } from "@/lib/payments/stripe-checkout";
import { startStripeCheckout } from "@/lib/payments/stripe-confirm";
import { handleStripeWebhook } from "@/lib/payments/stripe-webhook";
import { recoverStripeWebhookEvent } from "@/lib/payments/webhook-recovery";
import { runPaymentMonitor } from "@/lib/payments/payment-monitor";
import { monthTotals } from "@/lib/services/reports";
import { jstYearMonth } from "@/lib/time";

const SYSTEM = { userId: null, role: "SYSTEM" as const };
const step = (msg: string) => console.log(`  ✓ ${msg}`);
const ORIGIN = "http://localhost:3000";
const PORT = 12181;
const KEY = "sk_live_e2e_paid_unconfirmable_dummy";
const WHSEC = "whsec_e2e_paid_unconfirmable_dummy";
const stripe = createFakeStripe({ port: PORT, mode: "live", apiKey: KEY });
const failRecord = new Map<string, number>();

const signer = new Stripe("sk_test_signer");
let evN = 0;
type Ev = { type: string; object: Record<string, unknown>; id: string };
/** 通知を作り、模擬 Stripe にも登録する（Webhook の自動の復旧が Stripe から取り直せるように） */
function ev(type: string, object: Record<string, unknown>): Ev {
  const e = { type, object, id: `evt_pu_${++evN}_${Date.now()}` };
  stripe.fake.events.set(e.id, { id: e.id, object: "event", type, livemode: true, created: Math.floor(Date.now() / 1000), data: { object } });
  return e;
}
async function deliver(rt: StripeRuntime, e: Ev) {
  const payload = JSON.stringify({ id: e.id, object: "event", type: e.type, livemode: rt.mode === "live", data: { object: e.object } });
  const sig = signer.webhooks.generateTestHeaderString({ payload, secret: rt.webhookSecret });
  return handleStripeWebhook(payload, sig, rt);
}
const outcomeOf = (r: { body: unknown }) => (r.body as { outcome?: string; duplicate?: boolean }).outcome ?? ((r.body as { duplicate?: boolean }).duplicate ? "duplicate" : undefined);

type Pay = { checkoutId: string; sessionId: string; charge: string; pi: string; txId: string };
async function paid(rt: StripeRuntime, storeCode: string): Promise<Pay> {
  const { checkoutId, accessToken } = await createCheckout(storeCode, "ZODIAC", { provider: "stripe", ttlMs: STRIPE_SESSION_TTL_MS });
  const r = await startStripeCheckout(accessToken, ORIGIN, rt);
  const sessionId = (r as { url: string }).url.split("/").pop()!;
  const p = await stripe.ctl(`pay/${sessionId}`, { fee: 4 });
  return { checkoutId, sessionId, charge: p.charge!, pi: p.paymentIntent!, txId: `stripe_${p.paymentIntent!}` };
}
const completed = (p: Pay) => ev("checkout.session.completed", { id: p.sessionId, object: "checkout.session" });
const reviewOf = async (p: Pay) => (await fsdb().collection(C.paymentReviews).doc(paymentReviewId("paid_checkout_unconfirmable", p.charge)).get()).data() ?? null;
const alertOf = async (p: Pay) => (await fsdb().collection(C.paymentAlerts).doc(paymentAlertId("stripe_paid_not_confirmed", p.checkoutId)).get()).data() ?? null;
const alertsFor = async (p: Pay) => (await fsdb().collection(C.paymentAlerts).where("kind", "==", "stripe_paid_not_confirmed").where("objectId", "==", p.checkoutId).get()).size;
const eventOf = async (eventId: string) => (await fsdb().collection(C.webhookEvents).doc(safeId("stripe", eventId)).get()).data() ?? null;
const txOf = async (p: Pay) => (await fsdb().collection(C.transactions).doc(p.txId).get()).data() ?? null;
const splitOf = (t: Record<string, unknown> | null) => (t ? [t.amount, t.storeShare, t.operatorShare, t.paymentStatus] : null);

/** 決済要確認の記録に、決まった項目（ID・金額・モード・理由）以外が入っていないこと */
function assertMinimal(review: Record<string, unknown>, p: Pay, reason: string) {
  assert.equal(review.kind, "paid_checkout_unconfirmable");
  assert.equal(review.status, "OPEN");
  assert.deepEqual([review.objectType, review.objectId, review.chargeId, review.paymentIntentId, review.sessionId, review.checkoutId], ["charge", p.charge, p.charge, p.pi, p.sessionId, p.checkoutId]);
  assert.deepEqual([review.mismatches, review.amount, review.livemode], [[reason], 100, true]);
  const text = JSON.stringify(review);
  for (const s of [KEY, WHSEC, "whsec_", "sk_live", "stripe-signature", "@", "email", "card"]) assert.equal(text.includes(s), false, `記録に ${s} が含まれています`);
}

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
  console.log(`Stripe paid-unconfirmable E2E (emulator ${host} / ${process.env.FIREBASE_PROJECT_ID}, fake Stripe live :${PORT})`);
  const store = await createStore({ name: `照合不可の検証店舗 ${Date.now()}`, contactName: "", postalCode: "", address: "", phone: "", email: "" }, SYSTEM);
  const code = store.storeCode;
  const ym = jstYearMonth(new Date());

  // 1. 正常な決済
  const n1 = await paid(rt, code);
  let r = await deliver(rt, completed(n1));
  assert.deepEqual([r.status, outcomeOf(r)], [200, "confirmed"]);
  assert.deepEqual(splitOf(await txOf(n1)), [100, 30, 70, "SUCCEEDED"]);
  assert.deepEqual([await reviewOf(n1), await alertOf(n1)], [null, null]);
  assert.deepEqual(await monthTotals(ym, store.id), { count: 1, gross: 100, storeShare: 30, operatorShare: 70, fee: 4, feeEstimated: 0 });
  step("正常な決済：今までどおり確定（100円・店舗30円・運営70円・手数料4円）。決済要確認・決済監視の記録なし");

  // 2. 注文が無い決済 → 記録して 500。再送でも1件。注文が戻った後の Stripe の再送で確定
  {
    const p = await paid(rt, code);
    const saved = (await fsdb().collection(C.checkouts).doc(p.checkoutId).get()).data()!;
    await fsdb().collection(C.checkouts).doc(p.checkoutId).delete(); // 消失・復元の途中を再現
    const e = completed(p);
    r = await deliver(rt, e);
    assert.equal(r.status, 500, "注文が無いのに処理済みにしました（Stripe が再送しません）");
    assert.equal((await eventOf(e.id))?.processedAt ?? null, null);
    assertMinimal((await reviewOf(p))!, p, "unknown_checkout");
    const a = (await alertOf(p))!;
    assert.deepEqual([a.kind, a.objectType, a.objectId, a.mode, a.status], ["stripe_paid_not_confirmed", "checkout", p.checkoutId, "live", "OPEN"]);
    assert.equal(await txOf(p), null, "決済記録を作りました");
    r = await deliver(rt, e); // Stripe の再送（まだ注文が無い）
    assert.equal(r.status, 500);
    assert.deepEqual([(await reviewOf(p))!.occurrences, await alertsFor(p)], [1, 1], "再送で記録が増えました");
    await fsdb().collection(C.checkouts).doc(p.checkoutId).set(saved); // 復元
    r = await deliver(rt, e); // 復元の後の Stripe の再送
    assert.deepEqual([r.status, outcomeOf(r)], [200, "confirmed"]);
    assert.deepEqual(splitOf(await txOf(p)), [100, 30, 70, "SUCCEEDED"]);
    assert.equal((await fsdb().collection(C.fortuneSessions).doc(p.txId).get()).get("status"), "PAID");
    r = await deliver(rt, e);
    assert.deepEqual([r.status, outcomeOf(r)], [200, "duplicate"]);
    r = await deliver(rt, completed(p)); // 別の通知（同じ決済）
    assert.deepEqual([r.status, outcomeOf(r)], [200, "duplicate"]);
    assert.equal((await fsdb().collection(C.transactions).where("checkoutId", "==", p.checkoutId).get()).size, 1);
    step("注文が無い：決済要確認・決済監視に1件ずつ記録して 500（処理済みにしない・決済記録なし）。再送でも1件・回数1。注文の復元の後の再送で確定（100円・30円・70円・権利 PAID）。その後は重複");
  }

  // 3. 店舗が無い決済 → 記録して 500。決済監視の点検と同じ記録。店舗が戻った後、Webhook の自動の復旧で確定
  {
    const p = await paid(rt, code);
    const st = (await fsdb().collection(C.stores).doc(store.id).get()).data()!;
    await fsdb().collection(C.stores).doc(store.id).delete();
    const e = completed(p);
    r = await deliver(rt, e);
    assert.equal(r.status, 500);
    assertMinimal((await reviewOf(p))!, p, "store_not_found");
    assert.equal(await txOf(p), null);
    // 決済監視の点検（確定待ちのまま・Stripe では支払い済み）も同じ種類・同じ対象の記録に1件でまとまる
    const m = await runPaymentMonitor({ rt, now: new Date(Date.now() + 2 * 3600_000) }); // 確定待ちのまま60分を過ぎた時点として点検する
    assert.ok(m.started, "決済監視の点検を始められませんでした");
    assert.ok(m.report.result !== "failed", `決済監視の点検に失敗しました（${m.report.result}）`);
    assert.ok((m.report.checks.stripeCompared ?? 0) >= 1, "決済監視が Stripe と照合していません");
    assert.equal(await alertsFor(p), 1, "決済監視と同じ異常が2件になりました");
    await fsdb().collection(C.stores).doc(store.id).set(st); // 復元
    await fsdb().collection(C.webhookEvents).doc(safeId("stripe", e.id)).update({ lastAttemptAt: new Date(Date.now() - 2 * 3600_000) }); // 自動の復旧の対象になるまでの時間を省く
    const rec = await recoverStripeWebhookEvent(e.id, rt);
    assert.equal(rec.result, "recovered", `Webhook の復旧の結果が想定外です（${rec.result}）`);
    assert.deepEqual(splitOf(await txOf(p)), [100, 30, 70, "SUCCEEDED"]);
    assert.ok((await eventOf(e.id))?.processedAt, "復旧した通知が処理済みになっていません");
    step("店舗が無い：記録して 500。決済監視の点検と同じ記録に1件でまとまる。店舗の復元の後、Webhook の自動の復旧（Stripe から取り直し）で確定（100円・30円・70円）");
  }

  // 4. 記録に失敗 → 500（処理済みにしない・決済記録なし）。再送で記録される
  {
    const p = await paid(rt, code);
    await fsdb().collection(C.checkouts).doc(p.checkoutId).delete();
    failRecord.set("paid_checkout_unconfirmable", 1);
    const e = completed(p);
    r = await deliver(rt, e);
    assert.equal(r.status, 500);
    assert.deepEqual([await reviewOf(p), await txOf(p), (await eventOf(e.id))?.processedAt ?? null], [null, null, null]);
    r = await deliver(rt, e);
    assert.equal(r.status, 500); // 注文はまだ無い（記録はできた）
    assert.equal((await reviewOf(p))?.occurrences, 1);
    step("決済要確認の記録に失敗：500（処理済みにしない・決済記録なし）。Stripe の再送で記録される（回数1）");
  }

  // 5. 戻らない理由（注文が別の Session と紐付いている）→ 記録して 200（処理済み）。再送は重複
  {
    const p = await paid(rt, code);
    await fsdb().collection(C.checkouts).doc(p.checkoutId).update({ providerPaymentId: "cs_live_e2e_other_session_0001" });
    const e = completed(p);
    r = await deliver(rt, e);
    assert.deepEqual([r.status, outcomeOf(r)], [200, "rejected"]);
    assertMinimal((await reviewOf(p))!, p, "session_not_linked");
    assert.equal(await alertsFor(p), 1);
    assert.equal(await txOf(p), null);
    r = await deliver(rt, e);
    assert.deepEqual([r.status, outcomeOf(r)], [200, "duplicate"]);
    assert.equal((await reviewOf(p))!.occurrences, 1);
    step("注文が別の Session と紐付いている（戻らない理由）：記録して 200（処理済み・運営の確認と返金の対応へ）。再送は重複");
  }

  // 6. 返金済み・異議申し立て：今までどおり
  {
    const p = await paid(rt, code);
    assert.equal(outcomeOf(await deliver(rt, completed(p))), "confirmed");
    await stripe.ctl(`refund/${p.charge}`);
    r = await deliver(rt, ev("charge.refunded", { id: p.charge, object: "charge" }));
    assert.deepEqual([r.status, outcomeOf(r)], [200, "refunded"]);
    assert.equal((await txOf(p))!.paymentStatus, "REFUNDED");
    const q = await paid(rt, code);
    assert.equal(outcomeOf(await deliver(rt, completed(q))), "confirmed");
    const d = await stripe.ctl(`dispute/${q.charge}`, { status: "needs_response" });
    r = await deliver(rt, ev("charge.dispute.created", { id: d.dispute, object: "dispute" }));
    assert.deepEqual([r.status, outcomeOf(r)], [200, "dispute_open"]);
    assert.equal((await txOf(q))!.disputeStatus, "open");
    assert.deepEqual([await reviewOf(p), await reviewOf(q), await alertOf(p), await alertOf(q)], [null, null, null, null]);
    step("返金・異議申し立て：今までどおり反映（REFUNDED・対応中を記録）。照合不可の記録はしない");
  }

  // 売上：正常な決済の100円・30円・70円の配分は変わらない（返金した決済は除く）
  const totals = await monthTotals(ym, store.id);
  const succeeded = (await fsdb().collection(C.transactions).where("storeId", "==", store.id).get()).docs.filter((t) => t.get("paymentStatus") === "SUCCEEDED");
  for (const t of succeeded) assert.deepEqual([t.get("amount"), t.get("storeShare"), t.get("operatorShare")], [100, 30, 70]);
  assert.deepEqual([totals.count, totals.gross, totals.storeShare, totals.operatorShare], [succeeded.length, succeeded.length * 100, succeeded.length * 30, succeeded.length * 70]);
  step(`売上：成功の決済 ${succeeded.length}件 = ${totals.gross}円（店舗 ${totals.storeShare}円・運営 ${totals.operatorShare}円）。1件ずつ100円・30円・70円`);

  assert.equal([...failRecord.values()].reduce((x, n) => x + n, 0), 0, "（前提）用意した記録の失敗がすべて使われていません");
  await stripe.stop();
  console.log("\nSTRIPE PAID UNCONFIRMABLE E2E PASSED");
}

main().catch((e) => {
  console.error("STRIPE PAID UNCONFIRMABLE E2E FAILED:", e);
  process.exit(1);
});
