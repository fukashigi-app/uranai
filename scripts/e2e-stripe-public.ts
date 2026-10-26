/**
 * 一般のお客さん（ログインなし）の Stripe Checkout の E2E 検証：店舗の QR → 占いの選択 → 100円の決済 → 入力 → 結果。
 * Firestore Emulator の demo- プロジェクトと、このスクリプトが起動する「Stripe API の模擬サーバー」（localhost）だけを使う。
 * 本物の Stripe・本番の Firebase には一切接続しない。キーはすべて形だけの偽物。
 *
 * 公開状態ごとにアプリ（next start）をこのスクリプトが起動し直す（公開中・開発モード・準備中・本番用キーの混入）。
 *
 *   firebase emulators:start --only firestore --project demo-uranai
 *   （別ターミナル）npm run build && FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 FIREBASE_PROJECT_ID=demo-uranai-stripe-public npm run e2e:stripe-public
 */
import "dotenv/config";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import Stripe from "stripe";
import { createFakeStripe } from "./lib/fake-stripe";
import { C, fsdb } from "@/lib/firestore/admin";
import { dataProvider } from "@/lib/data-provider";
import { createOperator, createStore, setStoreStatus } from "@/lib/services/stores";
import { monthTotals } from "@/lib/services/reports";
import { randomToken, sha256Hex } from "@/lib/security/crypto";
import { jstYearMonth } from "@/lib/time";

const PORT = Number(process.env.E2E_PUBLIC_PORT ?? 3210);
const BASE = `http://localhost:${PORT}`;
const STRIPE_PORT = 12116;
const SECRET_KEY = "sk_test_e2e_public_dummy";
const WEBHOOK_SECRET = "whsec_e2e_public_dummy";
const SYSTEM = { userId: null, role: "SYSTEM" as const };
const step = (msg: string) => console.log(`  ✓ ${msg}`);

const fakeStripe = createFakeStripe({ port: STRIPE_PORT, mode: "test", apiKey: SECRET_KEY });
const { fake, ctl } = fakeStripe;

// ================= アプリの起動（公開状態ごと） =================
/** アプリに渡す設定（.env の PAY.JP・疑似決済の設定は空で上書きして使わない） */
function appEnv(overrides: Record<string, string>): NodeJS.ProcessEnv {
  const e: NodeJS.ProcessEnv = {
    ...process.env,
    PORT: String(PORT),
    APP_URL: BASE,
    DB_PROVIDER: "firestore",
    SESSION_SECRET: `e2e-public-${randomToken(24)}`,
    SITE_STATUS: "open",
    PAYMENT_PROVIDER: "stripe",
    ENABLE_TEST_PAYMENT: "false",
    ALLOW_MOCK_PAYMENTS_IN_PRODUCTION: "false",
    PAYJP_PUBLIC_KEY: "",
    PAYJP_SECRET_KEY: "",
    PAYJP_WEBHOOK_TOKEN: "",
    STRIPE_TEST_CHECKOUT: "on",
    STRIPE_SECRET_KEY: SECRET_KEY,
    STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET,
    STRIPE_API_BASE: `http://127.0.0.1:${STRIPE_PORT}`,
    STRIPE_LIVE_CHECKOUT: "",
    STRIPE_LIVE_OPERATOR_TEST: "",
    ...overrides,
  };
  delete e.VERCEL_ENV;
  delete e.VERCEL_URL;
  delete e.VERCEL_BRANCH_URL;
  return e;
}

let app: ChildProcess | null = null;
async function startApp(label: string, overrides: Record<string, string> = {}) {
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

// ================= アプリの利用者 =================
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

const signer = new Stripe(SECRET_KEY);
let evN = 0;
async function webhook(type: string, object: Record<string, unknown>, opts: { eventId?: string; livemode?: boolean; secret?: string } = {}) {
  const payload = JSON.stringify({ id: opts.eventId ?? `evt_test_pub_${++evN}_${Date.now()}`, object: "event", type, livemode: opts.livemode ?? false, data: { object } });
  const header = signer.webhooks.generateTestHeaderString({ payload, secret: opts.secret ?? WEBHOOK_SECRET });
  return fetch(`${BASE}/api/webhooks/stripe`, { method: "POST", headers: { "stripe-signature": header, "content-type": "application/json" }, body: payload });
}
const outcome = async (r: Response) => ((await r.json()) as { outcome: string }).outcome;

/** 一般のお客さんが店舗の QR を読み、占いを選んで注文し、Stripe の決済画面へ移動するところまで */
async function startPurchase(c: Client, storeCode: string, fortuneType: "ZODIAC" | "BLOOD" | "BIRTHDAY") {
  c.jar.delete("fx_access");
  c.ip = `203.0.113.${Math.floor(Math.random() * 250) + 1}`; // 連続の購入でレート制限にかからないように
  await c.req(`/s/${storeCode}`);
  let r = await c.req("/api/checkout", { method: "POST", json: { fortuneType } });
  assert.equal(r.status, 201, await r.clone().text());
  const { checkoutId } = (await r.json()) as { checkoutId: string };
  r = await c.req("/api/checkout/stripe-session", { method: "POST", json: {} });
  assert.equal(r.status, 200, await r.clone().text());
  const j = (await r.json()) as { status: string; url: string };
  assert.equal(j.status, "redirect");
  return { checkoutId, sessionId: j.url.split("/").pop()!, url: j.url };
}
const txOf = async (checkoutId: string) => (await fsdb().collection(C.transactions).where("checkoutId", "==", checkoutId).get()).docs;
const checkoutOf = async (id: string) => (await fsdb().collection(C.checkouts).doc(id).get()).data()!;
const status = async (c: Client) => ((await (await c.req("/api/checkout/status")).json()) as { status: string }).status;

async function main() {
  const host = process.env.FIRESTORE_EMULATOR_HOST ?? "";
  assert.match(host, /^(127\.0\.0\.1|localhost|\[::1\]):\d+$/, "FIRESTORE_EMULATOR_HOST（localhost の Emulator）が必要です");
  assert.match(process.env.FIREBASE_PROJECT_ID ?? "", /^demo-/, "FIREBASE_PROJECT_ID は demo- で始まる Emulator 用の ID にしてください");
  assert.ok(!process.env.VERCEL_ENV, "Vercel 上では実行しません");
  process.env.DB_PROVIDER = "firestore";
  assert.equal(dataProvider(), "firestore");
  await fakeStripe.start();
  console.log(`Stripe public E2E against ${BASE} (emulator ${host} / ${process.env.FIREBASE_PROJECT_ID}, fake Stripe :${STRIPE_PORT})`);

  const stamp = Date.now();
  const storeA = await createStore({ name: `公開検証店舗A ${stamp}`, contactName: "", postalCode: "", address: "", phone: "", email: "" }, SYSTEM);
  const storeB = await createStore({ name: `公開検証店舗B ${stamp}`, contactName: "", postalCode: "", address: "", phone: "", email: "" }, SYSTEM);
  const storeS = await createStore({ name: `公開検証店舗S ${stamp}`, contactName: "", postalCode: "", address: "", phone: "", email: "" }, SYSTEM);
  // 配分率を店舗ごとに変えられた頃の古い値が店舗のデータに残っていても、新規の決済は全店舗一律の30%
  await fsdb().collection(C.stores).doc(storeA.id).update({ storeShareBps: 4000 });
  await fsdb().collection(C.stores).doc(storeB.id).update({ storeShareBps: 2500 });
  await setStoreStatus(storeS.id, "SUSPENDED", SYSTEM);
  const opId = await createOperator({ name: "公開検証運営", email: `pub-op-${stamp}@example.com`, password: "PublicOperator123" });
  const ym = jstYearMonth(new Date());
  const before = { month: await monthTotals(ym), monthA: await monthTotals(ym, storeA.id), monthB: await monthTotals(ym, storeB.id) };

  // ================= 公開中（SITE_STATUS=open・PAYMENT_PROVIDER=stripe・Sandbox） =================
  await startApp("公開中・PAYMENT_PROVIDER=stripe");

  // ---- 1. QR → 占いの選択（ログインなし・有料の選択画面） ----
  const guest = new Client();
  let r = await guest.req(`/s/${storeA.storeCode}`);
  assert.ok(r.status < 400, `QR の読み込みに失敗（${r.status}）`);
  let html = await (await guest.req("/fortune")).text();
  assert.ok(html.includes(storeA.name), "店舗名が表示されません");
  assert.ok(html.includes("この占いを100円で始める"), "有料の選択画面ではありません");
  assert.ok(!html.includes("テストモード：無料で占う") && !html.includes("Stripeテスト決済"), "無料・運営向けの表示が出ています");
  assert.ok(!guest.jar.get("sid"), "ログインしていないはずです");
  step("ログインなし：店舗の QR → 有料の占いの選択画面（店舗名・100円。無料・運営向けの表示なし）");

  // ---- 2. 注文：金額・店舗はサーバーが決める（リクエストの金額・店舗は受け付けない） ----
  r = await guest.req("/api/checkout", { method: "POST", json: { fortuneType: "ZODIAC", amount: 1, storeId: storeB.id } });
  assert.equal(r.status, 400, "金額・店舗の指定を受け付けました");
  const noQr = new Client();
  r = await noQr.req("/api/checkout", { method: "POST", json: { fortuneType: "ZODIAC" } });
  assert.equal(r.status, 400);
  assert.equal(((await r.json()) as { error: { code: string } }).error.code, "no_store");
  const susp = new Client();
  await susp.req(`/s/${storeS.storeCode}`);
  r = await susp.req("/api/checkout", { method: "POST", json: { fortuneType: "ZODIAC" } });
  assert.ok([403, 404].includes(r.status), `停止中の店舗で注文できました（${r.status}）`);
  const p1 = await startPurchase(guest, storeA.storeCode, "ZODIAC");
  let co = await checkoutOf(p1.checkoutId);
  assert.deepEqual([co.provider, co.amount, co.storeId, co.status, co.providerPaymentId], ["stripe", 100, storeA.id, "PROCESSING", p1.sessionId]);
  const s1 = fake.sessions.get(p1.sessionId)!;
  assert.equal(s1.amount_total, 100);
  assert.deepEqual(s1.metadata, { checkoutId: p1.checkoutId, storeId: storeA.id, fortuneType: "ZODIAC" });
  assert.equal(s1.client_reference_id, p1.checkoutId);
  assert.deepEqual(s1.allowed_payment_method_types, ["card", "paypay"]);
  assert.equal(s1.success_url, `${BASE}/payment/return?session_id={CHECKOUT_SESSION_ID}`);
  assert.equal(s1.cancel_url, `${BASE}/payment?canceled=1`);
  step("注文：金額・店舗の指定は 400、QR なしは no_store、停止中の店舗は不可。注文は provider=stripe・100円・QR の店舗。Session も同じ金額・店舗");

  // ---- 3. 支払い画面の表示・キャンセルして戻る ----
  html = await (await guest.req("/payment")).text();
  assert.ok(html.includes("テスト環境です。実際の請求は発生しません"), "一般のお客さん向けのテストの表示がありません");
  assert.ok(!html.includes("運営アカウントのみ"), "運営向けの表示が一般のお客さんに出ています");
  assert.ok(html.includes("同意して100円を支払う（テスト）"), "購入ボタンの文言が違います");
  html = await (await guest.req("/payment?canceled=1")).text();
  assert.ok(html.includes("お支払いは完了していません"), "キャンセルの表示がありません");
  const created = fake.createCalls;
  r = await guest.req("/api/checkout/stripe-session", { method: "POST", json: {} });
  assert.equal(((await r.json()) as { url: string }).url, p1.url, "キャンセル後に同じ決済画面へ戻れません");
  assert.equal(fake.createCalls, created, "キャンセル後に Session が増えました");
  assert.equal((await txOf(p1.checkoutId)).length, 0);
  step("支払い画面：一般向けのテスト環境の表示（運営向けの表示なし）。キャンセル → 「完了していません」、同じ決済画面へ戻れる（Session は増えない・記録なし）");

  // ---- 4. 支払い前の戻り先は確定しない。PAY.JP のカード決済の入口は Stripe の注文を処理しない ----
  r = await guest.req(`/payment/return?session_id=${p1.sessionId}`);
  assert.match(await r.text(), /お支払いを確認しています/);
  const beforePay = await checkoutOf(p1.checkoutId);
  r = await guest.req("/api/checkout/pay", { method: "POST", json: { cardToken: "tok_e2e_dummy" } });
  assert.notEqual(r.status, 200, "PAY.JP の入口が Stripe の注文を受け付けました");
  assert.notEqual(r.status, 400, "カードトークンの形で弾かれていて、確かめたい処理に届いていません");
  co = await checkoutOf(p1.checkoutId);
  assert.deepEqual([co.status, co.provider, co.attemptCount, co.providerPaymentId], ["PROCESSING", "stripe", beforePay.attemptCount, p1.sessionId], "PAY.JP の入口が Stripe の注文の状態を変えました");
  assert.equal((await txOf(p1.checkoutId)).length, 0);
  // 決済画面へ移動する前の注文（CREATED）も、PAY.JP の入口では PROCESSING にしない
  const guestC = new Client();
  await guestC.req(`/s/${storeA.storeCode}`);
  r = await guestC.req("/api/checkout", { method: "POST", json: { fortuneType: "ZODIAC" } });
  assert.equal(r.status, 201);
  const cC = ((await r.json()) as { checkoutId: string }).checkoutId;
  r = await guestC.req("/api/checkout/pay", { method: "POST", json: { cardToken: "tok_e2e_dummy" } });
  assert.ok(r.status >= 400 && r.status !== 400, `PAY.JP の入口の応答が想定外です（${r.status}）`);
  co = await checkoutOf(cC);
  assert.deepEqual([co.status, co.attemptCount, co.processingStartedAt ?? null], ["CREATED", 0, null], "PAY.JP の入口が CREATED の Stripe の注文を PROCESSING にしました");
  step("支払い前の戻り先は確定しない（確認中）。PAY.JP の入口（/api/checkout/pay）は Stripe の注文（PROCESSING・CREATED とも）を処理せず、状態も変えない");

  // ---- 5. 支払い → 戻り先と Webhook（2通）が同時でも1回だけ記録・権利付与 ----
  await ctl(`pay/${p1.sessionId}`, { fee: 4 });
  const obj1 = { id: p1.sessionId, object: "checkout.session" };
  const [ret, w1, w2] = await Promise.all([guest.req(`/payment/return?session_id=${p1.sessionId}`), webhook("checkout.session.completed", obj1, { eventId: "evt_pub_dup_1" }), webhook("checkout.session.completed", obj1, { eventId: "evt_pub_dup_2" })]);
  assert.ok([303, 307, 308].includes(ret.status), `戻り先が占いの入力へ移動しません（${ret.status}）`);
  assert.match(ret.headers.get("location") ?? "", /\/fortune\/input$/);
  assert.deepEqual([w1.status, w2.status], [200, 200]);
  const txs = await txOf(p1.checkoutId);
  assert.equal(txs.length, 1, "決済記録が1件ではありません");
  const t1 = txs[0];
  assert.deepEqual(
    { provider: t1.get("paymentProvider"), amount: t1.get("amount"), storeId: t1.get("storeId"), storeShare: t1.get("storeShare"), operatorShare: t1.get("operatorShare"), fee: t1.get("paymentFee"), livemode: t1.get("livemode"), countable: t1.get("countable"), status: t1.get("paymentStatus") },
    { provider: "stripe", amount: 100, storeId: storeA.id, storeShare: 30, operatorShare: 70, fee: 4, livemode: false, countable: false, status: "SUCCEEDED" },
  );
  assert.equal(t1.get("storeShareBps"), 3000, "店舗の古い配分率（40%）が使われました");
  assert.equal((await fsdb().collection(C.fortuneSessions).where("transactionId", "==", t1.id).get()).size, 1);
  assert.equal((await fsdb().collection(C.fortuneSessions).doc(t1.id).get()).get("status"), "PAID");
  r = await webhook("checkout.session.completed", obj1, { eventId: "evt_pub_dup_1" });
  assert.deepEqual(await r.json(), { received: true, duplicate: true });
  assert.equal(await outcome(await webhook("checkout.session.completed", obj1)), "duplicate");
  r = await guest.req(`/payment/return?session_id=${p1.sessionId}`);
  assert.match(r.headers.get("location") ?? "", /\/fortune\/input$/);
  assert.equal((await txOf(p1.checkoutId)).length, 1);
  assert.equal(await status(guest), "succeeded");
  // 支払い済みの間は新しい注文を作らない（権利の消失・二重決済の防止）
  r = await guest.req("/api/checkout", { method: "POST", json: { fortuneType: "BLOOD" } });
  assert.equal(r.status, 409);
  step("支払い：戻り先と Webhook 2通が同時でも決済記録・占い権利は1件。100円 → 店舗A（古い配分率40%が残っている）でも店舗30円・運営70円・手数料4円・Sandbox（売上対象外）。再送・再訪問も1件のまま。支払い済みの間は新しい注文を作らない");

  // ---- 6. 入力 → 結果。二重送信は同じ結果。24時間の再表示 ----
  html = await (await guest.req("/fortune/input")).text();
  assert.ok(!html.includes("テストモードのため決済をスキップしました"), "有料の入力画面ではありません");
  r = await guest.req("/api/fortune", { method: "POST", json: { type: "ZODIAC", sign: "leo" } });
  assert.equal(r.status, 200, await r.clone().text());
  const first = JSON.stringify(await r.json());
  r = await guest.req("/api/fortune", { method: "POST", json: { type: "ZODIAC", sign: "virgo" } });
  assert.equal(r.status, 200);
  assert.equal(JSON.stringify(await r.json()), first, "二重送信で結果が変わりました");
  assert.equal((await fsdb().collection(C.fortuneSessions).doc(t1.id).get()).get("status"), "USED");
  assert.equal((await fsdb().collection(C.fortuneResults).where("fortuneSessionId", "==", t1.id).get()).size, 1);
  html = await (await guest.req("/fortune/result")).text();
  assert.match(html, /健康運/);
  html = await (await guest.req("/fortune/result")).text();
  assert.match(html, /健康運/, "結果を再表示できません");
  const resRef = fsdb().collection(C.fortuneResults).doc(t1.id);
  const until = (await resRef.get()).get("viewableUntil").toDate() as Date;
  const hours = (until.getTime() - Date.now()) / 3600_000;
  assert.ok(hours > 23.9 && hours <= 24, `結果の表示期限が24時間ではありません（${hours.toFixed(2)}h）`);
  await resRef.update({ viewableUntil: new Date(Date.now() - 1000) });
  html = await (await guest.req("/fortune/result")).text();
  assert.match(html, /結果の表示期間が終了しました/);
  r = await guest.req("/api/fortune", { method: "POST", json: { type: "ZODIAC", sign: "leo" } });
  assert.equal(r.status, 410, "表示期間の後に API から結果を取り出せました");
  assert.equal((await fsdb().collection(C.fortuneSessions).where("transactionId", "==", t1.id).get()).size, 1);
  step("入力 → 結果。二重送信は同じ結果（権利は1回で USED・結果は1件）。結果は24時間再表示でき、期限後は画面・API とも表示期間の終了（410）");

  // ---- 7. 店舗の売上の帰属：店舗B（配分25%）の QR から買うと店舗Bに記録 ----
  const guestB = new Client();
  const p2 = await startPurchase(guestB, storeB.storeCode, "BLOOD");
  assert.equal((await checkoutOf(p2.checkoutId)).storeId, storeB.id);
  await ctl(`pay/${p2.sessionId}`, { fee: 4 });
  assert.equal(await outcome(await webhook("checkout.session.completed", { id: p2.sessionId, object: "checkout.session" })), "confirmed");
  const [t2] = await txOf(p2.checkoutId);
  assert.deepEqual([t2.get("storeId"), t2.get("storeShare"), t2.get("operatorShare"), t2.get("amount"), t2.get("storeShareBps")], [storeB.id, 30, 70, 100, 3000]);
  r = await guestB.req("/api/fortune", { method: "POST", json: { type: "BLOOD", bloodType: "O", birthMonth: 3 } });
  assert.equal(r.status, 200, await r.clone().text());
  // 別の店舗の QR を後から読んでも、支払い済みの注文の店舗は変わらない
  await guestB.req(`/s/${storeA.storeCode}`);
  assert.equal((await txOf(p2.checkoutId))[0].get("storeId"), storeB.id);
  // Sandbox の決済は売上・店舗の取り分・精算に含めない（テストと本番を混ぜない）
  const after = { month: await monthTotals(ym), monthA: await monthTotals(ym, storeA.id), monthB: await monthTotals(ym, storeB.id) };
  assert.deepEqual(after, before, "Sandbox の決済が売上集計に入りました");
  step("売上の帰属：店舗B の QR → 店舗B（古い配分率25%が残っていても店舗30円・運営70円）。後から別の QR を読んでも変わらない。Sandbox の決済は売上集計に含めない");

  // ---- 8. 確定待ち（PayPay）→ 失敗：権利なし・選び直しを案内 ----
  const guestP = new Client();
  const p3 = await startPurchase(guestP, storeA.storeCode, "ZODIAC");
  await ctl(`pay/${p3.sessionId}`, { method: "paypay", async: true });
  assert.equal(await outcome(await webhook("checkout.session.completed", { id: p3.sessionId, object: "checkout.session" })), "not_paid");
  r = await guestP.req(`/payment/return?session_id=${p3.sessionId}`);
  assert.equal(r.status, 200);
  assert.match(await r.text(), /お支払いを確認しています/);
  assert.equal(await status(guestP), "processing");
  assert.equal((await txOf(p3.checkoutId)).length, 0, "確定前に記録されました");
  r = await guestP.req("/api/checkout", { method: "POST", json: { fortuneType: "BLOOD" } });
  assert.equal(r.status, 409, "確認中に新しい注文を作れました");
  r = await guestP.req("/api/fortune", { method: "POST", json: { type: "ZODIAC", sign: "leo" } });
  assert.notEqual(r.status, 200, "確定前に占えました");
  await ctl(`async-fail/${p3.sessionId}`);
  assert.equal(await outcome(await webhook("checkout.session.async_payment_failed", { id: p3.sessionId, object: "checkout.session" })), "failed");
  assert.equal(await status(guestP), "failed");
  assert.equal((await checkoutOf(p3.checkoutId)).status, "FAILED");
  r = await guestP.req("/api/checkout/stripe-session", { method: "POST", json: {} });
  assert.equal(r.status, 410);
  assert.match(await r.text(), /お支払いが完了しませんでした/);
  assert.equal((await txOf(p3.checkoutId)).length, 0);
  step("確定待ち（PayPay）：確認中の表示・記録なし・占えない・新しい注文も作れない → 失敗の通知で FAILED（記録・権利なし。選び直しを案内）");

  // ---- 9. 確定待ち → 成功 ----
  const p4 = await startPurchase(guestP, storeA.storeCode, "ZODIAC");
  await ctl(`pay/${p4.sessionId}`, { method: "paypay", async: true });
  await webhook("checkout.session.completed", { id: p4.sessionId, object: "checkout.session" });
  assert.equal(await status(guestP), "processing");
  await ctl(`async-succeed/${p4.sessionId}`);
  assert.equal(await outcome(await webhook("checkout.session.async_payment_succeeded", { id: p4.sessionId, object: "checkout.session" })), "confirmed");
  assert.equal(await status(guestP), "succeeded");
  r = await guestP.req("/api/fortune", { method: "POST", json: { type: "ZODIAC", sign: "aries" } });
  assert.equal(r.status, 200, await r.clone().text());
  step("確定待ち（PayPay）→ 確定の通知で記録し、占える");

  // ---- 10. 期限切れ ----
  const guestE = new Client();
  const p5 = await startPurchase(guestE, storeA.storeCode, "BIRTHDAY");
  await ctl(`expire/${p5.sessionId}`);
  assert.equal(await outcome(await webhook("checkout.session.expired", { id: p5.sessionId, object: "checkout.session" })), "expired");
  assert.equal((await checkoutOf(p5.checkoutId)).status, "EXPIRED");
  assert.match(await (await guestE.req("/payment")).text(), /お支払いの有効期限が切れました/);
  assert.equal((await guestE.req("/api/checkout/stripe-session", { method: "POST", json: {} })).status, 410);
  assert.equal((await txOf(p5.checkoutId)).length, 0);
  // 期限切れの後は新しく注文し直せる
  const p5b = await startPurchase(guestE, storeA.storeCode, "BIRTHDAY");
  assert.notEqual(p5b.checkoutId, p5.checkoutId);
  step("期限切れ：注文を EXPIRED（記録なし）。支払い画面は期限切れを案内し、決済画面へは移動しない。選び直して新しく注文できる");

  // ---- 11. 他人の Session・本番の通知・署名の不一致 ----
  const other = new Client();
  r = await other.req(`/payment/return?session_id=${p5b.sessionId}`);
  assert.match(await r.text(), /このブラウザではお支払いを確認できませんでした/);
  await ctl(`pay/${p5b.sessionId}`);
  r = await other.req(`/payment/return?session_id=${p5b.sessionId}`);
  assert.match(await r.text(), /このブラウザではお支払いを確認できませんでした/);
  assert.equal((await txOf(p5b.checkoutId)).length, 0);
  assert.equal((await webhook("checkout.session.completed", { id: p5b.sessionId, object: "checkout.session" }, { livemode: true })).status, 400);
  assert.equal((await webhook("checkout.session.completed", { id: p5b.sessionId, object: "checkout.session" }, { secret: "whsec_wrong" })).status, 400);
  assert.equal((await txOf(p5b.checkoutId)).length, 0);
  assert.equal(await outcome(await webhook("checkout.session.completed", { id: p5b.sessionId, object: "checkout.session" })), "confirmed");
  step("他人の Session は別のブラウザで確定しない。本番（livemode=true）の通知・署名の不一致は 400（記録なし）。正しい通知で確定");

  // 開発モードの確認用：公開中に作った、まだ支払っていない注文
  const guestD = new Client();
  await guestD.req(`/s/${storeA.storeCode}`);
  r = await guestD.req("/api/checkout", { method: "POST", json: { fortuneType: "ZODIAC" } });
  assert.equal(r.status, 201);
  const cD = ((await r.json()) as { checkoutId: string }).checkoutId;

  // ---- 12. 運営アカウントの Sandbox テスト（公開中でも今までどおり運営向けの表示） ----
  const op = await loggedIn(opId);
  const p6 = await startPurchase(op, storeA.storeCode, "ZODIAC");
  html = await (await op.req("/payment")).text();
  assert.ok(html.includes("Stripe のテスト決済です（運営アカウントのみ）"), "運営向けの表示がありません");
  assert.equal((await checkoutOf(p6.checkoutId)).provider, "stripe");
  step("運営アカウント：公開中も今までどおり Sandbox のテスト決済（運営向けの表示）");

  // ================= 開発モード：一般のお客さんの決済は受け付けない。運営の Sandbox テストは維持 =================
  await startApp("開発モード・PAYMENT_PROVIDER=stripe", { SITE_STATUS: "development" });
  const devGuest = new Client();
  await devGuest.req(`/s/${storeA.storeCode}`);
  r = await devGuest.req("/api/checkout", { method: "POST", json: { fortuneType: "ZODIAC" } });
  assert.equal(r.status, 503);
  assert.equal((await devGuest.req("/api/checkout/stripe-session", { method: "POST", json: {} })).status, 404);
  // 公開中に作った注文の Cookie を持っていても、開発モードでは決済画面へ進めない
  const createdDev = fake.createCalls;
  assert.equal((await guestD.req("/api/checkout/stripe-session", { method: "POST", json: {} })).status, 404);
  html = await (await guestD.req("/payment")).text();
  assert.doesNotMatch(html, /同意して100円を支払う/);
  assert.equal(fake.createCalls, createdDev, "開発モードで一般のお客さんの Session が作られました");
  assert.deepEqual([(await checkoutOf(cD)).status, (await checkoutOf(cD)).providerPaymentId ?? null], ["CREATED", null]);
  const opDev = await loggedIn(opId);
  const p7 = await startPurchase(opDev, storeA.storeCode, "ZODIAC");
  assert.match(await (await opDev.req("/payment")).text(), /Stripe のテスト決済です（運営アカウントのみ）/);
  await ctl(`pay/${p7.sessionId}`);
  assert.equal(await outcome(await webhook("checkout.session.completed", { id: p7.sessionId, object: "checkout.session" })), "confirmed");
  step("開発モード：一般のお客さんは注文 503・決済画面 404（公開中の注文の Cookie でも進めない）。運営の Sandbox テストは今までどおり確定");

  // ================= 準備中・不明な公開状態（live など）：受け付けない =================
  for (const site of ["coming_soon", "live"]) {
    await startApp(`SITE_STATUS=${site}`, { SITE_STATUS: site });
    const g = new Client();
    await g.req(`/s/${storeA.storeCode}`);
    assert.equal((await g.req("/api/checkout", { method: "POST", json: { fortuneType: "ZODIAC" } })).status, 503, site);
    assert.equal((await g.req("/api/checkout/stripe-session", { method: "POST", json: {} })).status, 404, site);
  }
  step("準備中・不明な公開状態（SITE_STATUS=live など）：注文 503・決済画面 404");

  // ================= テストと本番の取り違え：受け付けない（PAY.JP などへ切り替えもしない） =================
  const mixups: [string, Record<string, string>][] = [
    ["sk_live_ のキー", { STRIPE_SECRET_KEY: "sk_live_e2e_dummy" }],
    ["本番決済のスイッチ", { STRIPE_LIVE_CHECKOUT: "on" }],
    ["PAY.JP の本番用キー", { PAYJP_SECRET_KEY: "sk_live_e2e_dummy_payjp", PAYJP_PUBLIC_KEY: "pk_live_e2e_dummy", PAYJP_WEBHOOK_TOKEN: "whook_e2e_dummy" }],
    ["Stripe のテストのスイッチなし", { STRIPE_TEST_CHECKOUT: "" }],
  ];
  for (const [label, o] of mixups) {
    await startApp(label, o);
    const g = new Client();
    await g.req(`/s/${storeA.storeCode}`);
    r = await g.req("/api/checkout", { method: "POST", json: { fortuneType: "ZODIAC" } });
    assert.equal(r.status, 503, label);
    assert.equal((await g.req("/api/checkout/stripe-session", { method: "POST", json: {} })).status, 404, label);
    assert.equal((await webhook("checkout.session.completed", { id: p6.sessionId, object: "checkout.session" })).status, 404, `${label}: Webhook`);
  }
  step("取り違え（sk_live_・本番決済のスイッチ・PAY.JP の本番用キー・テストのスイッチなし）：注文 503・決済画面 404・Webhook 404（ほかの決済へ切り替えない）");

  // ================= PAYMENT_PROVIDER が stripe 以外：一般のお客さんに Stripe を使わない =================
  await startApp("PAYMENT_PROVIDER=payjp（PAY.JP のキーなし）", { PAYMENT_PROVIDER: "payjp" });
  const g2 = new Client();
  await g2.req(`/s/${storeA.storeCode}`);
  assert.equal((await g2.req("/api/checkout", { method: "POST", json: { fortuneType: "ZODIAC" } })).status, 503);
  assert.equal((await g2.req("/api/checkout/stripe-session", { method: "POST", json: {} })).status, 404);
  step("PAYMENT_PROVIDER=payjp（PAY.JP のキーなし）：一般のお客さんに Stripe を使わない（注文 503・決済画面 404）");

  await stopApp();
  await fakeStripe.stop();
  console.log("\nStripe public E2E: all passed");
}

main().catch(async (e) => {
  console.error(e);
  await stopApp().catch(() => {});
  await fakeStripe.stop().catch(() => {});
  process.exit(1);
});
