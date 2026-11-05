/**
 * 新しい検証環境（個人事業主の Stripe の Sandbox ＋ 新しい Firebase のプロジェクト）の E2E 検証。
 *  - テストの接続でも STRIPE_ACCOUNT_ID を指定すると、キーの持ち主のアカウントを Stripe API で確かめる
 *    （旧 Sandbox のキーが残っていたら、決済画面・確定・Webhook を受け付けず、記録を作らない）
 *  - 正しいアカウントのキーなら、決済・Webhook の再送・返金・異議申し立てが今までどおり動く
 *  - 別の環境（別の Firebase のプロジェクト＝環境の目印が違う）の決済の通知は、この環境では処理しない
 *  - アカウントの指定が無い接続（以前からの Preview と同じ）は、今までどおり確かめない
 * 本物の Stripe・本番の Firebase には一切接続しない（localhost の模擬 Stripe 2つ＝旧 Sandbox・新 Sandbox と、Firestore Emulator の demo- プロジェクトだけ）。
 * Preview の Firebase の接続先の判定（コードに固定した一覧）は tests/preview-sandbox-target.test.ts。
 *
 *   firebase emulators:start --only firestore --project demo-uranai
 *   （別ターミナル）FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 FIREBASE_PROJECT_ID=demo-uranai-sandbox-env DB_PROVIDER=firestore npm run e2e:stripe-sandbox-env
 */
import "dotenv/config";
import assert from "node:assert/strict";
import Stripe from "stripe";
import { createFakeStripe } from "./lib/fake-stripe";
import { C, fsdb, safeId } from "@/lib/firestore/admin";
import { dataProvider } from "@/lib/data-provider";
import { createStore } from "@/lib/services/stores";
import { monthTotals } from "@/lib/services/reports";
import { createCheckout } from "@/lib/firestore/payments";
import { jstYearMonth } from "@/lib/time";
import { createSimulatedStripeRuntime, stripeEnvTag, StripeAccountMismatchError, STRIPE_SESSION_TTL_MS, type StripeRuntime } from "@/lib/payments/stripe-checkout";
import { confirmStripeCheckout, startStripeCheckout } from "@/lib/payments/stripe-confirm";
import { handleStripeWebhook } from "@/lib/payments/stripe-webhook";

const SYSTEM = { userId: null, role: "SYSTEM" as const };
const step = (msg: string) => console.log(`  ✓ ${msg}`);
const ORIGIN = "http://localhost:3000";
const OLD_PORT = 12161;
const NEW_PORT = 12162;
const OLD_KEY = "sk_test_e2e_old_sandbox_dummy";
const NEW_KEY = "sk_test_e2e_new_sandbox_dummy";
const OLD_ACCOUNT = "acct_fakeOldSandbox01";
const NEW_ACCOUNT = "acct_fakeNewSandbox01";
const WHSEC = "whsec_e2e_new_sandbox_dummy";
const oldSandbox = createFakeStripe({ port: OLD_PORT, mode: "test", apiKey: OLD_KEY, accountId: OLD_ACCOUNT });
const newSandbox = createFakeStripe({ port: NEW_PORT, mode: "test", apiKey: NEW_KEY, accountId: NEW_ACCOUNT });

const signer = new Stripe("sk_test_signer");
let evN = 0;
type Ev = { type: string; object: Record<string, unknown>; id: string };
const ev = (type: string, object: Record<string, unknown>): Ev => ({ type, object, id: `evt_sbx_${++evN}_${Date.now()}` });
async function deliver(rt: StripeRuntime, e: Ev) {
  const payload = JSON.stringify({ id: e.id, object: "event", type: e.type, livemode: false, data: { object: e.object } });
  return handleStripeWebhook(payload, signer.webhooks.generateTestHeaderString({ payload, secret: rt.webhookSecret }), rt);
}
const outcomeOf = (r: { body: unknown }) => (r.body as { outcome?: string }).outcome;
const countTx = async () => (await fsdb().collection(C.transactions).count().get()).data().count;
const accountCalls = (s: typeof oldSandbox) => s.fake.callLog.filter((c) => c === "GET /v1/account").length;

async function main() {
  const host = process.env.FIRESTORE_EMULATOR_HOST ?? "";
  assert.match(host, /^(127\.0\.0\.1|localhost|\[::1\]):\d+$/, "FIRESTORE_EMULATOR_HOST（localhost の Emulator）が必要です");
  const project = process.env.FIREBASE_PROJECT_ID ?? "";
  assert.match(project, /^demo-/, "FIREBASE_PROJECT_ID は demo- で始まる Emulator 用の ID にしてください");
  assert.ok(!process.env.VERCEL_ENV, "Vercel 上では実行しません");
  assert.equal(dataProvider(), "firestore");
  for (const k of ["STRIPE_SECRET_KEY", "STRIPE_LIVE_CHECKOUT", "STRIPE_LIVE_OPERATOR_TEST", "STRIPE_NEW_CHECKOUT", "STRIPE_TEST_CHECKOUT", "STRIPE_ACCOUNT_ID"]) delete process.env[k];
  // この検証用の demo- プロジェクトを空にしてから始める（件数で「記録を作らない」を確かめるため）
  let del = 0;
  for (let i = 0; i < 20 && del !== 200; i++) {
    if (i) await new Promise((ok) => setTimeout(ok, 500));
    del = (await fetch(`http://${host}/emulator/v1/projects/${project}/databases/(default)/documents`, { method: "DELETE" })).status;
  }
  assert.equal(del, 200, "Emulator のデータを消せませんでした");
  await oldSandbox.start();
  await newSandbox.start();
  console.log(`Stripe sandbox environment E2E (emulator ${host} / ${project}, fake Stripe old :${OLD_PORT} / new :${NEW_PORT})`);

  // 新しい検証環境の接続（STRIPE_ACCOUNT_ID＝新 Sandbox のアカウント）
  const rtNew = createSimulatedStripeRuntime("test", { apiBase: `http://127.0.0.1:${NEW_PORT}`, secretKey: NEW_KEY, webhookSecret: WHSEC, accountId: NEW_ACCOUNT });
  // ブランチの環境変数の上書き漏れ：旧 Sandbox のキーのまま、アカウントの指定は新 Sandbox
  const rtLeaked = createSimulatedStripeRuntime("test", { apiBase: `http://127.0.0.1:${OLD_PORT}`, secretKey: OLD_KEY, webhookSecret: WHSEC, accountId: NEW_ACCOUNT });
  const store = await createStore({ name: `新Sandbox検証店舗 ${Date.now()}`, contactName: "", postalCode: "", address: "", phone: "", email: "" }, SYSTEM);
  const ym = jstYearMonth(new Date());

  // ================= 1. 旧 Sandbox のキーの混入：受け付けない =================
  {
    const { accessToken } = await createCheckout(store.storeCode, "ZODIAC", { provider: "stripe", ttlMs: STRIPE_SESSION_TTL_MS });
    const created0 = oldSandbox.fake.createCalls;
    await assert.rejects(() => startStripeCheckout(accessToken, ORIGIN, rtLeaked), StripeAccountMismatchError);
    assert.equal(oldSandbox.fake.createCalls, created0, "旧 Sandbox のキーで決済画面を作りました");
    // 旧 Sandbox で支払い済みの Session（混入したキーで作られた決済の再現）：確定・Webhook とも受け付けない
    const { checkoutId, accessToken: t2 } = await createCheckout(store.storeCode, "ZODIAC", { provider: "stripe", ttlMs: STRIPE_SESSION_TTL_MS });
    const legacyRt = createSimulatedStripeRuntime("test", { apiBase: `http://127.0.0.1:${OLD_PORT}`, secretKey: OLD_KEY, webhookSecret: WHSEC });
    const r = await startStripeCheckout(t2, ORIGIN, legacyRt);
    const sessionId = (r as { url: string }).url.split("/").pop()!;
    await oldSandbox.ctl(`pay/${sessionId}`, { fee: 4 });
    await assert.rejects(() => confirmStripeCheckout(sessionId, rtLeaked), StripeAccountMismatchError);
    const e = ev("checkout.session.completed", { id: sessionId, object: "checkout.session" });
    const w = await deliver(rtLeaked, e);
    assert.equal(w.status, 503);
    assert.equal((await fsdb().collection(C.webhookEvents).doc(safeId("stripe", e.id)).get()).exists, false);
    assert.equal(await countTx(), 0, "旧 Sandbox のキーで決済記録が作られました");
    assert.equal((await fsdb().collection(C.checkouts).doc(checkoutId).get()).get("status"), "PROCESSING");
    const alert = (await fsdb().collection(C.paymentAlerts).where("kind", "==", "stripe_account_mismatch").get()).docs;
    assert.deepEqual([alert.length, alert[0]?.get("mode")], [1, "test"]);
    step("1. 旧 Sandbox のキーの混入（アカウントの指定は新 Sandbox）：決済画面・確定・Webhook を受け付けない（503・記録なし・決済監視に test で記録）");
  }

  // ================= 2. 新 Sandbox の正しいキー：今までどおり動く =================
  {
    const { checkoutId, accessToken } = await createCheckout(store.storeCode, "ZODIAC", { provider: "stripe", ttlMs: STRIPE_SESSION_TTL_MS });
    const calls0 = accountCalls(newSandbox);
    const r = await startStripeCheckout(accessToken, ORIGIN, rtNew);
    assert.equal(r.status, "redirect");
    const sessionId = (r as { url: string }).url.split("/").pop()!;
    const p = await newSandbox.ctl(`pay/${sessionId}`, { fee: 4 });
    const e = ev("checkout.session.completed", { id: sessionId, object: "checkout.session" });
    assert.equal(outcomeOf(await deliver(rtNew, e)), "confirmed");
    assert.equal((await deliver(rtNew, e)).status, 200); // 同じ通知の再送
    assert.equal(outcomeOf(await deliver(rtNew, ev("checkout.session.completed", { id: sessionId, object: "checkout.session" }))), "duplicate");
    assert.equal(accountCalls(newSandbox) - calls0, 1, "アカウントの確認が接続ごとに1回ではありません");
    const txId = `stripe_${p.paymentIntent!}`;
    let t = (await fsdb().collection(C.transactions).doc(txId).get()).data()!;
    assert.deepEqual([t.livemode, t.paymentStatus, t.recheckState, t.checkoutId], [false, "SUCCEEDED", "DONE", checkoutId]);
    // 返金・異議申し立て
    newSandbox.addRefund(p.charge!, { amount: 30 });
    assert.equal(outcomeOf(await deliver(rtNew, ev("charge.refunded", { id: p.charge!, object: "charge" }))), "partial");
    const dp = newSandbox.addDispute(p.charge!, { amount: 70 });
    assert.equal(outcomeOf(await deliver(rtNew, ev("charge.dispute.created", { id: dp, object: "dispute" }))), "dispute_open");
    t = (await fsdb().collection(C.transactions).doc(txId).get()).data()!;
    assert.deepEqual([t.amountRefunded, t.disputeStatus, t.disputeNeedsReview], [30, "open", true]);
    // Sandbox の決済は売上・精算に含めない
    assert.equal((await monthTotals(ym, store.id)).count, 0);
    step("2. 新 Sandbox の正しいキー：アカウントの確認は1回だけ。決済・再送（二重にしない）・一部返金・異議申し立てが今までどおり。売上には含めない");
  }

  // ================= 3. 別の環境（別の Firebase のプロジェクト）の決済の通知は処理しない =================
  {
    const otherEnv = createSimulatedStripeRuntime("test", { apiBase: `http://127.0.0.1:${NEW_PORT}`, secretKey: NEW_KEY, webhookSecret: WHSEC, accountId: NEW_ACCOUNT, envTag: stripeEnvTag("uranai-other-env") });
    const { accessToken } = await createCheckout(store.storeCode, "ZODIAC", { provider: "stripe", ttlMs: STRIPE_SESSION_TTL_MS });
    const r = await startStripeCheckout(accessToken, ORIGIN, otherEnv); // 別の環境で作った Session（metadata の環境の目印が違う）
    const sessionId = (r as { url: string }).url.split("/").pop()!;
    await newSandbox.ctl(`pay/${sessionId}`, { fee: 4 });
    const before = await countTx();
    // ※ 注文はこの Emulator にあるので、目印が違う決済は「食い違い」として処理済みにしない（例外 → 500）。別の環境の注文が無い場合の扱いは e2e:stripe-env
    const w = await deliver(rtNew, ev("checkout.session.completed", { id: sessionId, object: "checkout.session" }));
    assert.equal(w.status, 500, `別の環境の目印の決済を処理しました：${w.status}`);
    assert.equal(await countTx(), before, "別の環境の決済の記録が作られました");
    step("3. 同じ Sandbox を使う別の環境（環境の目印が違う）の決済：この環境では確定しない（記録なし。食い違いは処理済みにしない）");
  }

  // ================= 4. アカウントの指定が無い接続（以前からの Preview と同じ）：今までどおり確かめない =================
  {
    const legacyRt = createSimulatedStripeRuntime("test", { apiBase: `http://127.0.0.1:${OLD_PORT}`, secretKey: OLD_KEY, webhookSecret: WHSEC });
    const calls0 = accountCalls(oldSandbox);
    const { accessToken } = await createCheckout(store.storeCode, "ZODIAC", { provider: "stripe", ttlMs: STRIPE_SESSION_TTL_MS });
    const r = await startStripeCheckout(accessToken, ORIGIN, legacyRt);
    const sessionId = (r as { url: string }).url.split("/").pop()!;
    await oldSandbox.ctl(`pay/${sessionId}`, { fee: 4 });
    assert.equal(outcomeOf(await deliver(legacyRt, ev("checkout.session.completed", { id: sessionId, object: "checkout.session" }))), "confirmed");
    assert.equal(accountCalls(oldSandbox), calls0, "アカウントの指定が無い接続でアカウントを確かめました（以前からの Preview の動作が変わる）");
    step("4. アカウントの指定が無い接続（以前からの Preview と同じ）：アカウントを確かめず、今までどおり確定");
  }

  console.log("\nSTRIPE SANDBOX ENVIRONMENT E2E PASSED");
}

main()
  .then(async () => {
    await oldSandbox.stop();
    await newSandbox.stop();
    process.exit(0);
  })
  .catch(async (e) => {
    console.error("\nSTRIPE SANDBOX ENVIRONMENT E2E FAILED:", e);
    await oldSandbox.stop().catch(() => {});
    await newSandbox.stop().catch(() => {});
    process.exit(1);
  });
