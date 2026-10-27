/**
 * 決済監視・障害検知の E2E 検証。
 *  - 監視の点検（読み取り専用）：占い権利の無い決済・確定待ちのまま時間を過ぎた注文・Stripe で支払い済みなのに未確定の注文・精算の金額
 *  - 処理の失敗の記録：Webhook の署名の不正・返金／異議申し立ての反映の失敗・精算の確定の失敗・決済の API の 5xx
 *  - 重複をまとめる（再送・くり返しで増えない）・確認済み（監査ログ）・再発で未確認に戻る
 *  - テストと本番の取り違え（モードの違う注文は照合しない・記録のモードで分ける）
 *  - 監視が動いていない・一部未確認のときは「異常なし」と表示しない。運営画面の表示・店舗アカウントからは見えない
 * 本物の Stripe・本番の Firebase には一切接続しない（localhost の模擬 Stripe と Firestore Emulator の demo- プロジェクトだけ）。
 *
 *   firebase emulators:start --only firestore --project demo-uranai
 *   （別ターミナル）npm run build && FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 FIREBASE_PROJECT_ID=demo-uranai-monitor npm run e2e:payment-monitor
 */
import "dotenv/config";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import Stripe from "stripe";
import { createFakeStripe } from "./lib/fake-stripe";
import { C, fsdb } from "@/lib/firestore/admin";
import { dataProvider } from "@/lib/data-provider";
import { createOperator, createStore, createStoreUser } from "@/lib/services/stores";
import { generateSettlements, updateSettlementStatus } from "@/lib/services/settlements";
import { createCheckout } from "@/lib/firestore/payments";
import { acquireMonitorLock, listPaymentAlerts, markMonitorFinished, paymentAlertId, readMonitorStatus, releaseMonitorLock, resolvePaymentAlert, notePaymentApiError, PAYMENT_ALERT_LIST_LIMIT } from "@/lib/firestore/payment-alerts";
import { monitorHealth, hourBucket, MONITOR_LOCK_TTL_MS, type PaymentAlertKind } from "@/lib/payments/monitor-rules";
import { runPaymentMonitor } from "@/lib/payments/payment-monitor";
import { createSimulatedStripeRuntime, STRIPE_SESSION_TTL_MS, type StripeRuntime } from "@/lib/payments/stripe-checkout";
import { startStripeCheckout } from "@/lib/payments/stripe-confirm";
import { handleStripeWebhook } from "@/lib/payments/stripe-webhook";
import { randomToken, sha256Hex } from "@/lib/security/crypto";
import { jstYearMonth, shiftYearMonth } from "@/lib/time";

const SYSTEM = { userId: null, role: "SYSTEM" as const };
const step = (msg: string) => console.log(`  ✓ ${msg}`);
const ORIGIN = "http://localhost:3000";
const PORT = Number(process.env.E2E_MONITOR_PORT ?? 3230);
const BASE = `http://localhost:${PORT}`;

const TEST_PORT = 12121;
const LIVE_PORT = 12122;
const TEST_KEY = "sk_test_e2e_monitor_dummy";
const LIVE_KEY = "sk_live_e2e_monitor_dummy";
const TEST_WHSEC = "whsec_e2e_monitor_test_dummy";
const LIVE_WHSEC = "whsec_e2e_monitor_live_dummy";
const testStripe = createFakeStripe({ port: TEST_PORT, mode: "test", apiKey: TEST_KEY });
const liveStripe = createFakeStripe({ port: LIVE_PORT, mode: "live", apiKey: LIVE_KEY });

const signer = new Stripe("sk_test_signer");
let evN = 0;
async function webhook(rt: StripeRuntime, type: string, object: Record<string, unknown>, opts: { eventId?: string; secret?: string; signature?: string } = {}) {
  const payload = JSON.stringify({ id: opts.eventId ?? `evt_mon_${++evN}_${Date.now()}`, object: "event", type, livemode: rt.mode === "live", data: { object } });
  const sig = opts.signature ?? signer.webhooks.generateTestHeaderString({ payload, secret: opts.secret ?? rt.webhookSecret });
  return handleStripeWebhook(payload, sig, rt);
}
const outcomeOf = (r: { body: unknown }) => (r.body as { outcome?: string }).outcome;

async function startPay(rt: StripeRuntime, storeCode: string) {
  const { checkoutId, accessToken } = await createCheckout(storeCode, "ZODIAC", { provider: "stripe", ttlMs: STRIPE_SESSION_TTL_MS });
  const r = await startStripeCheckout(accessToken, ORIGIN, rt);
  return { checkoutId, sessionId: (r as { url: string }).url.split("/").pop()! };
}
async function paid(rt: StripeRuntime, stripe: ReturnType<typeof createFakeStripe>, storeCode: string, ym?: string) {
  const { checkoutId, sessionId } = await startPay(rt, storeCode);
  const created = ym ? Math.floor(new Date(`${ym}-15T12:00:00+09:00`).getTime() / 1000) : undefined;
  const p = await stripe.ctl(`pay/${sessionId}`, { created, fee: 4 });
  assert.equal(outcomeOf(await webhook(rt, "checkout.session.completed", { id: sessionId, object: "checkout.session" })), "confirmed");
  const [t] = (await fsdb().collection(C.transactions).where("checkoutId", "==", checkoutId).get()).docs;
  return { checkoutId, sessionId, txId: t.id, charge: p.charge!, pi: p.paymentIntent! };
}
const alertDoc = async (kind: PaymentAlertKind, objectId: string) => (await fsdb().collection(C.paymentAlerts).doc(paymentAlertId(kind, objectId)).get()).data();
const countAlerts = async () => (await fsdb().collection(C.paymentAlerts).count().get()).data().count;
const newStore = async (label: string) => createStore({ name: `${label} ${Date.now()}`, contactName: "", postalCode: "", address: "", phone: "", email: "" }, SYSTEM);
/** 点検を実行し、開始できたことを確かめて結果を返す */
async function monitor(o: Parameters<typeof runPaymentMonitor>[0]) {
  const x = await runPaymentMonitor(o);
  assert.ok(x.started, `点検を開始できませんでした（${JSON.stringify(x)}）`);
  return x.report;
}
const SECRET_RE = /sk_(test|live)_|whsec_|t=\d+,v1=|4242|@example/;

// ================= アプリ（運営画面の表示の確認用） =================
let app: ChildProcess | null = null;
async function startApp() {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PORT: String(PORT),
    APP_URL: BASE,
    DB_PROVIDER: "firestore",
    SESSION_SECRET: `e2e-monitor-${randomToken(24)}`,
    SITE_STATUS: "open",
    PAYMENT_PROVIDER: "stripe",
    ENABLE_TEST_PAYMENT: "false",
    ALLOW_MOCK_PAYMENTS_IN_PRODUCTION: "false",
    STRIPE_TEST_CHECKOUT: "on",
    STRIPE_SECRET_KEY: TEST_KEY,
    STRIPE_WEBHOOK_SECRET: TEST_WHSEC,
    STRIPE_API_BASE: `http://127.0.0.1:${TEST_PORT}`,
    STRIPE_LIVE_CHECKOUT: "",
    STRIPE_LIVE_OPERATOR_TEST: "",
  };
  for (const k of ["VERCEL_ENV", "VERCEL_URL", "VERCEL_BRANCH_URL"]) delete env[k];
  const child = spawn("node_modules/.bin/next", ["start", "-p", String(PORT)], { env, stdio: ["ignore", "pipe", "pipe"] });
  let log = "";
  child.stdout!.on("data", (d) => (log += d));
  child.stderr!.on("data", (d) => (log += d));
  app = child;
  for (let i = 0; i < 120; i++) {
    if (child.exitCode !== null) throw new Error(`アプリが起動しませんでした\n${log.slice(-2000)}`);
    try {
      if ((await fetch(`${BASE}/api/health`)).status > 0) return () => log;
    } catch {
      /* 起動待ち */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("アプリが起動しませんでした");
}
async function stopApp() {
  const child = app;
  app = null;
  if (!child || child.exitCode !== null) return;
  await new Promise<void>((resolve) => {
    child.once("exit", () => resolve());
    child.kill("SIGTERM");
  });
}
class Client {
  jar = new Map<string, string>();
  ip = `203.0.113.${Math.floor(Math.random() * 250) + 1}`;
  async req(path: string, init: RequestInit & { json?: unknown } = {}) {
    const headers = new Headers(init.headers);
    headers.set("cookie", [...this.jar].map(([k, v]) => `${k}=${v}`).join("; "));
    headers.set("x-real-ip", this.ip);
    if (init.method === "POST" && !headers.has("origin")) headers.set("origin", BASE);
    if (init.json !== undefined) {
      headers.set("content-type", "application/json");
      init.body = JSON.stringify(init.json);
    }
    const res = await fetch(BASE + path, { ...init, headers, redirect: "manual" });
    for (const c of res.headers.getSetCookie()) {
      const [kv] = c.split(";");
      const i = kv.indexOf("=");
      this.jar.set(kv.slice(0, i), kv.slice(i + 1));
    }
    return res;
  }
}
async function loggedIn(userId: string) {
  const token = randomToken(32);
  await fsdb().collection(C.authSessions).doc(sha256Hex(token)).set({ userId, expiresAt: new Date(Date.now() + 3600_000) });
  const c = new Client();
  c.jar.set("sid", token);
  return c;
}

async function main() {
  const host = process.env.FIRESTORE_EMULATOR_HOST ?? "";
  assert.match(host, /^(127\.0\.0\.1|localhost|\[::1\]):\d+$/, "FIRESTORE_EMULATOR_HOST（localhost の Emulator）が必要です");
  const project = process.env.FIREBASE_PROJECT_ID ?? "";
  assert.match(project, /^demo-/, "FIREBASE_PROJECT_ID は demo- で始まる Emulator 用の ID にしてください");
  assert.ok(!process.env.VERCEL_ENV, "Vercel 上では実行しません");
  process.env.DB_PROVIDER = "firestore";
  assert.equal(dataProvider(), "firestore");
  for (const k of ["STRIPE_SECRET_KEY", "STRIPE_LIVE_CHECKOUT", "STRIPE_LIVE_OPERATOR_TEST"]) delete process.env[k];
  // 監視の点検はプロジェクト全体を見るので、この検証用の Emulator のプロジェクトを空にしてから始める（demo- だけ）
  let delStatus = 0;
  for (let i = 0; i < 20 && delStatus !== 200; i++) {
    if (i) await new Promise((ok) => setTimeout(ok, 1_000)); // 前の実行の書き込みのロックが残っていれば待つ
    delStatus = (await fetch(`http://${host}/emulator/v1/projects/${project}/databases/(default)/documents`, { method: "DELETE" })).status;
  }
  assert.equal(delStatus, 200, "Emulator のデータを消せませんでした");
  await testStripe.start();
  await liveStripe.start();
  const test = createSimulatedStripeRuntime("test", { apiBase: `http://127.0.0.1:${TEST_PORT}`, secretKey: TEST_KEY, webhookSecret: TEST_WHSEC });
  const live = createSimulatedStripeRuntime("live", { apiBase: `http://127.0.0.1:${LIVE_PORT}`, secretKey: LIVE_KEY, webhookSecret: LIVE_WHSEC });
  console.log(`Payment monitor E2E (emulator ${host} / ${project}, fake Stripe test :${TEST_PORT} / live :${LIVE_PORT})`);

  // ================= 1. 監視が一度も動いていない =================
  assert.equal(await readMonitorStatus(), null);
  assert.equal(monitorHealth(await readMonitorStatus(), new Date(), 0).state, "never_run");
  step("監視の点検が一度も無いときは「未実施」（異常なしと表示しない）");

  // 何も無い状態の点検は「異常なし」
  let r = await monitor({ rt: test });
  assert.deepEqual([r.result, r.found, r.unchecked], ["ok", 0, []]);
  assert.equal(monitorHealth(await readMonitorStatus(), new Date(), 0).state, "ok");
  step("すべて確認できて異常が無いときだけ「異常なし」");

  // ================= 1b. 点検の同時実行の防止（排他制御） =================
  const lockDoc = async () => (await fsdb().collection(C.system).doc("paymentMonitorLock").get()).data();
  // 同時に取得しても1つだけ（Firestore のトランザクション。サーバーのインスタンスが別でも同じ）
  for (const n of [2, 8]) {
    const got = await Promise.all(Array.from({ length: n }, () => acquireMonitorLock({ now: new Date(), ttlMs: MONITOR_LOCK_TTL_MS, source: "admin" }).catch(() => ({ ok: false as const }))));
    const winners = got.filter((g) => g.ok);
    assert.equal(winners.length, 1, `同時に${n}回の点検の開始で、${winners.length}件がロックを取得しました`);
    assert.equal((await lockDoc())!.runId, (winners[0] as { runId: string }).runId);
    assert.equal(await releaseMonitorLock((winners[0] as { runId: string }).runId), true);
  }
  // 同時に2回の点検（実行の関数）：開始は1回だけ。もう一方は開始しない
  const held = await acquireMonitorLock({ now: new Date(), ttlMs: MONITOR_LOCK_TTL_MS, source: "cron" });
  assert.ok(held.ok);
  const pair = await Promise.all([runPaymentMonitor({ rt: test }), runPaymentMonitor({ rt: test })]);
  assert.ok(pair.every((x) => !x.started && x.reason === "busy" && x.source === "cron"), JSON.stringify(pair));
  // 別のプロセス（別のサーバーのインスタンスに相当）の手動点検も開始しない
  const script = (await import("node:child_process")).spawnSync("node_modules/.bin/tsx", ["--conditions=react-server", "scripts/payment-monitor.ts"], { env: { ...process.env, DB_PROVIDER: "firestore", STRIPE_SECRET_KEY: "", STRIPE_TEST_CHECKOUT: "" }, encoding: "utf8", timeout: 120_000 });
  assert.equal(script.status, 4, `別のプロセスの点検が開始しました：${script.stdout}${script.stderr}`);
  assert.match(script.stderr, /ほかの点検を実行中/);
  assert.equal(await releaseMonitorLock(held.runId), true);
  const pair2 = await Promise.all([runPaymentMonitor({ rt: test }), runPaymentMonitor({ rt: test })]);
  assert.equal(pair2.filter((x) => x.started).length >= 1, true);
  assert.equal(await lockDoc(), undefined, "点検の後にロックが残りました");
  const script2 = (await import("node:child_process")).spawnSync("node_modules/.bin/tsx", ["--conditions=react-server", "scripts/payment-monitor.ts"], { env: { ...process.env, DB_PROVIDER: "firestore", STRIPE_SECRET_KEY: "", STRIPE_TEST_CHECKOUT: "" }, encoding: "utf8", timeout: 120_000 });
  assert.equal(script2.status, 0, `ロックが外れた後の点検を開始できません：${script2.stdout}${script2.stderr}`);
  step("同時の点検の開始は1つだけ（同じプロセスの同時実行・別のプロセスとも）。終われば次の点検を開始できる");

  // 途中で止まった点検（ロックの期限切れ）からの復旧
  const crashedAt = new Date(Date.now() - MONITOR_LOCK_TTL_MS - 60_000);
  const crashed = await acquireMonitorLock({ now: crashedAt, ttlMs: MONITOR_LOCK_TTL_MS, source: "cron" });
  assert.ok(crashed.ok);
  assert.equal(monitorHealth(await readMonitorStatus(), new Date(), 0).state, "failed", "途中で止まった点検が「異常なし」や「実行中」のままです");
  const recovered = await runPaymentMonitor({ rt: test });
  assert.ok(recovered.started, "期限切れのロックから復旧できません");
  assert.equal(recovered.report.result, "ok");
  assert.equal(monitorHealth(await readMonitorStatus(), new Date(), 0).state, "ok");
  // 古い点検が後から終わっても、新しい結果を上書きしない・新しいロックを外さない
  assert.equal(await markMonitorFinished({ runId: crashed.runId, now: new Date(), result: "issues", unchecked: [], found: 99, stripeMode: null, checks: {} }), false);
  assert.equal((await readMonitorStatus())!.found, 0);
  const newer = await acquireMonitorLock({ now: new Date(), ttlMs: MONITOR_LOCK_TTL_MS, source: "admin" });
  assert.ok(newer.ok);
  assert.equal(await releaseMonitorLock(crashed.runId), false, "古い点検が新しい点検のロックを外しました");
  assert.equal((await lockDoc())!.runId, newer.runId);
  assert.equal(await markMonitorFinished({ runId: crashed.runId, now: new Date(), result: "ok", unchecked: [], found: 0, stripeMode: null, checks: {} }), false);
  assert.equal(await releaseMonitorLock(newer.runId), true);
  // 実行中に期限が切れて次の点検が始まった場合も、前の点検の結果は書かれない（次の点検が書く）
  const slowA = await acquireMonitorLock({ now: crashedAt, ttlMs: MONITOR_LOCK_TTL_MS, source: "cron" });
  assert.ok(slowA.ok);
  const fastB = await runPaymentMonitor({ rt: test });
  assert.ok(fastB.started);
  assert.equal(await markMonitorFinished({ runId: slowA.runId, now: new Date(), result: "partial", unchecked: ["x"], found: 5, stripeMode: null, checks: {} }), false);
  assert.deepEqual([(await readMonitorStatus())!.lastResult, (await readMonitorStatus())!.found], ["ok", 0]);
  step("途中で止まった点検は期限が過ぎれば次が開始できる。古い点検は新しい結果・ロックを上書きしない");

  // ================= 2. 決済の記録はあるのに占い権利が無い =================
  const store = await newStore("監視検証店舗");
  const ok1 = await paid(test, testStripe, store.storeCode);
  const lost = await paid(test, testStripe, store.storeCode);
  await fsdb().collection(C.fortuneSessions).doc(lost.txId).delete();
  r = await monitor({ rt: test });
  assert.equal(r.result, "issues");
  let a = await alertDoc("paid_without_entitlement", lost.txId);
  assert.ok(a, "占い権利の無い決済が記録されていません");
  assert.deepEqual([a.status, a.mode, a.occurrences, a.checkoutId, a.storeId], ["OPEN", "test", 1, lost.checkoutId, store.id]);
  assert.equal(await alertDoc("paid_without_entitlement", ok1.txId), undefined, "権利のある決済を異常にしました");
  const before = await countAlerts();
  await monitor({ rt: test });
  a = await alertDoc("paid_without_entitlement", lost.txId);
  assert.equal(a!.occurrences, 2);
  assert.equal(await countAlerts(), before, "くり返しの点検で記録が増えました");
  assert.equal((await fsdb().collection(C.fortuneSessions).doc(lost.txId).get()).exists, false, "点検が占い権利を作りました（読み取り専用のはず）");
  step("占い権利の無い決済を検出（くり返しの点検は回数だけ増え、記録は増えない。権利を勝手に作らない）");

  // 確定した注文に決済の記録が無い
  await fsdb().collection(C.checkouts).doc(ok1.checkoutId).update({ providerPaymentKey: "stripe_pi_missing_for_monitor" });
  r = await monitor({ rt: test });
  assert.ok(await alertDoc("paid_without_entitlement", ok1.checkoutId), "確定済みの注文に決済の記録が無いことを検出していません");
  await fsdb().collection(C.checkouts).doc(ok1.checkoutId).update({ providerPaymentKey: ok1.txId });
  step("確定済みの注文に決済の記録が無いものを検出");

  // ================= 3. 確定待ちのまま時間を過ぎた注文・Stripe で支払い済みなのに未確定 =================
  const stuckPaid = await startPay(test, store.storeCode);
  await testStripe.ctl(`pay/${stuckPaid.sessionId}`); // Stripe では支払い済み。Webhook は届かない
  const stuckUnpaid = await startPay(test, store.storeCode);
  const fresh = await startPay(test, store.storeCode);
  const old = new Date(Date.now() - 2 * 3600_000);
  for (const c of [stuckPaid, stuckUnpaid]) await fsdb().collection(C.checkouts).doc(c.checkoutId).update({ processingStartedAt: old });
  const createCalls = testStripe.fake.createCalls;
  const refundsBefore = testStripe.fake.refunds.size;
  r = await monitor({ rt: test });
  for (const c of [stuckPaid, stuckUnpaid]) assert.ok(await alertDoc("checkout_stuck_processing", c.checkoutId), "確定待ちのまま時間を過ぎた注文を検出していません");
  assert.equal(await alertDoc("checkout_stuck_processing", fresh.checkoutId), undefined, "時間を過ぎていない注文を異常にしました");
  a = await alertDoc("stripe_paid_not_confirmed", stuckPaid.checkoutId);
  assert.ok(a, "Stripe で支払い済みなのに未確定の注文を検出していません");
  assert.equal(a.mode, "test");
  assert.equal(await alertDoc("stripe_paid_not_confirmed", stuckUnpaid.checkoutId), undefined);
  // 読み取り専用：確定・決済の記録・再決済・返金をしない
  assert.equal((await fsdb().collection(C.checkouts).doc(stuckPaid.checkoutId).get()).get("status"), "PROCESSING");
  assert.equal((await fsdb().collection(C.transactions).where("checkoutId", "==", stuckPaid.checkoutId).get()).size, 0, "点検が決済を確定しました");
  assert.deepEqual([testStripe.fake.createCalls, testStripe.fake.refunds.size], [createCalls, refundsBefore], "点検が Stripe に書き込みました");
  assert.equal(r.checks.stripeCompared, 2);
  step("確定待ちのまま60分を過ぎた注文と、Stripe で支払い済みなのに未確定の注文を検出（確定・返金・再決済はしない）");

  // ---- 点検の負荷の上限 ----
  const full = r;
  // ページを小さくしても同じ結果（ページ分割の読み落とし・重複が無い）
  r = await monitor({ rt: test, limits: { pageSize: 1 } });
  assert.deepEqual([r.result, r.checks.processing, r.checks.recentTransactions, r.checks.recentSucceededCheckouts], [full.result, full.checks.processing, full.checks.recentTransactions, full.checks.recentSucceededCheckouts]);
  // 件数の上限を超えたら一部未確認（読まなかった残りを異常なしと扱わない）
  r = await monitor({ rt: test, limits: { processing: 1 } });
  assert.equal(r.result, "partial");
  assert.ok(r.unchecked.some((u) => u.includes("確定待ちの注文（上限1件")), JSON.stringify(r.unchecked));
  assert.equal(monitorHealth(await readMonitorStatus(), new Date(), 0).state, "partial");
  r = await monitor({ rt: test, limits: { transactions: 1, checkouts: 1 } });
  assert.equal(r.result, "partial");
  assert.ok(r.unchecked.some((u) => u.includes("占い権利の付与（取引）（上限1件")));
  assert.ok(r.unchecked.some((u) => u.includes("占い権利の付与（注文）（上限1件")));
  // Stripe の照合の件数の上限
  r = await monitor({ rt: test, limits: { stripeLookups: 1 } });
  assert.equal(r.result, "partial");
  assert.equal(r.checks.stripeCompared, 1);
  assert.ok(r.unchecked.some((u) => u.includes("未照合 1件")));
  // 異常の書き込みの上限（件数は数えるが記録しない分を「確認できなかった項目」に出す）
  r = await monitor({ rt: test, limits: { alertWrites: 1 } });
  assert.equal(r.result, "partial");
  assert.ok(r.found > 1);
  assert.ok(r.unchecked.some((u) => u.includes("異常の記録（上限1件")));
  // 時間の上限
  r = await monitor({ rt: test, limits: { deadlineMs: -1 } });
  assert.equal(r.result, "failed");
  assert.equal(monitorHealth(await readMonitorStatus(), new Date(), 0).state, "failed");
  step("点検の上限：ページ分割・件数・Stripe の照合・異常の記録・時間の上限を超えたら「一部未確認」／「失敗」（異常なしにしない）");

  // ---- 点検の途中で Stripe の読み取りに失敗 ----
  testStripe.fake.failPaths = [/^\/v1\/checkout\/sessions\/[^/]+$/];
  r = await monitor({ rt: test });
  testStripe.fake.failPaths = [];
  assert.equal(r.result, "partial");
  assert.ok(r.unchecked.some((u) => u.includes("Stripe での支払いの照合に失敗（2件）")), JSON.stringify(r.unchecked));
  assert.equal(monitorHealth(await readMonitorStatus(), new Date(), 0).state, "partial");
  assert.equal((await fsdb().collection(C.transactions).where("checkoutId", "==", stuckPaid.checkoutId).get()).size, 0);
  step("点検の途中で Stripe の読み取りに失敗 → 一部未確認（ほかの項目は続けて確認）");

  // ================= 4. テストと本番の取り違え =================
  const liveStore = await newStore("監視検証店舗（本番）");
  const liveStuck = await startPay(live, liveStore.storeCode);
  await fsdb().collection(C.checkouts).doc(liveStuck.checkoutId).update({ processingStartedAt: old });
  r = await monitor({ rt: test });
  assert.equal(r.result, "partial");
  assert.ok(r.unchecked.some((u) => u.includes("モードの違う注文")), JSON.stringify(r.unchecked));
  assert.equal(await alertDoc("stripe_paid_not_confirmed", liveStuck.checkoutId), undefined);
  assert.equal((await alertDoc("checkout_stuck_processing", liveStuck.checkoutId))!.mode, "live");
  assert.equal(monitorHealth(await readMonitorStatus(), new Date(), 0).state, "partial", "テストの接続で本番の注文を照合できなかったのに「異常なし」になりました");
  // Stripe の接続が無いときも「一部未確認」
  r = await monitor({ rt: null });
  assert.equal(r.result, "partial");
  assert.ok(r.unchecked.some((u) => u.includes("接続なし")));
  // 本番の接続ではテストの注文を照合しない
  await liveStripe.ctl(`pay/${liveStuck.sessionId}`);
  r = await monitor({ rt: live });
  assert.equal(r.result, "partial");
  assert.equal((await alertDoc("stripe_paid_not_confirmed", liveStuck.checkoutId))!.mode, "live");
  const liveOnly = (await listPaymentAlerts({ mode: "live" })).rows;
  const testOnly = (await listPaymentAlerts({ mode: "test" })).rows;
  assert.ok(liveOnly.length > 0 && liveOnly.every((x) => x.mode === "live"));
  assert.ok(testOnly.every((x) => x.mode === "test") && !testOnly.some((x) => x.checkoutId === liveStuck.checkoutId));
  step("モードの違う注文は照合せず「一部未確認」。記録はテスト／本番で分かれる");
  // 以降の点検の邪魔にならないよう、確認用の注文を閉じる
  for (const c of [stuckPaid, stuckUnpaid, fresh, liveStuck]) await fsdb().collection(C.checkouts).doc(c.checkoutId).update({ status: "EXPIRED" });

  // ================= 5. Webhook の署名の不正 =================
  const bucket = hourBucket(new Date());
  for (let i = 0; i < 3; i++) {
    const res = await webhook(test, "charge.refunded", { id: "ch_should_not_be_saved_4242", object: "charge", billing_details: { email: "x@example.com" } }, { secret: "whsec_wrong_value" });
    assert.equal(res.status, 400);
  }
  const res2 = await webhook(test, "charge.refunded", { id: "ch_x" }, { signature: "t=1,v1=deadbeef" });
  assert.equal(res2.status, 400);
  a = await alertDoc("webhook_signature_invalid", `stripe:${bucket}`);
  assert.ok(a, "署名を確認できない通知が記録されていません");
  assert.deepEqual([a.sampled, a.mode], [true, "unknown"]);
  assert.ok(a.observedCount >= 1 && a.observedCount <= 4, "観測した件数が実際の件数を超えました");
  const writesBefore = a.occurrences;
  // 大量の不正な通知と、正常な通知が同時に届く
  const flood = await startPay(test, store.storeCode);
  await testStripe.ctl(`pay/${flood.sessionId}`);
  const t0 = Date.now();
  const [floodRes, validRes] = await Promise.all([
    Promise.all(Array.from({ length: 500 }, (_, i) => webhook(test, "charge.refunded", { id: `ch_flood_${i}` }, { signature: `t=${i},v1=flood` }))),
    webhook(test, "checkout.session.completed", { id: flood.sessionId, object: "checkout.session" }),
  ]);
  const floodMs = Date.now() - t0;
  assert.ok(floodRes.every((x) => x.status === 400));
  assert.equal(outcomeOf(validRes), "confirmed", "大量の不正な通知の間に、正常な通知を処理できませんでした");
  // 間引いた通知は Firestore を待たずに応答する（書き込みが集中すると、記録の待ち時間（最大3秒）で応答が遅れる）
  assert.ok(floodMs < 2_000, `不正な通知の処理に時間がかかりすぎます（${floodMs}ms。書き込みが間引かれていない可能性）`);
  await new Promise((ok) => setTimeout(ok, 3_500)); // 時間切れの後に遅れて反映される書き込みも待つ
  a = await alertDoc("webhook_signature_invalid", `stripe:${bucket}`);
  assert.ok(a!.occurrences - writesBefore <= 1, `不正な通知500件で記録を${a!.occurrences - writesBefore}回書き込みました（間引かれていません）`);
  assert.ok(a!.observedCount <= 504, "観測した件数が実際の件数を超えました");
  assert.doesNotMatch(JSON.stringify(a), SECRET_RE, "署名・通知の中身を保存しました");
  assert.equal((await fsdb().collection(C.paymentAlerts).where("kind", "==", "webhook_signature_invalid").get()).size, 1, "署名の不正が1時間に1件にまとまっていません");
  step(`署名を確認できない通知：500件が同時に届いても書き込みは間引かれ、正常な通知は処理できる（${floodMs}ms。件数は「少なくとも」。署名・中身は保存しない）`);

  // ================= 6. 返金・異議申し立ての反映の失敗 =================
  const rf = await paid(test, testStripe, store.storeCode);
  await testStripe.ctl(`refund/${rf.charge}`);
  testStripe.fake.failPaths = [/^\/v1\/(charges|refunds|payment_intents|disputes)/];
  const refundEvent = `evt_mon_refund_${Date.now()}`;
  assert.equal((await webhook(test, "charge.refunded", { id: rf.charge, object: "charge" }, { eventId: refundEvent })).status, 500);
  assert.equal((await webhook(test, "charge.refunded", { id: rf.charge, object: "charge" }, { eventId: refundEvent })).status, 500, "再送も失敗するはず");
  a = await alertDoc("refund_sync_failed", refundEvent);
  assert.ok(a, "返金の反映の失敗が記録されていません");
  assert.deepEqual([a.status, a.occurrences, a.mode, a.eventType], ["OPEN", 2, "test", "charge.refunded"]);
  assert.doesNotMatch(JSON.stringify(a), SECRET_RE);
  const dpRes = await testStripe.ctl(`dispute/${rf.charge}`);
  const disputeEvent = `evt_mon_dispute_${Date.now()}`;
  assert.equal((await webhook(test, "charge.dispute.created", { id: dpRes.dispute, object: "dispute", charge: rf.charge }, { eventId: disputeEvent })).status, 500);
  assert.ok(await alertDoc("dispute_sync_failed", disputeEvent), "異議申し立ての反映の失敗が記録されていません");
  // Stripe の障害が直り、再送で反映される（記録は未確認のまま残る：運営が確認する）
  testStripe.fake.failPaths = [];
  assert.equal(outcomeOf(await webhook(test, "charge.refunded", { id: rf.charge, object: "charge" }, { eventId: refundEvent })), "refunded");
  assert.equal((await alertDoc("refund_sync_failed", refundEvent))!.status, "OPEN");
  step("返金・異議申し立ての反映の失敗を通知ごとに1件で記録（Stripe の再送は回数だけ増える）");

  // ================= 7. 精算の確定の失敗 =================
  const setStore = await newStore("監視検証店舗（精算）");
  const now = jstYearMonth(new Date());
  const [Ma, Mb] = [shiftYearMonth(now, -2), shiftYearMonth(now, -1)];
  const s1 = await paid(live, liveStripe, setStore.storeCode, Ma);
  const s2 = await paid(live, liveStripe, setStore.storeCode, Ma);
  await generateSettlements(Ma, SYSTEM);
  await updateSettlementStatus(`${setStore.id}_${Ma}`, "PAID", "", SYSTEM);
  for (const s of [s1, s2]) {
    await liveStripe.ctl(`refund/${s.charge}`);
    assert.equal(outcomeOf(await webhook(live, "charge.refunded", { id: s.charge, object: "charge" })), "refunded");
  }
  await paid(live, liveStripe, setStore.storeCode, Mb);
  await generateSettlements(Mb, SYSTEM);
  const sidB = `${setStore.id}_${Mb}`;
  // 繰越の記録と同じ ID の記録を先に作り、確定の書き込みを失敗させる
  await fsdb().collection(C.settlementAdjustments).doc(`carry_${sidB}`).set({ storeId: "dummy", amount: 0, status: "VOID" });
  await assert.rejects(updateSettlementStatus(sidB, "PROCESSING", "", SYSTEM));
  a = await alertDoc("settlement_lock_failed", sidB);
  assert.ok(a, "精算の確定の失敗が記録されていません");
  assert.deepEqual([a.mode, a.settlementId, a.storeId], ["live", sidB, setStore.id]);
  assert.equal((await fsdb().collection(C.settlements).doc(sidB).get()).get("status"), "UNPAID", "失敗した確定が途中まで反映されました");
  await fsdb().collection(C.settlementAdjustments).doc(`carry_${sidB}`).delete();
  await updateSettlementStatus(sidB, "PROCESSING", "", SYSTEM);
  r = await monitor({ rt: live });
  assert.equal(await alertDoc("settlement_inconsistent", sidB), undefined, "正しい精算を食い違いにしました");
  // 確定済みの精算の金額の食い違い
  await fsdb().collection(C.settlements).doc(sidB).update({ storeShare: 999 });
  await monitor({ rt: live });
  a = await alertDoc("settlement_inconsistent", sidB);
  assert.ok(a, "確定済みの精算の金額の食い違いを検出していません");
  assert.equal(a.amount, 30 - 999);
  step("精算の確定の失敗（途中まで反映しない）と、確定済みの精算の金額の食い違いを記録");

  // ================= 8. 確認済み・監査ログ・再発 =================
  const lostId = paymentAlertId("paid_without_entitlement", lost.txId);
  const opId = await createOperator({ name: "監視検証運営", email: `mon-op-${Date.now()}@example.test`, password: "MonitorOperator123" });
  assert.equal(await resolvePaymentAlert(lostId, { userId: opId, role: "OPERATOR" }), true);
  assert.equal(await resolvePaymentAlert(lostId, { userId: opId, role: "OPERATOR" }), false, "確認済みを二重に記録しました");
  const audits = await fsdb().collection(C.auditLogs).where("action", "==", "payment_alert.resolved").where("targetId", "==", lostId).get();
  assert.equal(audits.size, 1, "確認の操作が監査ログに残っていません");
  assert.equal(audits.docs[0].get("actorUserId"), opId);
  assert.equal((await listPaymentAlerts({ status: "RESOLVED" })).rows.some((x) => x.id === lostId), true);
  assert.equal((await listPaymentAlerts({ status: "OPEN" })).rows.some((x) => x.id === lostId), false);
  await monitor({ rt: test });
  a = await alertDoc("paid_without_entitlement", lost.txId);
  assert.deepEqual([a!.status, a!.resolvedBy], ["OPEN", null], "確認済みの後にまた起きた異常が未確認に戻っていません");
  step("確認済みにすると監査ログに残る。同じ異常がまた起きたら未確認に戻る");

  // ================= 8b. 異常の一覧が上限を超えたときの表示順 =================
  const oldBase = Date.now() - 30 * 86_400_000;
  const batch = fsdb().batch();
  for (let i = 0; i < 210; i++) {
    const at = new Date(oldBase - i * 60_000);
    batch.set(fsdb().collection(C.paymentAlerts).doc(`bulk_open_${i}`), { kind: "checkout_stuck_processing", objectType: "checkout", objectId: `bulk_${i}`, mode: "test", status: "OPEN", occurrences: 1, firstSeenAt: at, lastSeenAt: at, resolvedAt: null, resolvedBy: null });
  }
  for (let i = 0; i < 20; i++) {
    const at = new Date(Date.now() - i * 1000); // 確認済みの方が新しい（それでも未確認を先に出す）
    batch.set(fsdb().collection(C.paymentAlerts).doc(`bulk_resolved_${i}`), { kind: "checkout_stuck_processing", objectType: "checkout", objectId: `bulk_r_${i}`, mode: "test", status: "RESOLVED", occurrences: 1, firstSeenAt: at, lastSeenAt: at, resolvedAt: at, resolvedBy: opId });
  }
  await batch.commit();
  const sorted = (rows: { lastSeenAt: Date | null }[]) => rows.every((x, i) => i === 0 || (rows[i - 1].lastSeenAt?.getTime() ?? 0) >= (x.lastSeenAt?.getTime() ?? 0));
  const allList = await listPaymentAlerts({});
  assert.equal(allList.rows.length, PAYMENT_ALERT_LIST_LIMIT);
  assert.equal(allList.truncated, true);
  assert.ok(allList.rows.every((x) => x.status === "OPEN"), "未確認が上限を超えているのに、確認済みを表示しました");
  assert.ok(sorted(allList.rows), "最後の発生日時の新しい順ではありません");
  assert.ok(!allList.rows[0].id.startsWith("bulk_"), "新しい異常が先頭にありません");
  const openList = await listPaymentAlerts({ status: "OPEN" });
  assert.deepEqual([openList.rows.length, openList.truncated], [PAYMENT_ALERT_LIST_LIMIT, true]);
  assert.ok(sorted(openList.rows));
  const resolvedList = await listPaymentAlerts({ status: "RESOLVED" });
  assert.ok(resolvedList.rows.length >= 20 && resolvedList.rows.every((x) => x.status === "RESOLVED") && sorted(resolvedList.rows));
  // 上限より少なければ、未確認 → 確認済み の順で全件
  const small = await listPaymentAlerts({ limit: 500 });
  const firstResolved = small.rows.findIndex((x) => x.status === "RESOLVED");
  assert.ok(firstResolved > 0 && small.rows.slice(firstResolved).every((x) => x.status === "RESOLVED"), "未確認が先に並んでいません");
  assert.ok(sorted(small.rows.slice(0, firstResolved)) && sorted(small.rows.slice(firstResolved)));
  assert.equal(small.truncated, false);
  const liveList = await listPaymentAlerts({ mode: "live" });
  assert.ok(liveList.rows.every((x) => x.mode === "live") && sorted(liveList.rows.filter((x) => x.status === "OPEN")));
  step("異常の一覧：未確認が先・同じ状態は最後の発生日時の新しい順・上限200件を超えたら一部だけ（明示）");

  // ================= 9. 決済の API の 5xx（アプリ経由）・運営画面 =================
  await startApp();
  try {
    // 決済画面を開く API の失敗（Stripe の障害）→ 502 を数える
    testStripe.fake.failPaths = [/^\/v1\/checkout\/sessions$/];
    const buyer = new Client();
    for (let i = 0; i < 2; i++) {
      buyer.jar.delete("fx_access");
      await buyer.req(`/s/${store.storeCode}`);
      const c = await buyer.req("/api/checkout", { method: "POST", json: { fortuneType: "ZODIAC" } });
      assert.equal(c.status, 201, await c.clone().text());
      const s = await buyer.req("/api/checkout/stripe-session", { method: "POST", json: {} });
      assert.equal(s.status, 502, await s.clone().text());
    }
    testStripe.fake.failPaths = [];
    a = await alertDoc("payment_api_5xx", `stripe_session:${hourBucket(new Date())}`);
    assert.ok(a, "決済の API の 5xx が記録されていません");
    assert.ok(a.occurrences >= 2 && a.httpStatus === 502 && a.route === "stripe_session");
    for (let i = 0; i < 5; i++) await notePaymentApiError("checkout", 500, "Error");
    assert.ok((await alertDoc("payment_api_5xx", `checkout:${hourBucket(new Date())}`))!.occurrences >= 5);
    // アプリの Webhook の受け口で署名の不正
    const bad = await fetch(`${BASE}/api/webhooks/stripe`, { method: "POST", headers: { "stripe-signature": "t=1,v1=bad", "content-type": "application/json" }, body: JSON.stringify({ id: "evt_bad", type: "charge.refunded" }) });
    assert.equal(bad.status, 400);
    step("決済の API の 5xx を API・1時間ごとに数える（5回以上は「多発」）");

    const op = await loggedIn(opId);
    let html = await (await op.req("/admin/payment-monitor")).text();
    assert.match(html, /決済監視/);
    assert.match(html, /data-monitor-health="(issues|partial)"/);
    assert.doesNotMatch(html, /data-monitor-health="ok"/, "未確認の異常があるのに「異常なし」と表示しました");
    assert.match(html, /今すぐ点検/);
    assert.match(html, /多発/);
    assert.match(html, /data-alert-sampled="true"/);
    assert.match(html, /少なくとも/);
    assert.match(html, /正確な総数ではありません/);
    assert.match(html, /href="\/admin\/payment-reviews"/);
    assert.match(html, /data-alert-mode="live"/);
    assert.match(html, /data-alert-mode="test"/);
    assert.doesNotMatch(html, /sk_(test|live)_|whsec_|t=1,v1=/, "秘密情報を表示しました");
    assert.match(html, /data-alerts-truncated="true"/, "上限を超えたのに件数の制限を表示していません");
    assert.match(html, /一部だけを表示しています/);
    const allHtml = await (await op.req("/admin/payment-monitor?status=all")).text();
    assert.match(allHtml, /data-alerts-truncated="true"/);
    assert.doesNotMatch(allHtml.slice(allHtml.indexOf("<tbody")), />確認済み</, "未確認が上限を超えているのに、確認済みを表示しました");
    const liveHtml = await (await op.req("/admin/payment-monitor?status=all&mode=live")).text();
    assert.doesNotMatch(liveHtml, /data-alert-mode="test"/, "本番の絞り込みにテストの記録が出ました");
    const resolvedHtml = await (await op.req("/admin/payment-monitor?status=RESOLVED")).text();
    assert.doesNotMatch(resolvedHtml, /確認済みにする/);
    const reviews = await (await op.req("/admin/payment-reviews")).text();
    assert.match(reviews, /href="\/admin\/payment-monitor"/);
    const nav = await (await op.req("/admin")).text();
    assert.match(nav, /href="\/admin\/payment-monitor"/);
    step("運営画面：監視の状態・未確認／確認済み／すべて・モードの絞り込み・決済要確認との相互リンク（秘密情報は出さない）");

    // 監視が止まっている（最後の点検が古い）
    await fsdb().collection(C.system).doc("paymentMonitor").update({ lastStartedAt: new Date(Date.now() - 48 * 3600_000), lastFinishedAt: new Date(Date.now() - 48 * 3600_000), lastResult: "ok", unchecked: [] });
    html = await (await op.req("/admin/payment-monitor")).text();
    assert.match(html, /data-monitor-health="stale"/);
    assert.match(html, /監視が止まっている可能性/);
    step("最後の点検が古いときは「監視が止まっている可能性」と表示");

    // 店舗アカウントからは見えない・ログインなしはログイン画面へ
    const storeUserId = await createStoreUser(store.id, { name: "監視検証店舗ユーザー", email: `mon-store-${Date.now()}@example.test`, password: "MonitorStore12345" }, SYSTEM);
    const su = await loggedIn(storeUserId);
    assert.equal((await su.req("/admin/payment-monitor")).status, 404);
    const anon = await new Client().req("/admin/payment-monitor");
    assert.ok([303, 307, 302].includes(anon.status), String(anon.status));
    step("店舗アカウントには 404・ログインなしはログイン画面へ");
  } finally {
    await stopApp();
  }

  await testStripe.stop();
  await liveStripe.stop();
  console.log("Payment monitor E2E: all checks passed");
}

main().then(
  () => process.exit(0),
  async (e) => {
    console.error(e);
    await stopApp();
    process.exit(1);
  },
);
