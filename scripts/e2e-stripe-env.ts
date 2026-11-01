/**
 * Stripe の決済の環境の識別・分離の E2E 検証（Firestore Emulator と模擬 Stripe だけ）。
 * 同じ Stripe のアカウント（Sandbox）を複数の環境（Preview・ローカルなど、別の Firestore）で使うと、どの環境の送信先にも
 * すべての決済の通知が届く。決済を作った環境は Session・PaymentIntent の metadata の環境を表す値（stripeEnvTag）で見分ける。
 *  - この環境の決済（本番モード・テストモード）は今までどおり確定・返金・異議申し立てを反映し、売上は本番の決済だけ
 *  - 別の環境の決済の通知は、この環境に何も書かずに IGNORED_OTHER_ENV で処理済み（決済要確認・売上に出ない。再送は重複）
 *  - 値が無い以前の決済は今までどおり（別の環境とは判断しない）
 *  - 値が違うのにこの環境に記録がある（食い違い）は処理せず 500（処理済みにしない）。直れば再送で反映する
 *  - モード（livemode）の取り違え・署名の値の誤りは今までどおり 400
 *  - 同じ通知が同時に届いても処理は1回（処理権）
 * 本物の Stripe・本番の Firebase には一切接続しない（localhost の模擬 Stripe と Firestore Emulator の demo- プロジェクトだけ。キーは形だけの偽物）。
 *
 *   firebase emulators:start --only firestore --project demo-uranai
 *   （別ターミナル）FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 FIREBASE_PROJECT_ID=demo-uranai-stripe-env DB_PROVIDER=firestore npm run e2e:stripe-env
 */
import "dotenv/config";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import Stripe from "stripe";
import { createFakeStripe } from "./lib/fake-stripe";
import { C, fsdb, safeId } from "@/lib/firestore/admin";
import { dataProvider } from "@/lib/data-provider";
import { createStore } from "@/lib/services/stores";
import { monthTotals } from "@/lib/services/reports";
import { jstYearMonth } from "@/lib/time";
import { paymentReviewId } from "@/lib/firestore/payment-reviews";
import { createCheckout } from "@/lib/firestore/payments";
import { createSimulatedStripeRuntime, createStripeCheckoutSession, STRIPE_SESSION_TTL_MS, stripeEnvTag, stripeSessionExpiry, type StripeRuntime } from "@/lib/payments/stripe-checkout";
import { confirmStripeCheckout, startStripeCheckout } from "@/lib/payments/stripe-confirm";
import { handleStripeWebhook } from "@/lib/payments/stripe-webhook";

const SYSTEM = { userId: null, role: "SYSTEM" as const };
const step = (msg: string) => console.log(`  ✓ ${msg}`);
const ORIGIN = "http://localhost:3000";
const LIVE_PORT = 12193;
const TEST_PORT = 12194;
const LIVE_KEY = "sk_live_e2e_stripe_env_dummy";
const TEST_KEY = "sk_test_e2e_stripe_env_dummy";
const liveStripe = createFakeStripe({ port: LIVE_PORT, mode: "live", apiKey: LIVE_KEY });
const testStripe = createFakeStripe({ port: TEST_PORT, mode: "test", apiKey: TEST_KEY });
/** 同じ Sandbox・同じ送信先の署名の値を使う別の環境（別の Firestore）の値 */
const OTHER_TAG = stripeEnvTag("demo-uranai-another-environment");

const signer = new Stripe("sk_test_signer");
let evN = 0;
type Ev = { type: string; object: Record<string, unknown>; id: string };
const ev = (type: string, object: Record<string, unknown>): Ev => ({ type, object, id: `evt_env_${++evN}_${Date.now()}` });
async function deliver(rt: StripeRuntime, e: Ev, o: { livemode?: boolean; secret?: string } = {}) {
  const payload = JSON.stringify({ id: e.id, object: "event", type: e.type, livemode: o.livemode ?? rt.mode === "live", data: { object: e.object } });
  const sig = signer.webhooks.generateTestHeaderString({ payload, secret: o.secret ?? rt.webhookSecret });
  return handleStripeWebhook(payload, sig, rt);
}
const outcomeOf = (r: { body: unknown }) => (r.body as { outcome?: string }).outcome;
const fakeOf = (rt: StripeRuntime) => (rt.mode === "live" ? liveStripe : testStripe);

type Pay = { checkoutId: string; sessionId: string; charge: string; pi: string; txId: string };
async function pay(rt: StripeRuntime, sessionId: string, checkoutId: string): Promise<Pay> {
  const p = await fakeOf(rt).ctl(`pay/${sessionId}`, { fee: 4 });
  return { checkoutId, sessionId, charge: p.charge!, pi: p.paymentIntent!, txId: `stripe_${p.paymentIntent!}` };
}
/** この環境の決済（アプリの手順どおりに注文・Session を作る） */
async function ownSession(rt: StripeRuntime, storeCode: string) {
  const { checkoutId, accessToken } = await createCheckout(storeCode, "ZODIAC", { provider: "stripe", ttlMs: STRIPE_SESSION_TTL_MS });
  const r = await startStripeCheckout(accessToken, ORIGIN, rt);
  return { checkoutId, sessionId: (r as { url: string }).url.split("/").pop()! };
}
/** 別の環境の決済（別の Firestore の注文。この環境には注文が無い。checkoutId を渡すとその注文に紐付ける＝食い違いの再現） */
async function otherSession(other: StripeRuntime, storeId: string, checkoutId: string = randomUUID()) {
  const s = await createStripeCheckoutSession({ checkoutId, storeId, fortuneType: "ZODIAC", productName: "別の環境の占い", origin: ORIGIN, expiresAt: stripeSessionExpiry() }, other);
  return { checkoutId, sessionId: s.id };
}
/** 以前の Session（環境を表す値が無い）にする（支払いの前に。模擬 Stripe の Session を直接書き換える） */
function dropEnvTag(rt: StripeRuntime, sessionId: string) {
  const s = fakeOf(rt).fake.sessions.get(sessionId)! as unknown as { metadata: Record<string, string>; pi_metadata: Record<string, string> };
  delete s.metadata.uranaiEnv;
  delete s.pi_metadata.uranaiEnv;
}

const completedEv = (p: { sessionId: string }) => ev("checkout.session.completed", { id: p.sessionId, object: "checkout.session" });
const refundEv = (p: Pay) => ev("charge.refunded", { id: p.charge, object: "charge" });
const disputeEv = (dp: string) => ev("charge.dispute.created", { id: dp, object: "dispute" });
const evDoc = async (id: string) => (await fsdb().collection(C.webhookEvents).doc(safeId("stripe", id)).get()).data() ?? null;
const txDoc = async (id: string) => (await fsdb().collection(C.transactions).doc(id).get()).data() ?? null;
const txCount = async (sessionId: string) => (await fsdb().collection(C.transactions).where("stripeCheckoutSessionId", "==", sessionId).get()).size;
const coDoc = async (id: string) => (await fsdb().collection(C.checkouts).doc(id).get()).data() ?? null;
const reviewCount = async (...objectIds: string[]) => {
  let n = 0;
  for (const id of objectIds) n += (await fsdb().collection(C.paymentReviews).where("objectId", "==", id).get()).size;
  return n;
};
const reviewOf = async (kind: Parameters<typeof paymentReviewId>[0], objectId: string) => (await fsdb().collection(C.paymentReviews).doc(paymentReviewId(kind, objectId)).get()).data() ?? null;
const alertCount = async (eventId: string) => (await fsdb().collection(C.paymentAlerts).where("objectId", "==", eventId).get()).size;

/** 別の環境の通知として処理済みになった記録（何も書かず、処理権を外し、決済要確認の記録も無い） */
async function assertIgnoredOtherEnv(e: Ev) {
  const d = (await evDoc(e.id))!;
  assert.equal(d.state, "IGNORED_OTHER_ENV", `state が IGNORED_OTHER_ENV ではありません：${d.state}`);
  assert.ok(d.processedAt, "processedAt がありません（再送のたびに処理し直す）");
  assert.deepEqual([d.leaseOwner, d.leaseExpiresAt, d.lastError], [null, null, null]);
  assert.deepEqual(d.recordedReviewIds ?? [], [], "決済要確認を記録しています");
}

async function main() {
  const host = process.env.FIRESTORE_EMULATOR_HOST ?? "";
  assert.match(host, /^(127\.0\.0\.1|localhost|\[::1\]):\d+$/, "FIRESTORE_EMULATOR_HOST（localhost の Emulator）が必要です");
  assert.match(process.env.FIREBASE_PROJECT_ID ?? "", /^demo-/, "FIREBASE_PROJECT_ID は demo- で始まる Emulator 用の ID にしてください");
  assert.equal(dataProvider(), "firestore");
  for (const k of ["STRIPE_SECRET_KEY", "STRIPE_LIVE_CHECKOUT", "STRIPE_LIVE_OPERATOR_TEST", "VERCEL_ENV"]) delete process.env[k];
  await liveStripe.start();
  await testStripe.start();
  const live = createSimulatedStripeRuntime("live", { apiBase: `http://127.0.0.1:${LIVE_PORT}`, secretKey: LIVE_KEY, webhookSecret: "whsec_e2e_stripe_env_live" });
  const test = createSimulatedStripeRuntime("test", { apiBase: `http://127.0.0.1:${TEST_PORT}`, secretKey: TEST_KEY, webhookSecret: "whsec_e2e_stripe_env_test" });
  // 別の環境：同じ Stripe のアカウント・同じ送信先の署名の値（同じ Sandbox を共有）で、Firestore だけが違う
  const liveOther = createSimulatedStripeRuntime("live", { apiBase: `http://127.0.0.1:${LIVE_PORT}`, secretKey: LIVE_KEY, webhookSecret: "whsec_e2e_stripe_env_live", envTag: OTHER_TAG });
  const testOther = createSimulatedStripeRuntime("test", { apiBase: `http://127.0.0.1:${TEST_PORT}`, secretKey: TEST_KEY, webhookSecret: "whsec_e2e_stripe_env_test", envTag: OTHER_TAG });
  assert.equal(live.envTag, stripeEnvTag(process.env.FIREBASE_PROJECT_ID!));
  assert.equal(live.envTag, test.envTag, "同じ Firestore の本番・テストの接続で環境を表す値が違います");
  assert.notEqual(live.envTag, OTHER_TAG);
  console.log(`Stripe environment E2E (emulator ${host} / ${process.env.FIREBASE_PROJECT_ID}, fake Stripe live :${LIVE_PORT} test :${TEST_PORT})`);
  const store = await createStore({ name: `環境識別検証店舗 ${Date.now()}`, contactName: "", postalCode: "", address: "", phone: "", email: "" }, SYSTEM);
  const ym = jstYearMonth(new Date());
  const allBefore = await monthTotals(ym);
  assert.deepEqual(await monthTotals(ym, store.id), { count: 0, gross: 0, storeShare: 0, operatorShare: 0, fee: 0, feeEstimated: 0 });

  // 1. この環境の本番モードの決済（擬似）：Session・PaymentIntent に環境を表す値。確定し、売上（店舗別・全体）に計上
  const own = await ownSession(live, store.storeCode);
  const fs = liveStripe.fake.sessions.get(own.sessionId)! as unknown as { metadata: Record<string, string>; pi_metadata: Record<string, string> };
  assert.deepEqual([fs.metadata.uranaiEnv, fs.pi_metadata.uranaiEnv], [live.envTag, live.envTag]);
  const p1 = await pay(live, own.sessionId, own.checkoutId);
  const r1 = await deliver(live, completedEv(p1));
  assert.deepEqual([r1.status, outcomeOf(r1)], [200, "confirmed"]);
  assert.equal((await txDoc(p1.txId))!.livemode, true);
  assert.deepEqual(await monthTotals(ym, store.id), { count: 1, gross: 100, storeShare: 30, operatorShare: 70, fee: 4, feeEstimated: 0 });
  step("この環境の本番モードの決済：metadata に環境を表す値（Session・PaymentIntent）。確定・livemode=true・売上に1件100円");

  // 2. この環境のテストモードの決済：確定するが売上に入らない
  const ownT = await ownSession(test, store.storeCode);
  const pt = await pay(test, ownT.sessionId, ownT.checkoutId);
  const rt1 = await deliver(test, completedEv(pt));
  assert.deepEqual([rt1.status, outcomeOf(rt1)], [200, "confirmed"]);
  assert.equal((await txDoc(pt.txId))!.livemode, false);
  assert.deepEqual((await monthTotals(ym, store.id)).count, 1);
  step("この環境のテストモードの決済：確定・livemode=false・売上は本番の1件のまま");

  // 3. モードの取り違え・署名の値の誤り（今までどおり 400。処理しない）
  {
    const e = completedEv(p1);
    const r = await deliver(test, e, { livemode: true });
    assert.equal(r.status, 400);
    assert.equal(await evDoc(e.id), null, "取り違えの通知を記録しました");
    assert.ok(await reviewOf("mode_mismatch", p1.sessionId), "モードの取り違えが決済要確認にありません");
    assert.equal((await deliver(live, completedEv(pt), { livemode: false })).status, 400);
    const e2 = completedEv(p1);
    assert.equal((await deliver(live, e2, { secret: "whsec_e2e_stripe_env_test" })).status, 400, "テストの送信先の署名の値で本番の通知を受け付けました");
    assert.equal(await evDoc(e2.id), null);
    assert.throws(() => createSimulatedStripeRuntime("live", { apiBase: `http://127.0.0.1:${LIVE_PORT}`, secretKey: TEST_KEY, webhookSecret: "whsec_x" }), /does not match the mode/);
    step("モードの取り違え（テストの環境に本番の通知・本番の環境にテストの通知）・別の送信先の署名の値・モードと違うキーは 400／例外");
  }

  // 4. 別の環境の本番モードの決済：決済確定の通知は IGNORED_OTHER_ENV で処理済み。注文・決済記録・決済要確認・売上は変わらない
  const other = await otherSession(liveOther, store.id);
  const po = await pay(live, other.sessionId, other.checkoutId);
  {
    const e = completedEv(po);
    // 同じ通知が同時に3件：処理は1件（ほかは 409 か重複）
    const rs = await Promise.all([deliver(live, e), deliver(live, e), deliver(live, e)]);
    assert.equal(rs.filter((r) => r.status === 200 && outcomeOf(r) === "ignored_other_env").length, 1, rs.map((r) => `${r.status}:${outcomeOf(r)}`).join(","));
    for (const r of rs) assert.ok(r.status === 409 || r.status === 200, `想定外の応答 ${r.status}`);
    await assertIgnoredOtherEnv(e);
    assert.equal((await evDoc(e.id))!.attempts, 1);
    assert.deepEqual((await deliver(live, e)).body, { received: true, duplicate: true }, "再送が処理済みになりません");
    assert.equal(await txCount(other.sessionId), 0);
    assert.equal(await coDoc(other.checkoutId), null);
    assert.equal(await reviewCount(other.sessionId, po.charge, po.pi), 0);
    assert.equal(await alertCount(e.id), 0, "別の環境の通知を決済監視に記録しました");
    // 戻り先の URL（この環境のサーバーで確定を試みる）でも、何も書かずに拒否
    assert.deepEqual(await confirmStripeCheckout(other.sessionId, live), { status: "rejected", reason: "other_environment" });
    assert.equal(await txCount(other.sessionId), 0);
    step("別の環境の決済の確定の通知（3件同時）：処理1件・IGNORED_OTHER_ENV で処理済み・再送は重複。注文・決済記録・決済要確認・決済監視なし。戻り先でも拒否");
  }

  // 5. 別の環境の決済の返金・異議申し立て：「決済記録が無い」の決済要確認を出さない（同じ Sandbox の雑音）
  {
    await liveStripe.ctl(`refund/${po.charge}`);
    const e = refundEv(po);
    const r = await deliver(live, e);
    assert.deepEqual([r.status, outcomeOf(r)], [200, "ignored_other_env"]);
    await assertIgnoredOtherEnv(e);
    const dp = (await liveStripe.ctl(`dispute/${po.charge}`)).dispute!;
    const e2 = disputeEv(dp);
    const r2 = await deliver(live, e2);
    assert.deepEqual([r2.status, outcomeOf(r2)], [200, "ignored_other_env"]);
    await assertIgnoredOtherEnv(e2);
    // 額の不正な申し立て（通常は決済要確認に記録する）も、別の環境の決済なら記録しない
    const other2 = await otherSession(liveOther, store.id);
    const po2 = await pay(live, other2.sessionId, other2.checkoutId);
    const dpBad = (await liveStripe.ctl(`dispute/${po2.charge}`, { amount: 999 })).dispute!;
    const e3 = disputeEv(dpBad);
    const r3 = await deliver(live, e3);
    assert.deepEqual([r3.status, outcomeOf(r3)], [200, "ignored_other_env"]);
    await assertIgnoredOtherEnv(e3);
    assert.equal(await reviewCount(po.charge, dp, dpBad, po2.charge), 0, "別の環境の決済を決済要確認に記録しました");
    step("別の環境の決済の返金・異議申し立て（額の不正を含む）：IGNORED_OTHER_ENV。決済要確認（決済記録が無い・額の不正）なし");
  }

  // 6. 別の環境のテストモードの決済も同じ
  {
    const ot = await otherSession(testOther, store.id);
    const pot = await pay(test, ot.sessionId, ot.checkoutId);
    const e = completedEv(pot);
    const r = await deliver(test, e);
    assert.deepEqual([r.status, outcomeOf(r)], [200, "ignored_other_env"]);
    await assertIgnoredOtherEnv(e);
    assert.equal(await txCount(ot.sessionId), 0);
    step("別の環境のテストモードの決済：IGNORED_OTHER_ENV・決済記録なし");
  }

  // 7. 以前の決済（環境を表す値が無い）：この環境の決済は今までどおり確定・返金。別の環境の決済も今までどおり（記録が無い＝決済要確認）
  {
    const legacyOwn = await ownSession(live, store.storeCode);
    dropEnvTag(live, legacyOwn.sessionId);
    const pl = await pay(live, legacyOwn.sessionId, legacyOwn.checkoutId);
    const r = await deliver(live, completedEv(pl));
    assert.deepEqual([r.status, outcomeOf(r)], [200, "confirmed"]);
    assert.equal((await monthTotals(ym, store.id)).count, 2);
    await liveStripe.ctl(`refund/${pl.charge}`);
    const rr = await deliver(live, refundEv(pl));
    assert.deepEqual([rr.status, outcomeOf(rr)], [200, "refunded"]);
    assert.equal((await txDoc(pl.txId))!.paymentStatus, "REFUNDED");
    assert.equal((await monthTotals(ym, store.id)).count, 1, "全額返金した決済が売上に残っています");

    const legacyOther = await otherSession(liveOther, store.id);
    dropEnvTag(live, legacyOther.sessionId);
    const plo = await pay(live, legacyOther.sessionId, legacyOther.checkoutId);
    const e = completedEv(plo);
    const r2 = await deliver(live, e);
    assert.deepEqual([r2.status, outcomeOf(r2)], [200, "rejected"]); // 今までどおり（注文が無い＝unknown_checkout）
    assert.equal((await evDoc(e.id))!.state, "PROCESSED");
    await liveStripe.ctl(`refund/${plo.charge}`);
    const e2 = refundEv(plo);
    const r3 = await deliver(live, e2);
    assert.deepEqual([r3.status, outcomeOf(r3)], [200, "ignored"]);
    assert.ok(await reviewOf("transaction_not_found", plo.charge), "値が無い決済の『決済記録が無い』が記録されていません（今までの動き）");
    assert.equal((await evDoc(e2.id))!.state, "PROCESSED");
    step("以前の決済（値なし）：この環境の決済は確定・返金（売上から除外）。別の環境とは判断せず、今までどおり（決済記録が無い＝決済要確認）");
  }

  // 8. 食い違い（値が違うのにこの環境に注文がある）：決済を記録せず 500。処理済みにしない
  {
    const { checkoutId } = await createCheckout(store.storeCode, "ZODIAC", { provider: "stripe", ttlMs: STRIPE_SESSION_TTL_MS });
    const mixed = await otherSession(liveOther, store.id, checkoutId);
    const pm = await pay(live, mixed.sessionId, checkoutId);
    const e = completedEv(pm);
    const before = await coDoc(checkoutId);
    const r = await deliver(live, e);
    assert.equal(r.status, 500);
    const d = (await evDoc(e.id))!;
    assert.deepEqual([d.processedAt, d.state, d.lastError, d.leaseOwner], [null, "RETRYABLE", "StripeEnvironmentMismatchError", null]);
    assert.equal(await txCount(mixed.sessionId), 0, "食い違いの決済を記録しました");
    assert.deepEqual(await coDoc(checkoutId), before, "食い違いの注文を書き換えました");
    assert.equal(await alertCount(e.id), 1, "決済監視に記録されていません");
    assert.equal((await deliver(live, e)).status, 500, "再送で処理済みになりました");
    assert.equal((await evDoc(e.id))!.processedAt, null);
    step("食い違い（値が違うのにこの環境に注文がある）：決済を記録せず 500・RETRYABLE（StripeEnvironmentMismatchError）・決済監視に記録。再送も 500");
  }

  // 9. 食い違い（この環境の決済記録があるのに、PaymentIntent の値が違う）：返金・異議申し立てを反映せず 500。直れば再送で反映
  {
    await liveStripe.ctl(`pi-metadata/${p1.pi}`, { uranaiEnv: OTHER_TAG });
    await liveStripe.ctl(`refund/${p1.charge}`);
    const e = refundEv(p1);
    assert.equal((await deliver(live, e)).status, 500);
    assert.deepEqual([(await evDoc(e.id))!.processedAt, (await evDoc(e.id))!.lastError], [null, "StripeEnvironmentMismatchError"]);
    assert.equal((await txDoc(p1.txId))!.paymentStatus, "SUCCEEDED", "食い違いの返金を反映しました");
    assert.equal((await monthTotals(ym, store.id)).count, 1);
    const dp = (await liveStripe.ctl(`dispute/${p1.charge}`)).dispute!;
    const e2 = disputeEv(dp);
    assert.equal((await deliver(live, e2)).status, 500);
    assert.equal((await txDoc(p1.txId))!.disputeStatus ?? null, null, "食い違いの異議申し立てを反映しました");
    assert.equal(await reviewCount(p1.charge, dp), 0);
    // 値が直った（この環境の値）→ 再送で反映
    await liveStripe.ctl(`pi-metadata/${p1.pi}`, { uranaiEnv: live.envTag });
    const rr = await deliver(live, e);
    assert.deepEqual([rr.status, outcomeOf(rr)], [200, "refunded"]);
    assert.equal((await evDoc(e.id))!.state, "PROCESSED");
    assert.equal((await txDoc(p1.txId))!.paymentStatus, "REFUNDED");
    const rd = await deliver(live, e2);
    assert.equal(rd.status, 200);
    assert.equal((await evDoc(e2.id))!.state, "PROCESSED");
    step("食い違い（決済記録があるのに値が違う）：返金・異議申し立てを反映せず 500。値が直れば再送で反映（返金済み・PROCESSED）");
  }

  // 10. 売上：店舗別・全体とも、この環境の本番の決済だけ（別の環境・テストの決済・返金済みは含まない）
  {
    // 手数料は返金済みの決済も含める（今までの仕様）：この環境の本番の決済2件×4円だけ。別の環境・テストの決済の手数料は入らない
    assert.deepEqual(await monthTotals(ym, store.id), { count: 0, gross: 0, storeShare: 0, operatorShare: 0, fee: 8, feeEstimated: 0 });
    const allAfter = await monthTotals(ym);
    assert.deepEqual([allAfter.count - allBefore.count, allAfter.gross - allBefore.gross, allAfter.fee - allBefore.fee], [0, 0, 8], "全体の売上が変わりました（別の環境・テストの決済が入っています）");
    step("売上：店舗別・全体とも、本番の決済は2件とも全額返金で0件（手数料はこの環境の本番の2件分8円だけ）。別の環境・テストの決済は一度も入らない");
  }

  console.log("\nSTRIPE ENV E2E PASSED");
}

main()
  .then(async () => {
    await liveStripe.stop();
    await testStripe.stop();
    process.exit(0);
  })
  .catch(async (e) => {
    console.error("\nSTRIPE ENV E2E FAILED:", e);
    await liveStripe.stop().catch(() => {});
    await testStripe.stop().catch(() => {});
    process.exit(1);
  });
