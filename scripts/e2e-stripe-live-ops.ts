/**
 * Stripe の本番モード（livemode=true）を実際の決済の処理で使うときの、運用の流れの E2E 検証（本番の接続を模擬）。
 *  - キーのアカウントの確認（STRIPE_ACCOUNT_ID）：別のアカウントのキーなら、決済画面・確定・Webhook を受け付けない
 *  - 本番・テストのキー・通知の混在、署名の不一致の拒否。Webhook の再送で二重に処理しない
 *  - 返金・チャージバック（敗訴）・異議申し立ての対応中（精算の保留 → 勝訴で解除）
 *  - 先着の異議申し立ての通知 → PENDING の再確認 → 自動の回収。以前の形の記録（recheckState なし）は回収の対象外で、後の通知で反映
 *  - Webhook の復旧（自動）・決済監視の点検を本番の接続で実行
 * 本物の Stripe・本番の Firebase には一切接続しない（localhost の模擬 Stripe と Firestore Emulator の demo- プロジェクトだけ。キーは形だけの偽物）。
 * 本番の接続は Production でしか作れない（stripe-guard.ts）ため、ここでは模擬の本番の接続（createSimulatedStripeRuntime）を渡して、
 * 本番の接続と同じ項目（アカウント・受け付ける相手）で決済の処理を確かめる。環境変数からの本番の接続の判定は tests/stripe-live-runtime.test.ts。
 * 検証の途中でこのプロジェクトのデータを消すので、専用の demo- プロジェクトで実行する。
 *
 *   firebase emulators:start --only firestore --project demo-uranai
 *   （別ターミナル）FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 FIREBASE_PROJECT_ID=demo-uranai-live-ops DB_PROVIDER=firestore npm run e2e:stripe-live-ops
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
import { safeId } from "@/lib/firestore/admin";
import { jstYearMonth, shiftYearMonth } from "@/lib/time";
import { createSimulatedStripeRuntime, isStripeSessionId, StripeAccountMismatchError, STRIPE_SESSION_TTL_MS, type StripeRuntime } from "@/lib/payments/stripe-checkout";
import { confirmStripeCheckout, dismissStripeRefundReview, startStripeCheckout } from "@/lib/payments/stripe-confirm";
import { handleStripeWebhook } from "@/lib/payments/stripe-webhook";
import { runStripeWebhookRecovery } from "@/lib/payments/webhook-recovery";
import { defaultRecheckRecoveryDeps, runPendingRecheckRecovery } from "@/lib/payments/recheck-recovery";
import { runPaymentMonitor } from "@/lib/payments/payment-monitor";
import { paymentAlertId } from "@/lib/firestore/payment-alerts";

const SYSTEM = { userId: null, role: "SYSTEM" as const };
const step = (msg: string) => console.log(`  ✓ ${msg}`);
const ORIGIN = "http://localhost:3000";
const LIVE_PORT = 12151;
const TEST_PORT = 12152;
const LIVE_KEY = "sk_live_e2e_liveops_dummy";
const TEST_KEY = "sk_test_e2e_liveops_dummy";
const LIVE_WHSEC = "whsec_e2e_liveops_live_dummy";
const TEST_WHSEC = "whsec_e2e_liveops_test_dummy";
const ACCOUNT = "acct_fakeLiveOwner01";
const live = createFakeStripe({ port: LIVE_PORT, mode: "live", apiKey: LIVE_KEY, accountId: ACCOUNT });
const testFake = createFakeStripe({ port: TEST_PORT, mode: "test", apiKey: TEST_KEY });
const fake = live.fake;
const HOUR = 60 * 60 * 1000;

const signer = new Stripe("sk_test_signer");
let evN = 0;
type Ev = { type: string; object: Record<string, unknown>; id: string; livemode: boolean };
/** 通知を作り、模擬 Stripe にも保存する（events.retrieve で取得できる＝Webhook の復旧で使える） */
function ev(type: string, object: Record<string, unknown>, livemode = true): Ev {
  const e = { type, object, id: `evt_lops_${++evN}_${Date.now()}`, livemode };
  (livemode ? live : testFake).fake.events.set(e.id, { id: e.id, object: "event", type, livemode, created: Math.floor(Date.now() / 1000), data: { object } });
  return e;
}
async function deliver(rt: StripeRuntime, e: Ev, secret = rt.webhookSecret) {
  const payload = JSON.stringify({ id: e.id, object: "event", type: e.type, livemode: e.livemode, data: { object: e.object } });
  return handleStripeWebhook(payload, signer.webhooks.generateTestHeaderString({ payload, secret }), rt);
}
const outcomeOf = (r: { body: unknown }) => (r.body as { outcome?: string }).outcome;

type Pay = { checkoutId: string; sessionId: string; charge: string; pi: string; txId: string };
async function paidOnly(rt: StripeRuntime, storeCode: string, payOpts: Record<string, unknown> = {}): Promise<Pay> {
  const s = rt.mode === "live" ? live : testFake;
  const { checkoutId, accessToken } = await createCheckout(storeCode, "ZODIAC", { provider: "stripe", ttlMs: STRIPE_SESSION_TTL_MS });
  const r = await startStripeCheckout(accessToken, ORIGIN, rt);
  assert.equal(r.status, "redirect");
  const sessionId = (r as { url: string }).url.split("/").pop()!;
  const p = await s.ctl(`pay/${sessionId}`, { fee: 4, ...payOpts });
  return { checkoutId, sessionId, charge: p.charge!, pi: p.paymentIntent!, txId: `stripe_${p.paymentIntent!}` };
}
const completedEv = (p: Pay, livemode = true) => ev("checkout.session.completed", { id: p.sessionId, object: "checkout.session" }, livemode);
const refundEv = (p: Pay) => ev("charge.refunded", { id: p.charge, object: "charge" });
const disputeEv = (dpId: string, type = "charge.dispute.created") => ev(type, { id: dpId, object: "dispute" });

async function stateOf(p: Pay) {
  const txs = (await fsdb().collection(C.transactions).where("checkoutId", "==", p.checkoutId).get()).docs;
  const sessions = (await fsdb().collection(C.fortuneSessions).where("transactionId", "==", p.txId).get()).docs;
  const co = (await fsdb().collection(C.checkouts).doc(p.checkoutId).get()).data()!;
  assert.ok(txs.length <= 1, `決済記録が${txs.length}件`);
  assert.ok(sessions.length <= 1, `占い権利が${sessions.length}件`);
  return { t: txs[0]?.data() ?? null, fs: sessions[0]?.data() ?? null, co };
}
const accountCalls = () => fake.callLog.filter((c) => c === "GET /v1/account").length;
const countTx = async () => (await fsdb().collection(C.transactions).count().get()).data().count;
const newStore = (label: string) => createStore({ name: `${label} ${Date.now()}`, contactName: "", postalCode: "", address: "", phone: "", email: "" }, SYSTEM);

async function resetProject() {
  const host = process.env.FIRESTORE_EMULATOR_HOST!;
  const project = process.env.FIREBASE_PROJECT_ID!;
  assert.match(project, /^demo-/);
  let status = 0;
  for (let i = 0; i < 20 && status !== 200; i++) {
    if (i) await new Promise((ok) => setTimeout(ok, 500));
    status = (await fetch(`http://${host}/emulator/v1/projects/${project}/databases/(default)/documents`, { method: "DELETE" })).status;
  }
  assert.equal(status, 200, "Emulator のデータを消せませんでした");
}

async function main() {
  const host = process.env.FIRESTORE_EMULATOR_HOST ?? "";
  assert.match(host, /^(127\.0\.0\.1|localhost|\[::1\]):\d+$/, "FIRESTORE_EMULATOR_HOST（localhost の Emulator）が必要です");
  assert.match(process.env.FIREBASE_PROJECT_ID ?? "", /^demo-/, "FIREBASE_PROJECT_ID は demo- で始まる Emulator 用の ID にしてください");
  assert.ok(!process.env.VERCEL_ENV, "Vercel 上では実行しません");
  assert.equal(dataProvider(), "firestore");
  // 本番用・テスト用の Stripe のキーを環境変数に入れない（アプリの判定には一切渡さない）
  for (const k of ["STRIPE_SECRET_KEY", "STRIPE_LIVE_CHECKOUT", "STRIPE_LIVE_OPERATOR_TEST", "STRIPE_NEW_CHECKOUT", "STRIPE_TEST_CHECKOUT", "STRIPE_ACCOUNT_ID"]) delete process.env[k];
  await live.start();
  await testFake.start();
  const base = { apiBase: `http://127.0.0.1:${LIVE_PORT}`, secretKey: LIVE_KEY, webhookSecret: LIVE_WHSEC };
  const hook = { crashNext: false };
  // 本番の接続と同じ項目：アカウント（STRIPE_ACCOUNT_ID）・受け付ける相手（一般のお客さん）
  const rt = createSimulatedStripeRuntime("live", {
    ...base,
    accountId: ACCOUNT,
    liveAudience: "public",
    testHooks: {
      afterConfirmCommit: () => {
        if (hook.crashNext) {
          hook.crashNext = false;
          throw Object.assign(new Error("simulated stop right after the confirmation transaction"), { name: "SimulatedStop" });
        }
      },
    },
  });
  const test = createSimulatedStripeRuntime("test", { apiBase: `http://127.0.0.1:${TEST_PORT}`, secretKey: TEST_KEY, webhookSecret: TEST_WHSEC });
  const ym = jstYearMonth(new Date());
  console.log(`Stripe live operations E2E (emulator ${host} / ${process.env.FIREBASE_PROJECT_ID}, fake Stripe live :${LIVE_PORT} / test :${TEST_PORT})`);
  await resetProject();

  // ================= 1. キーのアカウントの確認（別のアカウントのキーなら受け付けない） =================
  {
    const store = await newStore("本番運用検証店舗1");
    const wrong = createSimulatedStripeRuntime("live", { ...base, accountId: "acct_someoneElse999", liveAudience: "public" });
    const { accessToken, checkoutId } = await createCheckout(store.storeCode, "ZODIAC", { provider: "stripe", ttlMs: STRIPE_SESSION_TTL_MS });
    const created0 = fake.createCalls;
    await assert.rejects(() => startStripeCheckout(accessToken, ORIGIN, wrong), StripeAccountMismatchError);
    assert.equal(fake.createCalls, created0, "別のアカウントのキーで決済画面を作りました");
    // 正しいアカウントの接続で決済画面を作り、支払う
    const r = await startStripeCheckout(accessToken, ORIGIN, rt);
    assert.equal(r.status, "redirect");
    const sessionId = (r as { url: string }).url.split("/").pop()!;
    assert.ok(isStripeSessionId(sessionId, "live"));
    const paid = await live.ctl(`pay/${sessionId}`, { fee: 4 });
    const p: Pay = { checkoutId, sessionId, charge: paid.charge!, pi: paid.paymentIntent!, txId: `stripe_${paid.paymentIntent!}` };
    // 別のアカウントの接続：確定・Webhook を受け付けない（記録を作らない。Webhook は 503 で処理済みにしない）
    await assert.rejects(() => confirmStripeCheckout(sessionId, wrong), StripeAccountMismatchError);
    const e = completedEv(p);
    const w = await deliver(wrong, e);
    assert.equal(w.status, 503);
    assert.equal((await fsdb().collection(C.webhookEvents).doc(safeId("stripe", e.id)).get()).exists, false, "アカウントを確認できない通知を記録しました");
    assert.equal(await countTx(), 0);
    const alerts = (await fsdb().collection(C.paymentAlerts).where("kind", "==", "stripe_account_mismatch").get()).docs;
    assert.equal(alerts.length, 1, "アカウントの不一致が決済監視に記録されていません");
    assert.equal(alerts[0].get("mode"), "live");
    // 正しいアカウント：同じ通知の再送で確定（アカウントの確認は接続ごとに1回だけ）
    const calls0 = accountCalls();
    assert.equal(outcomeOf(await deliver(rt, e)), "confirmed");
    assert.equal(outcomeOf(await deliver(rt, completedEv(p))), "duplicate");
    assert.ok(accountCalls() - calls0 <= 1, "アカウントの確認を何度も呼びました");
    const s = await stateOf(p);
    assert.deepEqual([s.t!.livemode, s.t!.paymentStatus, s.t!.recheckState, s.fs!.status], [true, "SUCCEEDED", "DONE", "PAID"]);
    assert.deepEqual(await monthTotals(ym, store.id), { count: 1, gross: 100, storeShare: 30, operatorShare: 70, fee: 4, feeEstimated: 0 });
    step("1. キーのアカウントの確認：別のアカウントのキーでは決済画面・確定・Webhook を受け付けない（503・記録なし・決済監視に記録）。正しいアカウントで確定・売上1件");
  }

  // ================= 2. 本番・テストの混在、署名の不一致、Webhook の再送 =================
  {
    const store = await newStore("本番運用検証店舗2");
    const p = await paidOnly(rt, store.storeCode);
    const e = completedEv(p);
    // 署名の値が違う（テストの送信先の値・偽物）
    assert.equal((await deliver(rt, e, TEST_WHSEC)).status, 400);
    assert.equal((await deliver(rt, e, "whsec_forged_value")).status, 400);
    // 本番の接続にテストの通知（livemode=false）・テストの接続に本番の通知
    assert.equal((await deliver(rt, completedEv(p, false))).status, 400);
    assert.equal((await deliver(test, e, TEST_WHSEC)).status, 400);
    // テストの Session の ID を本番の接続で確定しない
    const tq = await paidOnly(test, store.storeCode);
    assert.deepEqual(await confirmStripeCheckout(tq.sessionId, rt), { status: "rejected", reason: "invalid_session_id" });
    assert.equal(await countTx(), 1, "混在した通知・Session で決済記録が作られました（前の場面の1件だけのはず）");
    // 正しい通知：同じ通知の再送・別の ID の同じ決済の通知は1回だけ反映
    assert.equal(outcomeOf(await deliver(rt, e)), "confirmed");
    const again = await deliver(rt, e);
    assert.deepEqual([again.status, (again.body as { duplicate?: boolean }).duplicate], [200, true]);
    const results = await Promise.all([deliver(rt, completedEv(p)), deliver(rt, completedEv(p)), deliver(rt, e)]);
    for (const r of results) assert.ok(r.status === 200 || r.status === 409, `再送の Webhook：${r.status}`);
    assert.deepEqual(await monthTotals(ym, store.id), { count: 1, gross: 100, storeShare: 30, operatorShare: 70, fee: 4, feeEstimated: 0 }, "再送で売上が二重になりました");
    const signatureAlert = (await fsdb().collection(C.paymentAlerts).where("kind", "==", "webhook_signature_invalid").get()).size;
    assert.ok(signatureAlert >= 1, "署名の不一致が決済監視に記録されていません");
    step("2. 署名の不一致（テストの値・偽物）は 400。本番⇔テストの通知・Session の混在は拒否。同じ通知の再送・同時の再送でも決済記録・売上は1件");
  }

  // ================= 3. 返金・チャージバック（敗訴） =================
  {
    const store = await newStore("本番運用検証店舗3");
    const pr = await paidOnly(rt, store.storeCode);
    assert.equal(outcomeOf(await deliver(rt, completedEv(pr))), "confirmed");
    live.addRefund(pr.charge);
    const re = refundEv(pr);
    await Promise.all([deliver(rt, re), deliver(rt, re), deliver(rt, refundEv(pr))]);
    let x = await stateOf(pr);
    assert.deepEqual([x.t!.paymentStatus, x.t!.amountRefunded, x.fs!.status, x.fs!.suspendedByRefund, x.co.status], ["REFUNDED", 100, "EXPIRED", true, "REFUNDED"]);
    const pc = await paidOnly(rt, store.storeCode);
    assert.equal(outcomeOf(await deliver(rt, completedEv(pc))), "confirmed");
    const dp = live.addDispute(pc.charge);
    assert.equal(outcomeOf(await deliver(rt, disputeEv(dp))), "dispute_open");
    await live.ctl(`dispute-status/${dp}`, { status: "lost" });
    assert.equal(outcomeOf(await deliver(rt, disputeEv(dp, "charge.dispute.closed"))), "dispute_lost");
    x = await stateOf(pc);
    assert.deepEqual([x.t!.paymentStatus, x.t!.disputeStatus, x.fs!.status, x.fs!.suspendedByDispute, x.co.status, x.co.refundReason], ["CHARGEBACK", "lost", "EXPIRED", true, "REFUNDED", "chargeback"]);
    assert.deepEqual(await monthTotals(ym, store.id), { count: 0, gross: 0, storeShare: 0, operatorShare: 0, fee: 8, feeEstimated: 0 }, "返金・チャージバックの決済が売上に残りました（手数料は決済ごとに残る）");
    // 一部返金（返金の確認が必要）→ 運営が確認を終える：本番の決済の監査ログは stripe.*（テストの決済は stripe_test.*）
    const pp = await paidOnly(rt, store.storeCode);
    assert.equal(outcomeOf(await deliver(rt, completedEv(pp))), "confirmed");
    live.addRefund(pp.charge, { amount: 30 });
    assert.equal(outcomeOf(await deliver(rt, refundEv(pp))), "partial");
    assert.equal((await stateOf(pp)).t!.refundNeedsReview, true);
    assert.equal(await dismissStripeRefundReview(pp.txId, { userId: "op-live-ops", role: "OPERATOR" }), true);
    const au = (await fsdb().collection(C.auditLogs).where("targetId", "==", pp.txId).get()).docs.map((d) => d.get("action"));
    assert.deepEqual(au, ["stripe.refund_review_dismissed"], "本番の決済の監査ログの名前が stripe.* ではありません");
    step("3. 本番の返金（同時の通知でも1回）・チャージバックの敗訴：REFUNDED／CHARGEBACK、権利の停止、注文 REFUNDED、売上から除く（手数料は残る）。本番の監査ログは stripe.*");
  }

  // ================= 4. 異議申し立ての対応中：決済済みのまま・要確認・精算の保留 → 勝訴で解除 =================
  {
    const store = await newStore("本番運用検証店舗4");
    const prev = shiftYearMonth(ym, -1);
    const lastMonth = Math.floor(new Date(`${prev}-15T12:00:00+09:00`).getTime() / 1000);
    const p = await paidOnly(rt, store.storeCode, { created: lastMonth });
    assert.equal(outcomeOf(await deliver(rt, completedEv(p))), "confirmed");
    const dp = live.addDispute(p.charge);
    assert.equal(outcomeOf(await deliver(rt, disputeEv(dp))), "dispute_open");
    let x = await stateOf(p);
    assert.deepEqual([x.t!.paymentStatus, x.t!.disputeStatus, x.t!.disputeNeedsReview, x.fs!.status, x.co.status], ["SUCCEEDED", "open", true, "PAID", "SUCCEEDED"]);
    await generateSettlements(prev, SYSTEM);
    let st = (await listSettlements({ yearMonth: prev, storeId: store.id }))[0].s;
    assert.deepEqual([st.transactionCount, st.grossSales, st.storeShare, st.heldShare], [1, 100, 0, 30], "異議申し立ての対応中の取り分が保留されていません");
    await live.ctl(`dispute-status/${dp}`, { status: "won" });
    assert.equal(outcomeOf(await deliver(rt, disputeEv(dp, "charge.dispute.closed"))), "dispute_won");
    x = await stateOf(p);
    assert.deepEqual([x.t!.paymentStatus, x.t!.disputeStatus, x.t!.disputeNeedsReview, x.fs!.status], ["SUCCEEDED", "won", false, "PAID"]);
    await generateSettlements(prev, SYSTEM);
    st = (await listSettlements({ yearMonth: prev, storeId: store.id }))[0].s;
    assert.deepEqual([st.storeShare, st.heldShare], [30, 0], "勝訴の後に保留が解除されていません");
    step("4. 異議申し立ての対応中：決済は SUCCEEDED のまま・disputeNeedsReview=true・権利 PAID。本番の精算は取り分30円を保留 → 勝訴で保留を解除");
  }

  // ================= 5. 先着の異議申し立ての通知 → PENDING → 決済監視 → 自動の回収 =================
  {
    const store = await newStore("本番運用検証店舗5");
    const p = await paidOnly(rt, store.storeCode);
    const dp = live.addDispute(p.charge); // 決済の直後に異議申し立て（確定の通知より先に届く）
    hook.crashNext = true; // 先着の通知からの確定の直後に止まる（作成の後の再確認の前）
    const first = disputeEv(dp);
    assert.equal((await deliver(rt, first)).status, 500);
    let x = await stateOf(p);
    assert.equal(x.t!.recheckState, "PENDING", "先着の通知から作った決済記録が PENDING になっていません");
    assert.equal(x.t!.disputeStatus, "open", "確定の前からある異議申し立ては、作成の時点で記録する");
    await fsdb().collection(C.transactions).doc(p.txId).update({ createdAt: new Date(Date.now() - 2 * HOUR) });
    const mon = await runPaymentMonitor({ rt });
    assert.ok(mon.started);
    const a = (await fsdb().collection(C.paymentAlerts).doc(paymentAlertId("recheck_pending", p.txId)).get()).data();
    assert.deepEqual([a?.kind, a?.mode, a?.recheckStatus], ["recheck_pending", "live", "pending"], "本番の PENDING が決済監視に記録されていません");
    const s = await runPendingRecheckRecovery(rt, await defaultRecheckRecoveryDeps(rt), { isSessionId: (v) => isStripeSessionId(v, "live") });
    assert.deepEqual([s.attempted, s.results.done], [1, 1], JSON.stringify(s));
    x = await stateOf(p);
    assert.deepEqual([x.t!.recheckState, x.t!.paymentStatus, x.t!.disputeStatus, x.fs!.status], ["DONE", "SUCCEEDED", "open", "PAID"]);
    // 先着の通知の再送・確定の通知：二重にしない
    assert.equal((await deliver(rt, first)).status, 200);
    assert.equal(outcomeOf(await deliver(rt, completedEv(p))), "duplicate");
    assert.equal((await monthTotals(ym, store.id)).count, 1);
    step("5. 先着の異議申し立ての通知：確定の直後に止まっても PENDING（対応中を記録）→ 決済監視（本番・pending）→ 自動の回収で DONE。再送で二重にしない");
  }

  // ================= 6. 以前の形の記録（recheckState なし・異議申し立てが未反映）：回収の対象外。後の通知で反映 =================
  {
    const store = await newStore("本番運用検証店舗6");
    const p = await paidOnly(rt, store.storeCode);
    assert.equal(outcomeOf(await deliver(rt, completedEv(p))), "confirmed");
    const { FieldValue } = await import("firebase-admin/firestore");
    const ref = fsdb().collection(C.transactions).doc(p.txId);
    await ref.update({ recheckState: FieldValue.delete(), recheckAttempts: FieldValue.delete(), recheckDoneAt: FieldValue.delete(), createdAt: new Date(Date.now() - 5 * 24 * HOUR) });
    const dp = live.addDispute(p.charge); // Stripe では対応中。通知はこの環境で反映されなかった（以前の先着の通知の扱い）
    const s = await runPendingRecheckRecovery(rt, await defaultRecheckRecoveryDeps(rt), { isSessionId: (v) => isStripeSessionId(v, "live") });
    assert.equal(s.scanned, 0, "以前の形の記録を回収の対象として読みました");
    let x = await stateOf(p);
    assert.deepEqual([x.t!.recheckState, x.t!.disputeStatus ?? null, x.t!.paymentStatus, x.fs!.status], [undefined, null, "SUCCEEDED", "PAID"], "以前の形の記録が変わりました");
    // その後の異議申し立ての通知（更新・終了）で反映される（決済記録はもうある）
    assert.equal(outcomeOf(await deliver(rt, disputeEv(dp, "charge.dispute.updated"))), "dispute_open");
    x = await stateOf(p);
    assert.deepEqual([x.t!.disputeStatus, x.t!.disputeNeedsReview, x.t!.paymentStatus], ["open", true, "SUCCEEDED"]);
    await live.ctl(`dispute-status/${dp}`, { status: "lost" });
    assert.equal(outcomeOf(await deliver(rt, disputeEv(dp, "charge.dispute.closed"))), "dispute_lost");
    x = await stateOf(p);
    assert.deepEqual([x.t!.paymentStatus, x.fs!.status, x.fs!.suspendedByDispute, x.co.status], ["CHARGEBACK", "EXPIRED", true, "REFUNDED"]);
    assert.equal(x.t!.recheckState, undefined, "以前の形の記録に recheckState を書き込みました");
    step("6. 以前の形の記録（recheckState なし・異議申し立て未反映）：自動の回収は読まず、記録を変えない。後の通知で対応中 → 敗訴で CHARGEBACK・権利停止");
  }

  // ================= 7. Webhook の復旧（自動）を本番の接続で =================
  {
    const store = await newStore("本番運用検証店舗7");
    const p = await paidOnly(rt, store.storeCode);
    assert.equal(outcomeOf(await deliver(rt, completedEv(p))), "confirmed");
    live.addRefund(p.charge);
    const re = refundEv(p);
    fake.failCalls.push({ path: /^\/v1\/charges\//, method: "GET", skip: 0, count: 1 });
    fake.failCalls.push({ path: /^\/v1\/refunds$/, method: "GET", skip: 0, count: 1 });
    const r1 = await deliver(rt, re);
    assert.equal(r1.status, 500, `失敗させた返金の通知が ${r1.status}`);
    fake.failCalls.length = 0;
    await fsdb().collection(C.webhookEvents).doc(safeId("stripe", re.id)).update({ lastAttemptAt: new Date(Date.now() - HOUR) });
    const calls0 = accountCalls();
    const sum = await runStripeWebhookRecovery(rt, { source: "cron" });
    assert.ok(sum.results.recovered >= 1, JSON.stringify(sum));
    assert.equal(accountCalls(), calls0, "復旧でアカウントの確認を呼び直しました（同じ接続では1回だけ）");
    const x = await stateOf(p);
    assert.deepEqual([x.t!.paymentStatus, x.fs!.status], ["REFUNDED", "EXPIRED"]);
    assert.equal((await fsdb().collection(C.webhookEvents).doc(safeId("stripe", re.id)).get()).get("state"), "PROCESSED");
    step("7. 本番の接続の Webhook の復旧：失敗した返金の通知を Stripe から取り直して処理済み（REFUNDED・権利停止）");
  }

  // ================= 8. 決済監視の点検を本番の接続で（Stripe の照合を含む） =================
  {
    const mon = await runPaymentMonitor({ rt });
    assert.ok(mon.started);
    assert.equal(mon.report.unchecked.filter((u) => !/上限/.test(u)).length, 0, `本番の接続の点検で確認できない項目：${mon.report.unchecked.join("、")}`);
    step(`8. 本番の接続で決済監視の点検（結果：${mon.report.result}・確認できなかった項目なし）`);
  }

  console.log("\nSTRIPE LIVE OPERATIONS E2E PASSED");
}

main()
  .then(async () => {
    await live.stop();
    await testFake.stop();
    process.exit(0);
  })
  .catch(async (e) => {
    console.error("\nSTRIPE LIVE OPERATIONS E2E FAILED:", e);
    await live.stop().catch(() => {});
    await testFake.stop().catch(() => {});
    process.exit(1);
  });
