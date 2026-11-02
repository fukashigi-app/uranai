/**
 * 決済記録の再確認が終わっていない決済記録（recheckState=PENDING）の自動の回収・手動の再確認の総合 E2E 検証。
 *  - 自動の回収で DONE になる。回収の途中・前の返金・チャージバック敗訴を反映し、占い権利を止める（戻さない）
 *  - 自動の回収・Webhook の再送・手動の再確認が同時でも、二重に反映しない（売上・手数料・返金・権利）
 *  - Stripe API の例外でも試行の回数は残り、PENDING は監視の対象のまま。6回の上限・20時間の間隔・10件・60秒・続きの位置の一周
 *  - 決済記録が無い・Session と PaymentIntent が一致しない記録は、新しい決済記録を作らずに拒否する
 *  - 定期処理の順番（メンテナンス → Webhook の復旧 → PENDING の回収）。回収の失敗はメンテナンスの結果を変えない
 *  - 手動の再確認の実行中の印の期限の境界と、長い処理の間に期限が切れたときの安全性
 *  - Stripe API を Firestore のトランザクションの中で呼ばない。本番とテスト（Sandbox）の決済を混同しない
 * 本物の Stripe・本番の Firebase には一切接続しない（localhost の模擬 Stripe と Firestore Emulator の demo- プロジェクトだけ。キーは形だけの偽物）。
 * 検証の途中でこのプロジェクトのデータを消すので、専用の demo- プロジェクトで実行する。
 *
 *   firebase emulators:start --only firestore --project demo-uranai
 *   （別ターミナル）FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 FIREBASE_PROJECT_ID=demo-uranai-recheck-recovery DB_PROVIDER=firestore \
 *       SESSION_SECRET=... DATA_ENCRYPTION_KEY=... npm run e2e:stripe-recheck-recovery
 */
import "dotenv/config";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import Stripe from "stripe";
import { createFakeStripe } from "./lib/fake-stripe";
import { C, fsdb } from "@/lib/firestore/admin";
import { dataProvider } from "@/lib/data-provider";
import { createStore } from "@/lib/services/stores";
import { monthTotals } from "@/lib/services/reports";
import { createCheckout } from "@/lib/firestore/payments";
import { jstYearMonth } from "@/lib/time";
import { createSimulatedStripeRuntime, isStripeSessionId, STRIPE_SESSION_TTL_MS, stripeRuntime, type StripeRuntime } from "@/lib/payments/stripe-checkout";
import { confirmStripeCheckout, startStripeCheckout } from "@/lib/payments/stripe-confirm";
import { handleStripeWebhook } from "@/lib/payments/stripe-webhook";
import { runPaymentMonitor } from "@/lib/payments/payment-monitor";
import { paymentAlertId } from "@/lib/firestore/payment-alerts";
import { defaultManualRecheckDeps, defaultRecheckRecoveryDeps, manualRecheckTransaction, runPendingRecheckRecovery, type ManualRecheckDeps, type RecheckRecoveryDeps } from "@/lib/payments/recheck-recovery";
import {
  RECHECK_MANUAL_LEASE_MS,
  RECHECK_RECOVERY_BACKOFF_MS,
  RECHECK_RECOVERY_DEADLINE_MS,
  RECHECK_RECOVERY_MAX_ATTEMPTS,
  RECHECK_RECOVERY_MAX_ITEMS,
} from "@/lib/payments/recheck-recovery-rules";

const SYSTEM = { userId: null, role: "SYSTEM" as const };
const OP = { userId: "op-e2e-recheck", role: "OPERATOR" as const };
const step = (msg: string) => console.log(`  ✓ ${msg}`);
const ORIGIN = "http://localhost:3000";
const LIVE_PORT = 12141;
const TEST_PORT = 12142;
const LIVE_KEY = "sk_live_e2e_recovery_dummy";
const TEST_KEY = "sk_test_e2e_recovery_dummy";
const TEST_WHSEC = "whsec_e2e_recovery_test_dummy";
const live = createFakeStripe({ port: LIVE_PORT, mode: "live", apiKey: LIVE_KEY });
const testFake = createFakeStripe({ port: TEST_PORT, mode: "test", apiKey: TEST_KEY });
const fake = live.fake;
const HOUR = 60 * 60 * 1000;

// ---------- Stripe API を Firestore のトランザクションの中で呼んでいないかの確認（順番に動く場面だけで確認する） ----------
let txDepth = 0;
let watchTx = false;
const txViolations: string[] = [];
function instrumentTransactions() {
  const proto = Object.getPrototypeOf(fsdb()) as { runTransaction: (fn: (t: unknown) => Promise<unknown>, o?: unknown) => Promise<unknown> };
  const orig = proto.runTransaction;
  proto.runTransaction = function (this: unknown, fn: (t: unknown) => Promise<unknown>, o?: unknown) {
    return orig.call(
      this,
      async (t: unknown) => {
        txDepth++;
        try {
          return await fn(t);
        } finally {
          txDepth--;
        }
      },
      o,
    );
  };
  for (const s of [live, testFake]) s.server.on("request", (req) => void (watchTx && txDepth > 0 && txViolations.push(`${req.method} ${String(req.url).split("?")[0]}`)));
}
/** PENDING の決済記録の一覧の読み込みを失敗させる（定期処理の中の回収の失敗の再現。呼び出し元の関数の名前で絞る） */
let failPendingQuery = false;
function instrumentPendingQuery() {
  const q = fsdb().collection(C.transactions).where("recheckState", "==", "PENDING");
  const proto = Object.getPrototypeOf(q) as { get: (...a: unknown[]) => Promise<unknown> };
  const orig = proto.get;
  proto.get = function (this: unknown, ...a: unknown[]) {
    if (failPendingQuery && /listPendingRecheckPage/.test(new Error().stack ?? "")) return Promise.reject(Object.assign(new Error("simulated firestore failure"), { name: "SimulatedFirestoreError" }));
    return orig.apply(this, a);
  };
}

// ---------- Webhook・決済 ----------
const signer = new Stripe("sk_test_signer");
let evN = 0;
type Ev = { type: string; object: Record<string, unknown>; id: string };
const ev = (type: string, object: Record<string, unknown>): Ev => ({ type, object, id: `evt_rrc_${++evN}_${Date.now()}` });
async function deliver(rt: StripeRuntime, e: Ev) {
  const payload = JSON.stringify({ id: e.id, object: "event", type: e.type, livemode: rt.mode === "live", data: { object: e.object } });
  const sig = signer.webhooks.generateTestHeaderString({ payload, secret: rt.webhookSecret });
  return handleStripeWebhook(payload, sig, rt);
}
type Pay = { checkoutId: string; sessionId: string; charge: string; pi: string; txId: string; storeId: string; completed: Ev };
type Fake = typeof live;
async function paidOnly(rt: StripeRuntime, s: Fake, storeCode: string): Promise<Omit<Pay, "storeId" | "completed">> {
  const { checkoutId, accessToken } = await createCheckout(storeCode, "ZODIAC", { provider: "stripe", ttlMs: STRIPE_SESSION_TTL_MS });
  const r = await startStripeCheckout(accessToken, ORIGIN, rt);
  assert.equal(r.status, "redirect");
  const sessionId = (r as { url: string }).url.split("/").pop()!;
  const p = await s.ctl(`pay/${sessionId}`, { fee: 4 });
  return { checkoutId, sessionId, charge: p.charge!, pi: p.paymentIntent!, txId: `stripe_${p.paymentIntent!}` };
}
/** 決済確定の後の再確認だけが失敗した決済記録（PENDING）。作成から2時間たったことにする（自動の回収の対象） */
async function makePending(rt: StripeRuntime, s: Fake, store: { id: string; storeCode: string }, ageMs = 2 * HOUR): Promise<Pay> {
  const p = await paidOnly(rt, s, store.storeCode);
  s.fake.failCalls.push({ path: /^\/v1\/refunds$/, method: "GET", skip: 1, count: 1 }); // 事前の読み取りは通し、再確認の読み取りだけ失敗
  const completed = ev("checkout.session.completed", { id: p.sessionId, object: "checkout.session" });
  const r = await deliver(rt, completed);
  assert.equal(r.status, 500, "（前提）再確認の失敗で Webhook が 500 を返していません");
  const ref = fsdb().collection(C.transactions).doc(p.txId);
  assert.equal((await ref.get()).get("recheckState"), "PENDING", "（前提）PENDING になっていません");
  await ref.update({ createdAt: new Date(Date.now() - ageMs) });
  return { ...p, storeId: store.id, completed };
}
const refundEv = (p: Pay) => ev("charge.refunded", { id: p.charge, object: "charge" });

async function stateOf(p: Pay) {
  const txs = (await fsdb().collection(C.transactions).where("checkoutId", "==", p.checkoutId).get()).docs;
  const sessions = (await fsdb().collection(C.fortuneSessions).where("transactionId", "==", p.txId).get()).docs;
  const co = (await fsdb().collection(C.checkouts).doc(p.checkoutId).get()).data()!;
  assert.ok(txs.length <= 1, `決済記録が${txs.length}件`);
  assert.ok(sessions.length <= 1, `占い権利が${sessions.length}件`);
  return { t: txs[0]?.data() ?? null, fs: sessions[0]?.data() ?? null, co };
}
const txData = async (id: string) => (await fsdb().collection(C.transactions).doc(id).get()).data() ?? null;
const countTx = async () => (await fsdb().collection(C.transactions).count().get()).data().count;
const countFs = async () => (await fsdb().collection(C.fortuneSessions).count().get()).data().count;
const sessionGets = (s: Fake, sessionId: string) => s.fake.callLog.filter((c) => c === `GET /v1/checkout/sessions/${sessionId}`).length;
const refundCount = (t: Record<string, unknown> | null) => String(t?.refundKey ?? "").split(":")[4]?.split(",").filter(Boolean).length ?? 0;
async function auditsFor(txId: string) {
  return (await fsdb().collection(C.auditLogs).where("targetId", "==", txId).get()).docs.map((d) => d.data()).filter((d) => d.action === "transaction.recheck");
}
async function alertOf(txId: string) {
  const d = await fsdb().collection(C.paymentAlerts).doc(paymentAlertId("recheck_pending", txId)).get();
  return d.exists ? d.data()! : null;
}

/** この検証用の demo- プロジェクトのデータを消す（自動の回収はプロジェクトの全体の PENDING を読むため、場面ごとに分ける） */
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
const newStore = async (label: string) => createStore({ name: `${label} ${Date.now()}`, contactName: "", postalCode: "", address: "", phone: "", email: "" }, SYSTEM);
/** 自動の回収の対象の形の決済記録を直接作る（決済は存在しない。間隔待ちなどで対象外にするための記録） */
async function seedPending(id: string, over: Record<string, unknown> = {}) {
  await fsdb()
    .collection(C.transactions)
    .doc(id)
    .set({
      paymentProvider: "stripe",
      recheckState: "PENDING",
      livemode: true,
      createdAt: new Date(Date.now() - 2 * HOUR),
      stripeCheckoutSessionId: `cs_live_seed${id.replace(/[^A-Za-z0-9]/g, "")}`,
      stripePaymentIntentId: `pi_seed${id.replace(/[^A-Za-z0-9]/g, "")}`,
      paymentStatus: "SUCCEEDED",
      recheckAttempts: 1,
      recheckRecoveryAttempts: 1,
      recheckRecoveryLastAt: new Date(),
      recheckRecoveryLastResult: "error",
      ...over,
    });
}

async function main() {
  const host = process.env.FIRESTORE_EMULATOR_HOST ?? "";
  assert.match(host, /^(127\.0\.0\.1|localhost|\[::1\]):\d+$/, "FIRESTORE_EMULATOR_HOST（localhost の Emulator）が必要です");
  assert.match(process.env.FIREBASE_PROJECT_ID ?? "", /^demo-/, "FIREBASE_PROJECT_ID は demo- で始まる Emulator 用の ID にしてください");
  assert.ok(!process.env.VERCEL_ENV, "Vercel 上では実行しません");
  assert.equal(dataProvider(), "firestore");
  for (const k of ["STRIPE_SECRET_KEY", "STRIPE_LIVE_CHECKOUT", "STRIPE_LIVE_OPERATOR_TEST"]) delete process.env[k];
  // 定期処理（/api/cron/maintenance）の Stripe との接続は環境変数から作る：模擬 Stripe（テストモード・localhost）だけ
  Object.assign(process.env, { STRIPE_TEST_CHECKOUT: "on", STRIPE_SECRET_KEY: TEST_KEY, STRIPE_WEBHOOK_SECRET: TEST_WHSEC, STRIPE_API_BASE: `http://127.0.0.1:${TEST_PORT}` });
  if (!process.env.CRON_SECRET) process.env.CRON_SECRET = randomBytes(24).toString("hex");
  await live.start();
  await testFake.start();
  instrumentTransactions();
  instrumentPendingQuery();
  // 検知の仕組みの確認（対照）：トランザクションの中で模擬 Stripe を呼ぶと検知される
  watchTx = true;
  await fsdb().runTransaction(async () => void (await fetch(`http://127.0.0.1:${LIVE_PORT}/v1/charges/ch_probe`, { headers: { authorization: `Bearer ${LIVE_KEY}` } })));
  watchTx = false;
  assert.deepEqual(txViolations, ["GET /v1/charges/ch_probe"], "（前提）トランザクションの中の Stripe API の呼び出しを検知できません");
  txViolations.length = 0;
  const rt = createSimulatedStripeRuntime("live", { apiBase: `http://127.0.0.1:${LIVE_PORT}`, secretKey: LIVE_KEY, webhookSecret: "whsec_e2e_recovery_live_dummy" });
  const isSession = (v: unknown) => isStripeSessionId(v, "live");
  const deps = await defaultRecheckRecoveryDeps(rt);
  const mdeps = await defaultManualRecheckDeps(rt);
  const recover = (opts: Partial<Parameters<typeof runPendingRecheckRecovery>[2]> = {}, d: RecheckRecoveryDeps = deps) => runPendingRecheckRecovery(rt, d, { isSessionId: isSession, ...opts });
  const runDoc = async () => (await fsdb().collection(C.system).doc("recheckRecovery").get()).data() ?? null;
  const ym = jstYearMonth(new Date());
  console.log(`Stripe recheck recovery E2E (emulator ${host} / ${process.env.FIREBASE_PROJECT_ID}, fake Stripe live :${LIVE_PORT} / test :${TEST_PORT})`);

  // ================= 1. PENDING の決済を自動の回収で DONE にする =================
  await resetProject();
  {
    const store = await newStore("回収検証店舗1");
    const p = await makePending(rt, live, store);
    const before = await stateOf(p);
    assert.deepEqual([before.t!.recheckState, before.t!.recheckAttempts, before.fs!.status], ["PENDING", 1, "PAID"]);
    watchTx = true;
    const s = await recover();
    watchTx = false;
    assert.deepEqual([s.status, s.scanned, s.attempted, s.results.done], ["completed", 1, 1, 1], JSON.stringify(s));
    const after = await stateOf(p);
    assert.equal(after.t!.recheckState, "DONE");
    assert.equal(after.t!.recheckAttempts, 2, "確定の処理の中の再確認の回数（recheckAttempts）が1回だけ増えていません");
    assert.deepEqual([after.t!.recheckRecoveryAttempts, after.t!.recheckRecoveryLastResult, after.t!.recheckRecoveryLastError], [1, "done", null]);
    assert.deepEqual([after.t!.paymentStatus, after.fs!.status, after.co.status], ["SUCCEEDED", "PAID", "SUCCEEDED"]);
    const t = await monthTotals(ym, store.id);
    assert.deepEqual([t.count, t.gross, t.fee], [1, 100, 4], "売上が1件・100円・手数料4円ではありません");
    const run = (await runDoc())!;
    assert.deepEqual([run.status, run.counts.scanned, run.counts.attempted, run.counts.done, run.nextCursor], ["completed", 1, 1, 1, null]);
    assert.equal(await countTx(), 1);
    step("1. PENDING の決済を自動の回収で DONE（試行1回・結果 done・権利 PAID のまま・売上は1件100円・実行の記録あり）");
  }

  // ================= 2・3・4. 返金・チャージバック敗訴の反映と、反映済みの決済の再確認で復活しない =================
  await resetProject();
  {
    const store = await newStore("回収検証店舗2");
    // 2a. 回収の途中（事前の読み取りの直後）に返金が発生
    const pa = await makePending(rt, live, store);
    fake.afterRefundListOnce.set(pa.charge, () => void live.addRefund(pa.charge));
    // 2b. 回収の前に返金済み（返金の通知は届かなかった）
    const pb = await makePending(rt, live, store);
    live.addRefund(pb.charge);
    // 3. 回収の前にチャージバックで敗訴（通知は届かなかった）
    const pc = await makePending(rt, live, store);
    live.addDispute(pc.charge, { status: "lost" });
    watchTx = true;
    const s = await recover();
    watchTx = false;
    assert.deepEqual([s.attempted, s.results.done], [3, 3], JSON.stringify(s));
    for (const p of [pa, pb]) {
      const x = await stateOf(p);
      assert.deepEqual([x.t!.recheckState, x.t!.paymentStatus, x.t!.refundStatus, x.t!.amountRefunded, refundCount(x.t)], ["DONE", "REFUNDED", "succeeded", 100, 1]);
      assert.deepEqual([x.fs!.status, x.fs!.suspendedByRefund, x.co.status], ["EXPIRED", true, "REFUNDED"]);
    }
    step("2. 再確認の途中・前に発生した返金を反映（REFUNDED・返金1件100円）し、占い権利を停止・注文 REFUNDED");
    const xc = await stateOf(pc);
    assert.deepEqual([xc.t!.recheckState, xc.t!.paymentStatus, xc.t!.disputeStatus], ["DONE", "CHARGEBACK", "lost"]);
    assert.deepEqual([xc.fs!.status, xc.fs!.suspendedByDispute, xc.co.status, xc.co.refundReason], ["EXPIRED", true, "REFUNDED", "chargeback"]);
    step("3. チャージバックの敗訴を反映（CHARGEBACK・lost）し、占い権利を停止・注文 REFUNDED（chargeback）");
    let t = await monthTotals(ym, store.id);
    assert.equal(t.count, 0, "返金・チャージバックの決済が売上に数えられました");
    const feeBefore = t.fee;

    // 4. 反映済みの決済記録を PENDING に戻して（取りこぼしの再現）、自動の回収・手動の再確認をもう一度
    const snap = async () => Promise.all([pa, pb, pc].map(async (p) => JSON.stringify((({ t: tt, fs, co }) => [tt!.paymentStatus, tt!.refundKey, tt!.disputeKey, tt!.amountRefunded, fs!.status, fs!.usedAt ?? null, co.status, co.refundReason])(await stateOf(p)))));
    const base = await snap();
    for (const p of [pa, pb, pc]) await fsdb().collection(C.transactions).doc(p.txId).update({ recheckState: "PENDING", recheckRecoveryLastAt: new Date(Date.now() - RECHECK_RECOVERY_BACKOFF_MS - 1000) });
    watchTx = true;
    const s2 = await recover();
    watchTx = false;
    assert.deepEqual([s2.attempted, s2.results.done], [3, 3], JSON.stringify(s2));
    assert.deepEqual(await snap(), base, "再確認で返金済み・チャージバック済みの注文・権利が変わりました");
    for (const p of [pa, pc]) await fsdb().collection(C.transactions).doc(p.txId).update({ recheckState: "PENDING" });
    for (const p of [pa, pc]) {
      watchTx = true;
      const m = await manualRecheckTransaction(p.txId, OP, mdeps);
      watchTx = false;
      assert.deepEqual([m.started, m.started && m.result], [true, "done"]);
    }
    assert.deepEqual(await snap(), base, "手動の再確認で返金済み・チャージバック済みの注文・権利が変わりました");
    for (const p of [pa, pb, pc]) {
      const x = await stateOf(p);
      assert.equal(x.fs!.restoredAt, undefined, "占い権利が戻されました");
      assert.equal(x.t!.recheckState, "DONE");
    }
    t = await monthTotals(ym, store.id);
    assert.deepEqual([t.count, t.fee], [0, feeBefore], "再確認で売上・手数料が変わりました");
    assert.equal(await countTx(), 3);
    step("4. 返金済み・チャージバック済みの決済を自動の回収・手動の再確認で再確認しても、注文・権利・返金・売上・手数料は変わらない（復活しない）");
  }

  // ================= 5. 自動の回収と Webhook の再送の同時実行 =================
  await resetProject();
  {
    const store = await newStore("回収検証店舗5");
    // 5a. 返金なし：同じ通知の再送と同時
    const pa = await makePending(rt, live, store);
    // 5b. 返金の通知を取りこぼした決済：回収・同じ通知の再送・返金の通知の再送が同時
    const pb = await makePending(rt, live, store);
    live.addRefund(pb.charge);
    const results = await Promise.all([recover(), deliver(rt, pa.completed), deliver(rt, pb.completed), deliver(rt, refundEv(pb)), recover(), deliver(rt, pb.completed)]);
    for (const r of results) if ("body" in r) assert.ok(r.status === 200 || r.status === 409, `同時実行の Webhook が失敗：${r.status} ${JSON.stringify(r.body)}`);
    // 処理中で 409 になった通知は Stripe と同じく後で再送する
    for (const p of [pa, pb]) assert.equal((await deliver(rt, p.completed)).status, 200);
    const xa = await stateOf(pa);
    const xb = await stateOf(pb);
    assert.deepEqual([xa.t!.recheckState, xa.t!.paymentStatus, xa.fs!.status], ["DONE", "SUCCEEDED", "PAID"]);
    assert.deepEqual([xb.t!.recheckState, xb.t!.paymentStatus, xb.t!.amountRefunded, refundCount(xb.t), xb.fs!.status, xb.co.status], ["DONE", "REFUNDED", 100, 1, "EXPIRED", "REFUNDED"]);
    const t = await monthTotals(ym, store.id);
    assert.deepEqual([t.count, t.gross, t.fee], [1, 100, 8], "売上・手数料が二重に数えられました（売上は返金の無い1件100円、手数料は決済記録ごとに1回）");
    assert.deepEqual([await countTx(), await countFs()], [2, 2], "決済記録・占い権利が増えました");
    const adj = (await fsdb().collection(C.settlementAdjustments).get()).size;
    assert.equal(adj, 0, "未払いの月なのに精算の調整が作られました");
    step("5. 自動の回収と Webhook の再送（同じ通知・返金の通知）が同時でも、決済記録・権利は1件ずつ、返金は1回、売上・手数料は二重にならない");
  }

  // ================= 6. 自動の回収と手動の再確認の同時実行 =================
  await resetProject();
  {
    const store = await newStore("回収検証店舗6");
    const p = await makePending(rt, live, store);
    const gets0 = sessionGets(live, p.sessionId);
    const [r1, m, r2] = await Promise.all([recover(), manualRecheckTransaction(p.txId, OP, mdeps), recover()]);
    const autoAttempts = r1.attempted + r2.attempted;
    const manualStarted = m.started ? 1 : 0;
    assert.equal(autoAttempts + manualStarted, 1, `自動 ${autoAttempts}回・手動 ${manualStarted}回：同じ決済記録の再確認が重複しました`);
    if (!m.started) assert.ok(m.reason === "auto_running" || m.reason === "not_pending", `手動の再確認の理由：${m.reason}`);
    const skipped = { ...r1.skipped, ...r2.skipped };
    if (m.started) assert.ok(Object.keys(skipped).some((k) => /manual_running|claim_manual_running|claim_not_pending|backoff|claim_backoff/.test(k)), JSON.stringify(skipped));
    assert.equal(sessionGets(live, p.sessionId) - gets0, 1, "Stripe の Session の取得（確定の処理）が1回ではありません");
    const x = await stateOf(p);
    assert.deepEqual([x.t!.recheckState, x.t!.recheckAttempts], ["DONE", 2], "確定の処理の中の再確認が1回ではありません");
    const t = await monthTotals(ym, store.id);
    assert.deepEqual([t.count, t.gross], [1, 100]);
    assert.equal((await auditsFor(p.txId)).length, manualStarted, "監査ログの件数が手動の再確認の実行の回数と一致しません");
    step(`6. 自動の回収×2と手動の再確認が同時でも、再確認は1回だけ（${m.started ? "手動" : "自動"}が先に開始。もう一方は実行中・完了として開始しない）。売上は1件`);
  }

  // ================= 7・8. Stripe API の例外・6回の上限・20時間の間隔 =================
  await resetProject();
  {
    const store = await newStore("回収検証店舗7");
    const p = await makePending(rt, live, store);
    const sessionPath = new RegExp(`^/v1/checkout/sessions/${p.sessionId}$`);
    fake.failCalls.push({ path: sessionPath, method: "GET", skip: 0, count: 1 });
    watchTx = true;
    const t0 = new Date();
    const s = await recover({ now: () => t0 });
    watchTx = false;
    assert.deepEqual([s.status, s.attempted, s.results.error], ["partial", 1, 1], JSON.stringify(s));
    let x = (await txData(p.txId))!;
    assert.deepEqual([x.recheckState, x.recheckRecoveryAttempts, x.recheckRecoveryLastResult], ["PENDING", 1, "error"]);
    // エラーの名前（Error.name）だけを記録する。Stripe SDK の例外は name が "Error"（種類は type にある）。エラー文・秘密情報は残さない
    assert.equal(x.recheckRecoveryLastError, "Error", `エラーの名前：${x.recheckRecoveryLastError}`);
    assert.equal((await stateOf(p)).fs!.status, "PAID", "Stripe の例外で権利が変わりました");
    const mon = await runPaymentMonitor({ rt: null, now: new Date(t0.getTime() + 1000) });
    assert.ok(mon.started);
    let a = await alertOf(p.txId);
    assert.ok(a, "PENDING が決済監視の異常として記録されていません");
    assert.deepEqual([a!.kind, a!.recheckStatus, a!.errorName], ["recheck_pending", "pending", x.recheckRecoveryLastError]);
    step("7. Stripe API の例外：結果 error・試行の回数1回は残り、PENDING のまま（権利はそのまま）。決済監視の対象（pending・エラーの名前）");

    // 8. 20時間の間隔と6回の上限（時刻を進めて確認。毎回 Stripe API の例外で PENDING のまま）
    let last = t0;
    for (let n = 2; n <= RECHECK_RECOVERY_MAX_ATTEMPTS; n++) {
      const early = new Date(last.getTime() + RECHECK_RECOVERY_BACKOFF_MS - 1);
      const sEarly = await recover({ now: () => early });
      assert.deepEqual([sEarly.attempted, sEarly.skipped.backoff], [0, 1], `${n}回目の直前（20時間の1ミリ秒前）に試しました：${JSON.stringify(sEarly)}`);
      const at = new Date(last.getTime() + RECHECK_RECOVERY_BACKOFF_MS);
      fake.failCalls.push({ path: sessionPath, method: "GET", skip: 0, count: 1 });
      const sAt = await recover({ now: () => at });
      assert.deepEqual([sAt.attempted, sAt.results.error], [1, 1], `${n}回目（ちょうど20時間後）に試していません：${JSON.stringify(sAt)}`);
      x = (await txData(p.txId))!;
      assert.equal(x.recheckRecoveryAttempts, n);
      last = at;
    }
    const far = new Date(last.getTime() + 10 * RECHECK_RECOVERY_BACKOFF_MS);
    const gets0 = sessionGets(live, p.sessionId);
    const sMax = await recover({ now: () => far });
    assert.deepEqual([sMax.attempted, sMax.skipped.max_attempts], [0, 1], JSON.stringify(sMax));
    assert.equal(sessionGets(live, p.sessionId), gets0, "上限の後に Stripe API を呼びました");
    x = (await txData(p.txId))!;
    assert.deepEqual([x.recheckState, x.recheckRecoveryAttempts], ["PENDING", RECHECK_RECOVERY_MAX_ATTEMPTS]);
    await runPaymentMonitor({ rt: null, now: far });
    a = await alertOf(p.txId);
    assert.equal(a!.recheckStatus, "exhausted", "上限に達した PENDING が「上限で終了」として記録されていません");
    // 上限の後も、運営は手動で再確認できる（Stripe が回復していれば DONE）
    const m = await manualRecheckTransaction(p.txId, OP, mdeps);
    assert.deepEqual([m.started, m.started && m.result], [true, "done"]);
    assert.equal((await txData(p.txId))!.recheckState, "DONE");
    step(`8. 自動の回収は20時間の間隔（1ミリ秒前は試さず、ちょうどで試す）で${RECHECK_RECOVERY_MAX_ATTEMPTS}回まで。上限の後は Stripe API を呼ばず、決済監視は「上限で終了」。手動では再確認できる`);
  }

  // ================= 9. 10件の上限・60秒の時間の制限・続きの位置の一周 =================
  await resetProject();
  {
    const store = await newStore("回収検証店舗9");
    // 間隔待ちで対象外の記録（文書の ID の順で先頭）
    const seeds = ["stripe_pi_aaa_1", "stripe_pi_aaa_2", "stripe_pi_aaa_3"];
    for (const id of seeds) await seedPending(id);
    const pays: Pay[] = [];
    for (let i = 0; i < 12; i++) pays.push(await makePending(rt, live, store));
    const ids = pays.map((p) => p.txId).sort();
    const s1 = await recover();
    assert.deepEqual([s1.status, s1.scanned, s1.attempted, s1.results.done, s1.skipped.backoff, s1.deferred], ["partial", 13, RECHECK_RECOVERY_MAX_ITEMS, 10, 3, true], JSON.stringify(s1));
    assert.equal(s1.nextCursor, ids[9], "続きの位置が10件目の決済記録ではありません");
    assert.equal((await runDoc())!.nextCursor, ids[9]);
    const s2 = await recover();
    // 続きの2件 → 最後まで読んで最初に戻る（対象外の3件）→ 一周して終わり
    assert.deepEqual([s2.status, s2.scanned, s2.attempted, s2.results.done, s2.skipped.backoff, s2.deferred, s2.nextCursor], ["completed", 5, 2, 2, 3, false, null], JSON.stringify(s2));
    for (const id of ids) assert.equal((await txData(id))!.recheckState, "DONE");
    const s3 = await recover();
    assert.deepEqual([s3.scanned, s3.attempted, s3.nextCursor], [3, 0, null], "一周の後にもう一度読んでいます");
    step(`9a. 1回の実行で最大${RECHECK_RECOVERY_MAX_ITEMS}件（13件を読み10件を回収、続きの位置を保存）。次の実行は続きの2件から読み、最後で最初に戻って一周したら終わり（同じ記録は1回の実行で1回）`);

    // 60秒の時間の制限（時刻を進める）：1件の回収の後に61秒たったら、次の記録は始めない
    const more: Pay[] = [];
    for (let i = 0; i < 3; i++) more.push(await makePending(rt, live, store));
    const mids = more.map((p) => p.txId).sort();
    let offset = 0;
    const clock = () => new Date(Date.now() + offset);
    const slow: RecheckRecoveryDeps = { ...deps, recheck: async (c) => {
      const r = await deps.recheck(c);
      offset += RECHECK_RECOVERY_DEADLINE_MS + 1000;
      return r;
    } };
    const s4 = await recover({ now: clock }, slow);
    assert.deepEqual([s4.attempted, s4.deferred, s4.status], [1, true, "partial"], JSON.stringify(s4));
    assert.equal(s4.nextCursor, mids[0]);
    // 定期処理の notAfter を過ぎていたら、1件も始めず、続きの位置も変えない
    const s5 = await recover({ notAfter: new Date(Date.now() - 1) });
    assert.deepEqual([s5.attempted, s5.scanned, s5.deferred, s5.nextCursor], [0, 0, true, mids[0]], JSON.stringify(s5));
    // ページの上限：対象外の記録も続きの位置を進める（同じ記録ばかり読まれない）
    await fsdb().collection(C.system).doc("recheckRecovery").delete();
    const s6 = await recover({ pageSize: 2, maxPages: 1 });
    assert.deepEqual([s6.scanned, s6.attempted, s6.deferred, s6.nextCursor], [2, 0, true, seeds[1]], JSON.stringify(s6));
    const s7 = await recover({ pageSize: 2, maxPages: 1 });
    assert.deepEqual([s7.scanned, s7.attempted, s7.nextCursor], [2, 1, mids[1]], JSON.stringify(s7));
    const s8 = await recover();
    assert.equal(s8.attempted, 1);
    for (const id of mids) assert.equal((await txData(id))!.recheckState, "DONE");
    // 壊れた続きの位置（形の不正な値）は無視して最初から読む（回収が止まり続けない）
    await fsdb().collection(C.system).doc("recheckRecovery").set({ nextCursor: "bad/cursor" });
    const s9 = await recover();
    assert.deepEqual([s9.status, s9.scanned], ["completed", 3], JSON.stringify(s9));
    step(`9b. 開始から${RECHECK_RECOVERY_DEADLINE_MS / 1000}秒を過ぎたら新しい回収を始めない（続きの位置を保存）。notAfter を過ぎていれば何もしない。対象外の記録も位置を進め、壊れた位置は最初から`);
  }

  // ================= 10. 決済記録が無い・Session と PaymentIntent が一致しない：作らずに拒否 =================
  await resetProject();
  {
    const store = await newStore("回収検証店舗10");
    const q = await paidOnly(rt, live, store.storeCode); // 支払い済み・決済記録なし（通知が届いていない）
    watchTx = true;
    const c = await confirmStripeCheckout(q.sessionId, rt, { expectedPaymentIntentId: q.pi, requireExistingTransaction: true });
    watchTx = false;
    assert.deepEqual(c, { status: "rejected", reason: "transaction_missing" });
    assert.equal(await txData(q.txId), null, "決済記録が作られました");
    assert.equal(await countFs(), 0, "占い権利が作られました");
    const coBefore = (await fsdb().collection(C.checkouts).doc(q.checkoutId).get()).data()!;
    // 自動の回収の対象の記録が、別の文書の ID で、この Session を指している（決済記録が無い）
    await seedPending("stripe_pi_zz_orphan", { stripeCheckoutSessionId: q.sessionId, stripePaymentIntentId: q.pi, recheckRecoveryLastAt: null, recheckRecoveryAttempts: 0 });
    // Session の PaymentIntent が記録と一致しない
    await seedPending("stripe_pi_zz_mismatch", { stripeCheckoutSessionId: q.sessionId, stripePaymentIntentId: "pi_live_other_payment_x", recheckRecoveryLastAt: null, recheckRecoveryAttempts: 0 });
    // テスト（Sandbox）の決済記録：本番の接続では対象外（モードを混同しない）
    await seedPending("stripe_pi_zz_testmode", { livemode: false, stripeCheckoutSessionId: "cs_test_seedmode", stripePaymentIntentId: "pi_test_seedmode", recheckRecoveryLastAt: null, recheckRecoveryAttempts: 0 });
    watchTx = true;
    const s = await recover();
    watchTx = false;
    assert.deepEqual([s.attempted, s.results.rejected, s.skipped.mode_mismatch], [2, 2, 1], JSON.stringify(s));
    const orphan = (await txData("stripe_pi_zz_orphan"))!;
    const mismatch = (await txData("stripe_pi_zz_mismatch"))!;
    assert.deepEqual([orphan.recheckState, orphan.recheckRecoveryLastResult, orphan.recheckRecoveryLastError], ["PENDING", "rejected", "transaction_missing"]);
    assert.deepEqual([mismatch.recheckState, mismatch.recheckRecoveryLastResult, mismatch.recheckRecoveryLastError], ["PENDING", "rejected", "payment_intent_mismatch"]);
    const tm = (await txData("stripe_pi_zz_testmode"))!;
    assert.equal(tm.recheckRecoveryAttempts, 0, "テストモードの決済記録を本番の接続で回収しました");
    assert.equal(await txData(q.txId), null, "自動の回収で決済記録が作られました");
    assert.deepEqual([await countTx(), await countFs()], [3, 0], "決済記録・占い権利が増えました");
    assert.deepEqual((await fsdb().collection(C.checkouts).doc(q.checkoutId).get()).data()!.status, coBefore.status, "注文の状態が変わりました");
    // 手動の再確認も同じく拒否（記録・権利を作らない）。結果は監査ログに残す。テストモードの記録は本番の接続で開始しない
    const m = await manualRecheckTransaction("stripe_pi_zz_mismatch", OP, mdeps);
    assert.deepEqual([m.started, m.started && m.result, m.started && m.errorName], [true, "rejected", "payment_intent_mismatch"]);
    const mt = await manualRecheckTransaction("stripe_pi_zz_testmode", OP, mdeps);
    assert.deepEqual(mt, { started: false, reason: "mode_mismatch" });
    const au = await auditsFor("stripe_pi_zz_mismatch");
    assert.equal(au.length, 1);
    assert.deepEqual([au[0].actorUserId, au[0].after.result, au[0].after.errorName], [OP.userId, "rejected", "payment_intent_mismatch"]);
    assert.equal((await auditsFor("stripe_pi_zz_testmode")).length, 0);
    assert.equal(await txData(q.txId), null);
    await runPaymentMonitor({ rt: null });
    assert.equal((await alertOf("stripe_pi_zz_orphan"))!.recheckStatus, "rejected");
    assert.equal((await alertOf("stripe_pi_zz_mismatch"))!.recheckStatus, "rejected");
    step("10. 決済記録が無い（transaction_missing）・Session と PaymentIntent が不一致（payment_intent_mismatch）は、自動・手動とも新しい決済記録・権利を作らずに拒否。決済監視は「拒否」。テストモードの記録は本番の接続で扱わない");
  }

  // ================= 13・14. 定期処理（/api/cron/maintenance）：順番と、回収の失敗がメンテナンスの結果を変えないこと =================
  await resetProject();
  {
    const { GET } = await import("@/app/api/cron/maintenance/route");
    const cron = () => GET(new Request("http://localhost/api/cron/maintenance", { headers: { authorization: `Bearer ${process.env.CRON_SECRET}` } }));
    const trt = stripeRuntime(); // 環境変数から：テストモード・模擬 Stripe（localhost）
    assert.equal(trt.mode, "test");
    const store = await newStore("回収検証店舗13");
    const p = await makePending(trt, testFake, store);
    await seedPending("stripe_pi_zz_livemode"); // 本番の決済記録：テストの接続の定期処理では対象外
    await fsdb().collection(C.transactions).doc("stripe_pi_zz_livemode").update({ recheckRecoveryLastAt: null, recheckRecoveryAttempts: 0 });
    assert.equal((await GET(new Request("http://localhost/api/cron/maintenance"))).status, 401, "認証なしの定期処理が実行されました");
    const res = await cron();
    assert.equal(res.status, 200);
    const body = (await res.json()) as Record<string, unknown> & { recheckRecovery: Record<string, unknown>; webhookRecovery: Record<string, unknown> };
    assert.deepEqual([body.recheckRecovery.status, body.recheckRecovery.attempted, body.recheckRecovery.done], ["completed", 1, 1], JSON.stringify(body.recheckRecovery));
    const maint = (await fsdb().collection(C.system).doc("maintenance").get()).data()!;
    const wr = (await fsdb().collection(C.system).doc("webhookRecovery").get()).data()!;
    const rr = (await runDoc())!;
    const ms = (v: { toDate(): Date }) => v.toDate().getTime();
    assert.equal(maint.lastStatus, "success");
    assert.ok(ms(maint.lastRunAt) <= ms(wr.startedAt), "Webhook の復旧がメンテナンスの終了より前に始まりました");
    assert.ok(ms(wr.finishedAt) <= ms(rr.startedAt), "PENDING の回収が Webhook の復旧の終了より前に始まりました");
    assert.equal((await txData(p.txId))!.recheckState, "DONE");
    const lm = (await txData("stripe_pi_zz_livemode"))!;
    assert.deepEqual([lm.recheckState, lm.recheckRecoveryAttempts], ["PENDING", 0], "本番の決済記録をテストの接続の定期処理で回収しました");
    assert.equal(rr.counts.skipped_mode_mismatch, 1);
    const { webhookRecovery: _w, recheckRecovery: _r, ...maintResult } = body;
    assert.deepEqual(maintResult, maint.lastResult, "応答のメンテナンスの結果が記録と一致しません");
    step("13. 定期処理はメンテナンス → Webhook の復旧 → PENDING の回収の順（記録の時刻で確認）。テストの接続では本番の決済記録を回収しない");

    // 14. 回収の失敗（PENDING の一覧の読み込みの失敗）でも、メンテナンスの結果・応答の状態コードは変わらない
    await makePending(trt, testFake, store);
    failPendingQuery = true;
    const res2 = await cron();
    failPendingQuery = false;
    assert.equal(res2.status, 200, "回収の失敗で定期処理の応答が失敗になりました");
    const body2 = (await res2.json()) as Record<string, unknown> & { recheckRecovery: Record<string, unknown> };
    assert.equal(body2.recheckRecovery.status, "failed");
    const maint2 = (await fsdb().collection(C.system).doc("maintenance").get()).data()!;
    assert.equal(maint2.lastStatus, "success");
    const { webhookRecovery: _w2, recheckRecovery: _r2, ...maintResult2 } = body2;
    assert.deepEqual(maintResult2, maint2.lastResult);
    const rr2 = (await runDoc())!;
    assert.deepEqual([rr2.status, rr2.errorName], ["failed", "SimulatedFirestoreError"]);
    // 次の定期処理で回復する
    const body3 = (await (await cron()).json()) as { recheckRecovery: Record<string, unknown> };
    assert.deepEqual([body3.recheckRecovery.status, body3.recheckRecovery.done], ["completed", 1]);
    step("14. PENDING の回収が失敗しても、定期処理は 200・メンテナンスの記録は success・結果は同じ（回収の記録は failed）。次の定期処理で回復");
  }

  // ================= 15. 手動の再確認の実行中の印の期限の境界と、長い処理の間の期限切れ =================
  await resetProject();
  {
    const store = await newStore("回収検証店舗15");
    const p = await makePending(rt, live, store);
    live.addRefund(p.charge); // 返金の通知を取りこぼした決済（二重の反映の確認用）
    const T = new Date();
    const a = await mdeps.claim(p.txId, T, "op-a");
    assert.ok(a.claimed);
    const justBefore = new Date(T.getTime() + RECHECK_MANUAL_LEASE_MS - 1);
    assert.deepEqual(await mdeps.claim(p.txId, justBefore, "op-b"), { claimed: false, reason: "manual_running" });
    const sb = await recover({ now: () => justBefore });
    assert.deepEqual([sb.attempted, sb.skipped.manual_running], [0, 1], JSON.stringify(sb));
    // 印を外して、長い処理の確認に進む（期限ちょうどで別の運営が開始できることは 15b で確認する）
    await fsdb().collection(C.transactions).doc(p.txId).update({ recheckManualUntil: null, recheckManualToken: null });
    const x0 = (await txData(p.txId))!;
    assert.equal(x0.recheckState, "PENDING");
    step("15a. 手動の再確認の実行中の印は期限の1ミリ秒前まで有効（ほかの運営の手動・自動の回収は開始しない）");

    // 長い処理：運営 A の再確認が Stripe の応答を待つ間に印の期限が切れ、運営 B が開始・完了する
    let releaseA!: () => void;
    const gateA = new Promise<void>((ok) => (releaseA = ok));
    let aStarted!: () => void;
    const aIsWaiting = new Promise<void>((ok) => (aStarted = ok));
    const slowDeps: ManualRecheckDeps = { ...mdeps, recheck: async (c) => {
      aStarted();
      await gateA;
      return mdeps.recheck(c);
    } };
    const runA = manualRecheckTransaction(p.txId, { userId: "op-a", role: "OPERATOR" }, slowDeps, T);
    await aIsWaiting;
    const atExpiry = new Date(T.getTime() + RECHECK_MANUAL_LEASE_MS);
    const bRun = await manualRecheckTransaction(p.txId, { userId: "op-b", role: "OPERATOR" }, mdeps, atExpiry);
    assert.deepEqual([bRun.started, bRun.started && bRun.result], [true, "done"], JSON.stringify(bRun));
    releaseA();
    const aRun = await runA;
    assert.deepEqual([aRun.started, aRun.started && aRun.result], [true, "done"], JSON.stringify(aRun));
    const x = await stateOf(p);
    assert.deepEqual([x.t!.recheckState, x.t!.paymentStatus, x.t!.amountRefunded, refundCount(x.t), x.fs!.status, x.co.status], ["DONE", "REFUNDED", 100, 1, "EXPIRED", "REFUNDED"]);
    assert.deepEqual([x.t!.recheckManualLastBy, x.t!.recheckManualToken, x.t!.recheckManualUntil, x.t!.recheckManualAttempts], ["op-b", null, null, 3], "古い印の終了が新しい実行の記録を上書きしました（回数は 15a・A・B の3回）");
    const t = await monthTotals(ym, store.id);
    assert.equal(t.count, 0);
    const au = await auditsFor(p.txId);
    assert.deepEqual(au.map((d) => d.actorUserId).sort(), ["op-a", "op-b"], "監査ログが実行ごとに1件ではありません");
    step("15b. 長い処理の間に印の期限が切れて別の運営が実行しても、返金は1回・権利は停止のまま・売上0件。古い実行の終了は新しい実行の記録を消さない（監査ログは2件）");
  }

  assert.deepEqual(txViolations, [], `Firestore のトランザクションの中で Stripe API を呼びました：${txViolations.join(", ")}`);
  step("確認した場面（1〜4・7・10）で、Firestore のトランザクションの実行中に Stripe API の呼び出しは無い");
  console.log("\nSTRIPE RECHECK RECOVERY E2E PASSED");
}

main()
  .then(async () => {
    await live.stop();
    await testFake.stop();
    process.exit(0);
  })
  .catch(async (e) => {
    console.error("\nSTRIPE RECHECK RECOVERY E2E FAILED:", e);
    await live.stop().catch(() => {});
    await testFake.stop().catch(() => {});
    process.exit(1);
  });
