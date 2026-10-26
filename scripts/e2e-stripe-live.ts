/**
 * Stripe の本番モード（livemode=true）の確定・照合・売上の記録・Webhook の E2E 検証。
 * 本物の Stripe・本番の Firebase には一切接続しない：
 *  - Stripe は、このスクリプトが起動する localhost の模擬サーバー（本番として振る舞う：cs_live_・livemode=true）だけ
 *  - Firebase は Firestore Emulator の demo- プロジェクトだけ
 *  - キーは形だけの偽物（環境変数には入れず、模擬の接続を作るときだけ使う）
 * アプリの決済の処理（画面・API）は今もテストモードだけなので、ここでは決済のライブラリを直接呼び、
 * 模擬の本番モードの接続（createSimulatedStripeRuntime）を渡して確かめる。
 *
 *   firebase emulators:start --only firestore --project demo-uranai
 *   （別ターミナル）FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 FIREBASE_PROJECT_ID=demo-uranai-live DB_PROVIDER=firestore npm run e2e:stripe-live
 */
import "dotenv/config";
import assert from "node:assert/strict";
import Stripe from "stripe";
import { createFakeStripe } from "./lib/fake-stripe";
import { C, fsdb } from "@/lib/firestore/admin";
import { dataProvider } from "@/lib/data-provider";
import { createStore } from "@/lib/services/stores";
import { monthTotals } from "@/lib/services/reports";
import { generateSettlements, listSettlements } from "@/lib/services/settlements";
import { createCheckout } from "@/lib/firestore/payments";
import { jstYearMonth, shiftYearMonth } from "@/lib/time";
import { createSimulatedStripeRuntime, type StripeRuntime } from "@/lib/payments/stripe-checkout";
import { confirmStripeCheckout, confirmStripeReturn, restoreStripeEntitlement, startStripeCheckout, stripeCheckoutStatus, syncStripeRefunds } from "@/lib/payments/stripe-confirm";
import { handleStripeWebhook } from "@/lib/payments/stripe-webhook";
import { STRIPE_SESSION_TTL_MS } from "@/lib/payments/stripe-checkout";

const SYSTEM = { userId: null, role: "SYSTEM" as const };
const step = (msg: string) => console.log(`  ✓ ${msg}`);
const ORIGIN = "http://localhost:3000";

// 本番として振る舞う模擬 Stripe と、比べるためのテストの模擬 Stripe（どちらも 127.0.0.1）
const LIVE_PORT = 12114;
const TEST_PORT = 12115;
const LIVE_KEY = "sk_live_e2e_dummy";
const TEST_KEY = "sk_test_e2e_dummy";
const LIVE_WHSEC = "whsec_e2e_live_dummy";
const TEST_WHSEC = "whsec_e2e_test_dummy";
const liveStripe = createFakeStripe({ port: LIVE_PORT, mode: "live", apiKey: LIVE_KEY });
const testStripe = createFakeStripe({ port: TEST_PORT, mode: "test", apiKey: TEST_KEY });

const signer = new Stripe("sk_test_signer");
let evN = 0;
function signed(type: string, object: Record<string, unknown>, livemode: boolean, secret: string, eventId?: string) {
  const payload = JSON.stringify({ id: eventId ?? `evt_${livemode ? "live" : "test"}_${++evN}_${Date.now()}`, object: "event", type, livemode, data: { object } });
  return { payload, sig: signer.webhooks.generateTestHeaderString({ payload, secret }) };
}
async function webhook(rt: StripeRuntime, type: string, object: Record<string, unknown>, opts: { livemode?: boolean; secret?: string; eventId?: string } = {}) {
  const e = signed(type, object, opts.livemode ?? rt.mode === "live", opts.secret ?? rt.webhookSecret, opts.eventId);
  return handleStripeWebhook(e.payload, e.sig, rt);
}
const outcomeOf = (r: { body: unknown }) => (r.body as { outcome?: string }).outcome;

/** 注文を作り、決済画面（Session）まで進める（Cookie の代わりにアクセスの合言葉を使う） */
async function begin(rt: StripeRuntime, storeCode: string) {
  const { checkoutId, accessToken } = await createCheckout(storeCode, "ZODIAC", { provider: "stripe", ttlMs: STRIPE_SESSION_TTL_MS });
  const r = await startStripeCheckout(accessToken, ORIGIN, rt);
  assert.equal(r.status, "redirect");
  const sessionId = (r as { url: string }).url.split("/").pop()!;
  return { checkoutId, accessToken, sessionId };
}
const txOf = async (checkoutId: string) => (await fsdb().collection(C.transactions).where("checkoutId", "==", checkoutId).get()).docs;
const entitlementsOf = async (txId: string) => (await fsdb().collection(C.fortuneSessions).where("transactionId", "==", txId).get()).size;

async function main() {
  const host = process.env.FIRESTORE_EMULATOR_HOST ?? "";
  assert.match(host, /^(127\.0\.0\.1|localhost|\[::1\]):\d+$/, "FIRESTORE_EMULATOR_HOST（localhost の Emulator）が必要です");
  assert.match(process.env.FIREBASE_PROJECT_ID ?? "", /^demo-/, "FIREBASE_PROJECT_ID は demo- で始まる Emulator 用の ID にしてください");
  assert.equal(dataProvider(), "firestore");
  // 本番用・テスト用の Stripe のキーを環境変数に入れない（アプリの判定には一切渡さない）
  for (const k of ["STRIPE_SECRET_KEY", "STRIPE_LIVE_CHECKOUT", "STRIPE_LIVE_OPERATOR_TEST", "VERCEL_ENV"]) delete process.env[k];
  await liveStripe.start();
  await testStripe.start();
  const live = createSimulatedStripeRuntime("live", { apiBase: `http://127.0.0.1:${LIVE_PORT}`, secretKey: LIVE_KEY, webhookSecret: LIVE_WHSEC });
  const test = createSimulatedStripeRuntime("test", { apiBase: `http://127.0.0.1:${TEST_PORT}`, secretKey: TEST_KEY, webhookSecret: TEST_WHSEC });
  console.log(`Stripe LIVE-mode E2E (emulator ${host} / ${process.env.FIREBASE_PROJECT_ID}, fake Stripe live :${LIVE_PORT} / test :${TEST_PORT})`);

  const stamp = Date.now();
  const store = await createStore({ name: `本番モード検証店舗 ${stamp}`, contactName: "", postalCode: "", address: "", phone: "", email: "" }, SYSTEM);
  const ym = jstYearMonth(new Date());
  const before = await monthTotals(ym, store.id);
  assert.deepEqual(before, { count: 0, gross: 0, storeShare: 0, operatorShare: 0, fee: 0 });

  // ---- 1. 本番モードの Session：cs_live_・livemode=true。注文に本番モードを記録 ----
  const p1 = await begin(live, store.storeCode);
  assert.match(p1.sessionId, /^cs_live_/);
  assert.equal(liveStripe.fake.sessions.get(p1.sessionId)!.livemode, true);
  assert.equal((await fsdb().collection(C.checkouts).doc(p1.checkoutId).get()).get("stripeLivemode"), true);
  assert.equal((await confirmStripeReturn(p1.accessToken, p1.sessionId, live)).status, "not_paid"); // 支払い前は確定しない
  assert.equal((await txOf(p1.checkoutId)).length, 0);
  step("本番モード：Session は cs_live_・livemode=true、注文に stripeLivemode=true。支払い前は確定しない");

  // ---- 2. 支払い → Webhook 2通（重複を含む）・戻り先・状態の確認が同時でも、記録と占い権利は1件 ----
  await liveStripe.ctl(`pay/${p1.sessionId}`, { fee: 4 });
  const obj = { id: p1.sessionId, object: "checkout.session" };
  const co1 = (await fsdb().collection(C.checkouts).doc(p1.checkoutId).get()).data()!;
  const results = await Promise.all([
    webhook(live, "checkout.session.completed", obj, { eventId: "evt_live_dup_1" }),
    webhook(live, "checkout.session.completed", obj, { eventId: "evt_live_dup_2" }),
    confirmStripeReturn(p1.accessToken, p1.sessionId, live),
    stripeCheckoutStatus({ id: p1.checkoutId, provider: "stripe", status: "PROCESSING", providerPaymentId: p1.sessionId, expiresAt: co1.expiresAt.toDate(), storeId: store.id, fortuneType: "ZODIAC" }, live),
  ]);
  assert.ok(results.slice(0, 2).every((r) => (r as { status: number }).status === 200));
  const txs = await txOf(p1.checkoutId);
  assert.equal(txs.length, 1, "本番の決済記録が1件ではありません");
  const t1 = txs[0];
  assert.deepEqual(
    { livemode: t1.get("livemode"), countable: t1.get("countable"), cYm: t1.get("cYm"), amount: t1.get("amount"), storeShare: t1.get("storeShare"), operatorShare: t1.get("operatorShare"), fee: t1.get("paymentFee"), status: t1.get("paymentStatus"), provider: t1.get("paymentProvider") },
    { livemode: true, countable: true, cYm: ym, amount: 100, storeShare: 30, operatorShare: 70, fee: 4, status: "SUCCEEDED", provider: "stripe" },
  );
  assert.equal(await entitlementsOf(t1.id), 1, "占い権利が1件ではありません");
  // 同じ通知の再送・別の通知の重複
  assert.deepEqual((await webhook(live, "checkout.session.completed", obj, { eventId: "evt_live_dup_1" })).body, { received: true, duplicate: true });
  assert.equal(outcomeOf(await webhook(live, "checkout.session.completed", obj)), "duplicate");
  assert.equal((await confirmStripeCheckout(p1.sessionId, live)).status, "duplicate");
  assert.equal((await txOf(p1.checkoutId)).length, 1);
  assert.equal(await entitlementsOf(t1.id), 1);
  step("本番モード：Webhook 2通・戻り先・状態の確認が同時でも、決済記録・占い権利は1件。livemode=true・countable=true・100円→店舗30円・運営70円・手数料4円。再送・重複も1件のまま");

  // ---- 3. 本番の決済だけが売上・店舗の取り分に入る。店舗の最終利用日も更新 ----
  assert.deepEqual(await monthTotals(ym, store.id), { count: 1, gross: 100, storeShare: 30, operatorShare: 70, fee: 4 });
  const lastUsed = (await fsdb().collection(C.stores).doc(store.id).get()).get("lastUsedAt");
  assert.ok(lastUsed, "店舗の最終利用日が更新されていません");
  step("本番の決済は売上（今月・店舗別）に計上：1件・100円・店舗30円・運営70円・手数料4円。店舗の最終利用日も更新");

  // ---- 4. テストモードの決済は、同じ店舗でも売上に入らない ----
  const pt = await begin(test, store.storeCode);
  assert.match(pt.sessionId, /^cs_test_/);
  await testStripe.ctl(`pay/${pt.sessionId}`);
  assert.equal(outcomeOf(await webhook(test, "checkout.session.completed", { id: pt.sessionId, object: "checkout.session" })), "confirmed");
  const [tt] = await txOf(pt.checkoutId);
  assert.deepEqual([tt.get("livemode"), tt.get("countable"), tt.get("cYm")], [false, false, null]);
  assert.deepEqual(await monthTotals(ym, store.id), { count: 1, gross: 100, storeShare: 30, operatorShare: 70, fee: 4 });
  step("テストモードの決済は記録するが livemode=false・countable=false。売上は本番の1件のまま");

  // ---- 5. モードの取り違え：テストの接続で本番の Session、本番の接続でテストの Session・通知は扱わない ----
  assert.deepEqual(await confirmStripeCheckout(p1.sessionId, test), { status: "rejected", reason: "invalid_session_id" });
  assert.deepEqual(await confirmStripeCheckout(pt.sessionId, live), { status: "rejected", reason: "invalid_session_id" });
  assert.equal((await confirmStripeReturn(p1.accessToken, p1.sessionId, test)).status, "not_linked");
  assert.equal((await webhook(test, "checkout.session.completed", obj, { livemode: true })).status, 400); // 本番の通知をテストの環境へ
  assert.equal((await webhook(live, "checkout.session.completed", { id: pt.sessionId }, { livemode: false })).status, 400); // テストの通知を本番の環境へ
  assert.equal((await webhook(live, "checkout.session.completed", obj, { secret: TEST_WHSEC })).status, 400); // Sandbox の署名の値
  // 本番モードの注文を、テストの接続で決済画面へ進めない（逆も）
  await assert.rejects(startStripeCheckout(p1.accessToken, ORIGIN, test), /CheckoutError|checkout_conflict|お支払い情報/);
  await assert.rejects(startStripeCheckout(pt.accessToken, ORIGIN, live), /CheckoutError|checkout_conflict|お支払い情報/);
  assert.equal((await txOf(p1.checkoutId)).length, 1);
  assert.equal((await txOf(pt.checkoutId)).length, 1);
  step("モードの取り違え：別のモードの Session・通知・署名の値は拒否（400・invalid_session_id・not_linked・409）。記録は増えない");

  // ---- 6. livemode が混ざった本番の決済（Charge だけ livemode=false）・本番の注文に別モードの記録は確定しない ----
  const p2 = await begin(live, store.storeCode);
  const pay2 = await liveStripe.ctl(`pay/${p2.sessionId}`);
  Object.assign(liveStripe.fake.charges.get(pay2.charge!)!, { livemode: false });
  assert.deepEqual(await confirmStripeCheckout(p2.sessionId, live), { status: "rejected", reason: "livemode" });
  assert.equal((await txOf(p2.checkoutId)).length, 0);
  const p3 = await begin(live, store.storeCode);
  await fsdb().collection(C.checkouts).doc(p3.checkoutId).update({ stripeLivemode: false }); // 注文のモードの記録と食い違う
  await liveStripe.ctl(`pay/${p3.sessionId}`);
  assert.deepEqual(await confirmStripeCheckout(p3.sessionId, live), { status: "rejected", reason: "mode_mismatch" });
  assert.equal((await txOf(p3.checkoutId)).length, 0);
  step("livemode が混ざった決済（Charge だけ false）・注文のモードの記録との食い違いは拒否（記録なし）");

  // ---- 7. 確定待ち（PayPay の非同期の支払い）→ 確定、期限切れ、非同期の失敗（本番モードでも既存どおり） ----
  const p4 = await begin(live, store.storeCode);
  await liveStripe.ctl(`pay/${p4.sessionId}`, { method: "paypay", async: true });
  assert.equal(outcomeOf(await webhook(live, "checkout.session.completed", { id: p4.sessionId })), "not_paid");
  assert.equal((await txOf(p4.checkoutId)).length, 0, "確定前に記録されました");
  await liveStripe.ctl(`async-succeed/${p4.sessionId}`);
  assert.equal(outcomeOf(await webhook(live, "checkout.session.async_payment_succeeded", { id: p4.sessionId })), "confirmed");
  const [t4] = await txOf(p4.checkoutId);
  assert.deepEqual([t4.get("stripePaymentMethod"), t4.get("livemode"), t4.get("countable")], ["paypay", true, true]);
  const p5 = await begin(live, store.storeCode);
  await liveStripe.ctl(`expire/${p5.sessionId}`);
  assert.equal(outcomeOf(await webhook(live, "checkout.session.expired", { id: p5.sessionId })), "expired");
  const p6 = await begin(live, store.storeCode);
  await liveStripe.ctl(`pay/${p6.sessionId}`, { method: "paypay", async: true });
  await liveStripe.ctl(`async-fail/${p6.sessionId}`);
  assert.equal(outcomeOf(await webhook(live, "checkout.session.async_payment_failed", { id: p6.sessionId })), "failed");
  assert.equal((await txOf(p5.checkoutId)).length + (await txOf(p6.checkoutId)).length, 0);
  assert.deepEqual(await monthTotals(ym, store.id), { count: 2, gross: 200, storeShare: 60, operatorShare: 140, fee: 8 });
  step("本番モードの確定待ち（PayPay）→ 確定で計上、期限切れ・非同期の失敗は記録なし。売上は本番の2件（200円・店舗60円）");

  // ---- 8. 返金：処理中 → 成功で REFUNDED、売上から外れる。再送しても1回だけ ----
  const rf = await liveStripe.ctl(`refund/${t1.get("stripeChargeId")}`, { status: "pending" });
  assert.equal(outcomeOf(await webhook(live, "refund.created", { id: rf.refund, object: "refund", charge: t1.get("stripeChargeId") })), "refund_pending");
  await liveStripe.ctl(`refund-status/${rf.refund}`, { status: "succeeded" });
  const [w1, w2] = await Promise.all([
    webhook(live, "refund.updated", { id: rf.refund, object: "refund", charge: t1.get("stripeChargeId") }),
    webhook(live, "charge.refunded", { id: t1.get("stripeChargeId"), object: "charge" }),
  ]);
  assert.deepEqual([outcomeOf(w1), outcomeOf(w2)].sort(), ["refunded", "unchanged"]);
  const t1r = await fsdb().collection(C.transactions).doc(t1.id).get();
  assert.deepEqual([t1r.get("paymentStatus"), t1r.get("countable"), t1r.get("livemode")], ["REFUNDED", false, true]);
  // テストの接続では本番の返金を扱わない（Stripe も別のモードの Charge は「見つからない」と返す。記録は変わらない）
  await assert.rejects(syncStripeRefunds(String(t1.get("stripeChargeId")), test), /No such charge/);
  assert.equal(await restoreStripeEntitlement(t1.id, { userId: "op-unit", role: "OPERATOR" }, test), "not_eligible");
  assert.equal((await fsdb().collection(C.transactions).doc(t1.id).get()).get("paymentStatus"), "REFUNDED");
  assert.deepEqual(await monthTotals(ym, store.id), { count: 1, gross: 100, storeShare: 30, operatorShare: 70, fee: 4 });
  step("本番モードの返金：処理中 → 成功で REFUNDED・countable=false、売上から外れる（2件→1件）。同時の通知でも反映は1回。テストの接続では扱わない");

  // ---- 9. 月次精算：先月分の本番の決済だけを含める（テスト決済は含めない） ----
  const prev = shiftYearMonth(ym, -1);
  const lastMonth = Math.floor(new Date(`${prev}-15T12:00:00+09:00`).getTime() / 1000);
  const pl = await begin(live, store.storeCode);
  await liveStripe.ctl(`pay/${pl.sessionId}`, { created: lastMonth });
  assert.equal(outcomeOf(await webhook(live, "checkout.session.completed", { id: pl.sessionId })), "confirmed");
  const ptl = await begin(test, store.storeCode);
  await testStripe.ctl(`pay/${ptl.sessionId}`, { created: lastMonth });
  assert.equal(outcomeOf(await webhook(test, "checkout.session.completed", { id: ptl.sessionId })), "confirmed");
  await generateSettlements(prev, SYSTEM);
  const st = await listSettlements({ yearMonth: prev, storeId: store.id });
  assert.equal(st.length, 1);
  assert.deepEqual([st[0].s.transactionCount, st[0].s.grossSales, st[0].s.storeShare], [1, 100, 30], "精算が本番の決済1件（100円・店舗30円）ではありません");
  step("月次精算（先月分）：本番の決済1件・100円・店舗30円だけ。同じ月のテスト決済は含めない");

  console.log("\nSTRIPE LIVE-MODE E2E PASSED");
}

main()
  .then(async () => {
    await Promise.all([liveStripe.stop(), testStripe.stop()]);
    process.exit(0);
  })
  .catch(async (e) => {
    console.error("\nSTRIPE LIVE-MODE E2E FAILED:", e);
    await Promise.all([liveStripe.stop(), testStripe.stop()]).catch(() => undefined);
    process.exit(1);
  });
