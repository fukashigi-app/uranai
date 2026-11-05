/**
 * 新規の決済の受付の停止（STRIPE_NEW_CHECKOUT）の E2E 検証。
 * 受付を止めても、Stripe との接続（鍵・Webhook の署名の秘密）は残り、既存の決済の Webhook（決済確定・返金・異議申し立て）・
 * 戻り先での確定・定期処理（Webhook の復旧・再確認の回収・決済監視）が続くこと、停止・再開で既存の記録が変わらないことを確かめる。
 * Firestore Emulator の demo- プロジェクトと、このスクリプトが起動する「Stripe API の模擬サーバー」（localhost）だけを使う。
 * 本物の Stripe・本番の Firebase・Discord には一切接続しない。キーはすべて形だけの偽物。
 *
 * 設定ごとにアプリ（next start）をこのスクリプトが起動し直す（受付 on → off → on → off）。
 *
 *   firebase emulators:start --only firestore --project demo-uranai
 *   （別ターミナル）npm run build && FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 FIREBASE_PROJECT_ID=demo-uranai-new-checkout npm run e2e:stripe-new-checkout-pause
 */
import "dotenv/config";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import Stripe from "stripe";
import { createFakeStripe } from "./lib/fake-stripe";
import { C, fsdb } from "@/lib/firestore/admin";
import { dataProvider } from "@/lib/data-provider";
import { createStore } from "@/lib/services/stores";
import { randomToken } from "@/lib/security/crypto";

const PORT = Number(process.env.E2E_PAUSE_PORT ?? 3220);
const BASE = `http://localhost:${PORT}`;
const STRIPE_PORT = 12117;
const SECRET_KEY = "sk_test_e2e_pause_dummy";
const WEBHOOK_SECRET = "whsec_e2e_pause_dummy";
const CRON_SECRET = `e2e-pause-cron-${randomToken(24)}`;
const SESSION_SECRET = `e2e-pause-${randomToken(24)}`;
const SYSTEM = { userId: null, role: "SYSTEM" as const };
const HOUR = 3600_000;
const step = (msg: string) => console.log(`  ✓ ${msg}`);

const fakeStripe = createFakeStripe({ port: STRIPE_PORT, mode: "test", apiKey: SECRET_KEY });
const { fake, ctl } = fakeStripe;

// ================= アプリの起動（設定ごと） =================
function appEnv(overrides: Record<string, string>): NodeJS.ProcessEnv {
  const e: NodeJS.ProcessEnv = {
    ...process.env,
    PORT: String(PORT),
    APP_URL: BASE,
    DB_PROVIDER: "firestore",
    SESSION_SECRET,
    SITE_STATUS: "open",
    PAYMENT_PROVIDER: "stripe",
    ENABLE_TEST_PAYMENT: "false",
    ALLOW_MOCK_PAYMENTS_IN_PRODUCTION: "false",
    STRIPE_TEST_CHECKOUT: "on",
    STRIPE_SECRET_KEY: SECRET_KEY,
    STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET,
    STRIPE_API_BASE: `http://127.0.0.1:${STRIPE_PORT}`,
    STRIPE_LIVE_CHECKOUT: "",
    STRIPE_LIVE_OPERATOR_TEST: "",
    CRON_SECRET,
    OPS_ALERT_WEBHOOK_URL: "", // Discord には送らない
    ...overrides,
  };
  delete e.VERCEL_ENV;
  delete e.VERCEL_URL;
  delete e.VERCEL_BRANCH_URL;
  return e;
}

let app: ChildProcess | null = null;
async function startApp(label: string, overrides: Record<string, string>) {
  await stopApp();
  const child = spawn("node_modules/.bin/next", ["start", "-p", String(PORT)], { env: appEnv(overrides), stdio: ["ignore", "pipe", "pipe"] });
  let log = "";
  child.stdout!.on("data", (d) => (log += d));
  child.stderr!.on("data", (d) => (log += d));
  app = child;
  for (let i = 0; i < 120; i++) {
    if (child.exitCode !== null) throw new Error(`アプリが起動しませんでした（${label}）\n${log.slice(-2000)}`);
    try {
      const r = await fetch(`${BASE}/api/health`);
      if (r.status > 0) {
        console.log(`  … アプリを起動（${label}）`);
        return;
      }
    } catch {
      /* 起動待ち */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`アプリが起動しませんでした（${label}）`);
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

// ================= 利用者 =================
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

const signer = new Stripe(SECRET_KEY);
let evN = 0;
async function webhook(type: string, object: Record<string, unknown>, opts: { eventId?: string; livemode?: boolean; secret?: string } = {}) {
  const payload = JSON.stringify({ id: opts.eventId ?? `evt_test_pause_${++evN}_${Date.now()}`, object: "event", type, livemode: opts.livemode ?? false, data: { object } });
  const header = signer.webhooks.generateTestHeaderString({ payload, secret: opts.secret ?? WEBHOOK_SECRET });
  return fetch(`${BASE}/api/webhooks/stripe`, { method: "POST", headers: { "stripe-signature": header, "content-type": "application/json" }, body: payload });
}
const outcome = async (r: Response) => ((await r.json()) as { outcome?: string }).outcome;

async function order(c: Client, storeCode: string) {
  c.jar.delete("fx_access");
  c.ip = `203.0.113.${Math.floor(Math.random() * 250) + 1}`;
  await c.req(`/s/${storeCode}`);
  return c.req("/api/checkout", { method: "POST", json: { fortuneType: "ZODIAC" } });
}
async function startPurchase(c: Client, storeCode: string) {
  let r = await order(c, storeCode);
  assert.equal(r.status, 201, await r.clone().text());
  const { checkoutId } = (await r.json()) as { checkoutId: string };
  r = await c.req("/api/checkout/stripe-session", { method: "POST", json: {} });
  assert.equal(r.status, 200, await r.clone().text());
  const j = (await r.json()) as { status: string; url: string };
  assert.equal(j.status, "redirect");
  return { checkoutId, sessionId: j.url.split("/").pop()! };
}
const txOf = async (checkoutId: string) => (await fsdb().collection(C.transactions).where("checkoutId", "==", checkoutId).get()).docs;
const countOf = async (col: string) => (await fsdb().collection(col).count().get()).data().count;

/** 既存の決済の記録（注文・決済記録・占い権利・占い結果・精算）の中身と更新の時刻。停止・再開で変わらないことを確かめる */
async function snapshot(): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const col of [C.checkouts, C.transactions, C.fortuneSessions, C.fortuneResults, C.settlements]) {
    for (const d of (await fsdb().collection(col).get()).docs) out[`${col}/${d.id}`] = `${d.updateTime.toMillis()}|${JSON.stringify(d.data())}`;
  }
  return out;
}

async function main() {
  const host = process.env.FIRESTORE_EMULATOR_HOST ?? "";
  assert.match(host, /^(127\.0\.0\.1|localhost|\[::1\]):\d+$/, "FIRESTORE_EMULATOR_HOST（localhost の Emulator）が必要です");
  assert.match(process.env.FIREBASE_PROJECT_ID ?? "", /^demo-/, "FIREBASE_PROJECT_ID は demo- で始まる Emulator 用の ID にしてください");
  assert.ok(!process.env.VERCEL_ENV, "Vercel 上では実行しません");
  process.env.DB_PROVIDER = "firestore";
  assert.equal(dataProvider(), "firestore");
  await fakeStripe.start();
  console.log(`Stripe new-checkout pause E2E against ${BASE} (emulator ${host} / ${process.env.FIREBASE_PROJECT_ID}, fake Stripe :${STRIPE_PORT})`);

  const stamp = Date.now();
  const store = await createStore({ name: `受付停止検証店舗 ${stamp}`, contactName: "", postalCode: "", address: "", phone: "", email: "" }, SYSTEM);

  // ================= 1. 受付 on：新規の決済を作れる =================
  await startApp("STRIPE_NEW_CHECKOUT=on", { STRIPE_NEW_CHECKOUT: "on" });
  let health = (await (await fetch(`${BASE}/api/health`)).json()) as Record<string, string>;
  assert.match(health.stripeNewCheckout, /^accepting/);
  assert.match(health.stripeConnection, /^test/);
  const gA = new Client();
  const pA = await startPurchase(gA, store.storeCode); // 決済済みにする（後で返金）
  await ctl(`pay/${pA.sessionId}`, { fee: 4 });
  assert.equal(await outcome(await webhook("checkout.session.completed", { id: pA.sessionId, object: "checkout.session" })), "confirmed");
  const gB = new Client();
  const pB = await startPurchase(gB, store.storeCode); // 決済画面を作っただけ（受付の停止の後に支払われる）
  const gC = new Client();
  let r = await order(gC, store.storeCode); // 注文だけ（決済画面はまだ）
  assert.equal(r.status, 201);
  const cC = ((await r.json()) as { checkoutId: string }).checkoutId;
  const txA = (await txOf(pA.checkoutId))[0];
  assert.equal(txA.get("paymentStatus"), "SUCCEEDED");
  step("受付 on：注文 → 決済画面（Checkout Session）を作成でき、支払いの通知で決済記録・占い権利を作る");

  // ================= 2. 受付 off：新規の決済は作らない。既存の記録は変わらない =================
  const snap0 = await snapshot();
  await startApp("STRIPE_NEW_CHECKOUT=off", { STRIPE_NEW_CHECKOUT: "off" });
  health = (await (await fetch(`${BASE}/api/health`)).json()) as Record<string, string>;
  assert.equal(health.stripeNewCheckout, "stopped (new_checkout_off)");
  assert.match(health.stripeConnection, /^test/, "受付の停止で Stripe との接続まで止まっています");
  assert.match(health.paymentMode, /新規の決済の受付を停止中/);
  const checkoutsBefore = await countOf(C.checkouts);
  const createsBefore = fake.createCalls;
  const gN = new Client();
  r = await order(gN, store.storeCode);
  assert.equal(r.status, 503);
  assert.deepEqual(((await r.json()) as { error: { code: string } }).error.code, "payment_paused");
  // 注文だけ作ってあった人・決済画面を作ってあった人も、新しい決済画面は作らない・既存の決済画面にも移動させない
  for (const g of [gC, gB]) {
    r = await g.req("/api/checkout/stripe-session", { method: "POST", json: {} });
    assert.equal(r.status, 503);
    const j = (await r.json()) as { error: { code: string; message: string } };
    assert.equal(j.error.code, "payment_paused");
    assert.match(j.error.message, /新しいお支払いの受付を一時停止/);
  }
  const html = await (await gC.req("/payment")).text();
  assert.match(html, /新しいお支払いの受付を一時停止しています/);
  assert.doesNotMatch(html, /同意して100円を支払う/, "受付の停止中に支払いのボタンが表示されています");
  assert.equal(fake.createCalls, createsBefore, "受付の停止中に Checkout Session を作成しました");
  assert.equal(await countOf(C.checkouts), checkoutsBefore, "受付の停止中に注文を作りました");
  assert.deepEqual(await snapshot(), snap0, "受付の停止で既存の記録が変わりました");
  assert.equal((await fsdb().collection(C.checkouts).doc(cC).get()).get("status"), "CREATED");
  step("受付 off：注文は 503（payment_paused）、決済画面の作成・既存の決済画面への移動も 503（Stripe API を呼ばない）。案内を表示。注文・Session は増えず、既存の記録は変わらない");

  // ================= 3. 停止中も Webhook で決済確定（停止の前に作った決済画面での支払い）。重複は1件のまま =================
  await ctl(`pay/${pB.sessionId}`, { fee: 4 });
  const objB = { id: pB.sessionId, object: "checkout.session" };
  r = await webhook("checkout.session.completed", objB, { eventId: "evt_pause_dup_1" });
  assert.equal(r.status, 200);
  assert.equal(await outcome(r), "confirmed", "受付の停止中に正当な決済確定の通知を処理できません");
  r = await webhook("checkout.session.completed", objB, { eventId: "evt_pause_dup_1" });
  assert.deepEqual(await r.json(), { received: true, duplicate: true });
  assert.equal(await outcome(await webhook("checkout.session.completed", objB)), "duplicate");
  const txsB = await txOf(pB.checkoutId);
  assert.equal(txsB.length, 1, "決済記録が1件ではありません");
  const txB = txsB[0];
  assert.deepEqual([txB.get("paymentStatus"), txB.get("amount"), txB.get("storeShare"), txB.get("operatorShare"), txB.get("livemode"), txB.get("countable")], ["SUCCEEDED", 100, 30, 70, false, false]);
  assert.equal((await fsdb().collection(C.fortuneSessions).where("transactionId", "==", txB.id).get()).size, 1);
  // 戻り先での確定も続く（支払い済みのお客さんは占いへ進める）・停止中も支払い済みの占いを使える
  r = await gB.req(`/payment/return?session_id=${pB.sessionId}`);
  assert.ok([303, 307, 308].includes(r.status), `受付の停止中に戻り先で確定できません（${r.status}）`);
  assert.match(r.headers.get("location") ?? "", /\/fortune\/input$/);
  r = await gB.req("/api/fortune", { method: "POST", json: { type: "ZODIAC", sign: "leo" } });
  assert.equal(r.status, 200, await r.clone().text());
  assert.equal((await fsdb().collection(C.fortuneSessions).doc(txB.id).get()).get("status"), "USED");
  assert.equal(fake.createCalls, createsBefore, "決済確定で Checkout Session を作成しました");
  step("停止中も、停止の前の決済画面で支払われた決済を Webhook で確定（200・confirmed）。同じ通知・別の通知の再送は1件のまま。戻り先の確定・支払い済みの占いの利用も続く");

  // ================= 4. 停止中も返金の通知を処理 =================
  await ctl(`refund/${txA.get("stripeChargeId")}`);
  r = await webhook("charge.refunded", { id: txA.get("stripeChargeId"), object: "charge" });
  assert.equal(r.status, 200);
  assert.equal(await outcome(r), "refunded", "受付の停止中に返金の通知を処理できません");
  let tA = (await fsdb().collection(C.transactions).doc(txA.id).get()).data()!;
  assert.deepEqual([tA.paymentStatus, tA.countable, tA.amountRefunded], ["REFUNDED", false, 100]);
  assert.equal((await fsdb().collection(C.checkouts).doc(pA.checkoutId).get()).get("status"), "REFUNDED");
  assert.equal(await outcome(await webhook("charge.refunded", { id: txA.get("stripeChargeId"), object: "charge" })), "unchanged"); // 再送は何もしない
  tA = (await fsdb().collection(C.transactions).doc(txA.id).get()).data()!;
  assert.equal(tA.amountRefunded, 100, "返金の再送で二重に減らしました");
  step("停止中も返金の通知を処理（REFUNDED・売上の対象外）。再送は unchanged で二重に反映しない");

  // ================= 5. 停止中も異議申し立ての通知を処理 =================
  const dp = await ctl(`dispute/${txB.get("stripeChargeId")}`);
  r = await webhook("charge.dispute.created", { id: dp.dispute, object: "dispute", charge: txB.get("stripeChargeId") });
  assert.equal(r.status, 200);
  assert.equal(await outcome(r), "dispute_open", "受付の停止中に異議申し立ての通知を処理できません");
  assert.equal((await fsdb().collection(C.transactions).doc(txB.id).get()).get("disputeStatus"), "open");
  step("停止中も異議申し立ての通知を処理（dispute_open を記録）");

  // ================= 6. 署名の不一致・本番の通知は拒否（停止中も署名の確認は弱めない） =================
  r = await webhook("checkout.session.completed", objB, { secret: "whsec_wrong_secret" });
  assert.equal(r.status, 400);
  r = await webhook("checkout.session.completed", objB, { livemode: true });
  assert.equal(r.status, 400);
  r = await fetch(`${BASE}/api/webhooks/stripe`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  assert.equal(r.status, 400); // 署名なし
  step("停止中も、署名の不一致・署名なし・本番（livemode=true）の通知は 400 で拒否（記録しない）");

  // ================= 7. 停止中も定期処理（Webhook の復旧・再確認の回収・決済監視）が動く =================
  // 決済確定の後の再確認だけが失敗した決済（PENDING）を、停止中に作る → 定期処理の自動の回収で終わらせる
  const gD = new Client();
  await startApp("STRIPE_NEW_CHECKOUT=on（再確認の前提の決済の作成）", { STRIPE_NEW_CHECKOUT: "on" });
  const pD = await startPurchase(gD, store.storeCode);
  await startApp("STRIPE_NEW_CHECKOUT=off（定期処理）", { STRIPE_NEW_CHECKOUT: "off" });
  await ctl(`pay/${pD.sessionId}`, { fee: 4 });
  fake.failCalls.push({ path: /^\/v1\/refunds$/, method: "GET", skip: 1, count: 1 }); // 事前の読み取りは通し、再確認の読み取りだけ失敗
  r = await webhook("checkout.session.completed", { id: pD.sessionId, object: "checkout.session" });
  assert.equal(r.status, 500, "（前提）再確認の失敗で Webhook が 500 を返していません");
  const txD = (await txOf(pD.checkoutId))[0];
  assert.equal(txD.get("recheckState"), "PENDING", "（前提）PENDING になっていません");
  await txD.ref.update({ createdAt: new Date(Date.now() - 2 * HOUR) });
  r = await fetch(`${BASE}/api/cron/maintenance`, { headers: { authorization: `Bearer ${CRON_SECRET}` } });
  assert.equal(r.status, 200, await r.clone().text());
  const cron = (await r.json()) as { webhookRecovery: { status: string; reason?: string }; recheckRecovery: { status: string; reason?: string; done?: number }; paymentMonitor: { status: string; stripeMode: string | null } };
  assert.notEqual(cron.webhookRecovery.reason, "stripe_unavailable", "受付の停止で Webhook の復旧が止まりました");
  assert.notEqual(cron.recheckRecovery.reason, "stripe_unavailable", "受付の停止で再確認の回収が止まりました");
  assert.equal(cron.recheckRecovery.done, 1, `再確認の回収が終わりません：${JSON.stringify(cron.recheckRecovery)}`);
  assert.notEqual((await txD.ref.get()).get("recheckState"), "PENDING");
  assert.equal(cron.paymentMonitor.stripeMode, "test", "受付の停止で決済監視が Stripe と照合していません");
  assert.ok(["ok", "issues"].includes(cron.paymentMonitor.status), `決済監視の結果：${cron.paymentMonitor.status}`);
  step("停止中も定期処理が動く：Webhook の復旧・再確認の回収（PENDING → 完了）・決済監視（Stripe と照合）。Stripe の接続は stripe_unavailable にならない");

  // ================= 8. 本番とテストの認証情報の混在は、停止中でも拒否（接続を作らない） =================
  for (const [label, o] of [
    ["本番用キー", { STRIPE_NEW_CHECKOUT: "off", STRIPE_SECRET_KEY: "sk_live_e2e_pause_dummy" }],
    ["本番決済のスイッチ", { STRIPE_NEW_CHECKOUT: "off", STRIPE_LIVE_CHECKOUT: "on" }],
  ] as [string, Record<string, string>][]) {
    await startApp(`混在：${label}`, o);
    r = await webhook("checkout.session.completed", objB);
    assert.equal(r.status, 404, `${label}：混在しているのに Webhook を受け付けました`);
    health = (await (await fetch(`${BASE}/api/health`)).json()) as Record<string, string>;
    assert.match(health.stripeConnection, /^unavailable/, `${label}：混在しているのに接続を作りました`);
    r = await order(new Client(), store.storeCode);
    assert.equal(r.status, 503);
  }
  step("本番用キー・本番決済のスイッチが混ざっていれば、受付の設定に関係なく接続を作らない（Webhook 404・注文 503）");

  // ================= 9. 停止・再開を繰り返しても、既存の記録は変わらない。再開すると新規の決済を作れる =================
  const snap1 = await snapshot();
  for (const v of ["on", "off", "on"]) {
    await startApp(`STRIPE_NEW_CHECKOUT=${v}（繰り返し）`, { STRIPE_NEW_CHECKOUT: v });
    await (await gC.req("/payment")).text();
    await fetch(`${BASE}/api/health`);
    assert.deepEqual(await snapshot(), snap1, `受付の切り替え（${v}）で既存の記録が変わりました`);
  }
  const gR = new Client();
  const pR = await startPurchase(gR, store.storeCode);
  assert.match(pR.sessionId, /^cs_test_/);
  assert.equal(fake.createCalls, createsBefore + 2, "再開の後の Session の作成の回数が想定と違います"); // pD と pR の2つだけ
  step("停止・再開を繰り返しても既存の注文・決済記録・占い権利・占い結果・精算は変わらない。再開すると新規の決済画面を作成できる");

  await stopApp();
  await fakeStripe.stop();
  console.log("\nSTRIPE NEW CHECKOUT PAUSE E2E PASSED");
}

main().catch(async (e) => {
  console.error("\nSTRIPE NEW CHECKOUT PAUSE E2E FAILED:", e);
  await stopApp().catch(() => {});
  await fakeStripe.stop().catch(() => {});
  process.exit(1);
});
