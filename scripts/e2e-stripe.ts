/**
 * Stripe Checkout テスト決済の E2E 検証。Firestore Emulator の demo- プロジェクトと、このスクリプトが起動する
 * 「Stripe API の模擬サーバー」（localhost）だけを使う。本物の Stripe・本番の Firebase には一切接続しない。
 *
 *   firebase emulators:start --only firestore --project demo-uranai
 *   （別ターミナル）npm run build && FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 FIREBASE_PROJECT_ID=demo-uranai-stripe DB_PROVIDER=firestore \
 *       SITE_STATUS=development PAYMENT_PROVIDER=payjp ENABLE_TEST_PAYMENT=false ALLOW_MOCK_PAYMENTS_IN_PRODUCTION=false \
 *       STRIPE_TEST_CHECKOUT=on STRIPE_SECRET_KEY=sk_test_e2e_dummy STRIPE_WEBHOOK_SECRET=whsec_e2e_dummy \
 *       STRIPE_API_BASE=http://127.0.0.1:12111 npx next start
 *   （別ターミナル）FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 FIREBASE_PROJECT_ID=demo-uranai-stripe npm run e2e:stripe
 */
import "dotenv/config";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import Stripe from "stripe";
import { C, fsdb } from "@/lib/firestore/admin";
import { dataProvider } from "@/lib/data-provider";
import { createOperator, createStore, createStoreUser } from "@/lib/services/stores";
import { monthTotals } from "@/lib/services/reports";
import { generateSettlements, listSettlements } from "@/lib/services/settlements";
import { calcFee } from "@/lib/money";
import { defaultFeeRateBps } from "@/config/pricing";
import { randomToken, sha256Hex } from "@/lib/security/crypto";
import { jstYearMonth, shiftYearMonth } from "@/lib/time";
import { restoreStripeEntitlement } from "@/lib/payments/stripe-confirm";

const BASE = process.env.E2E_BASE_URL ?? "http://localhost:3000";
const STRIPE_PORT = 12111;
const WEBHOOK_SECRET = "whsec_e2e_dummy";
const SYSTEM = { userId: null, role: "SYSTEM" as const };
const step = (msg: string) => console.log(`  ✓ ${msg}`);

// ================= Stripe API の模擬サーバー（必要な API だけ） =================
type FakeSession = Record<string, unknown> & { id: string; metadata: Record<string, string> };
const fake = {
  n: 0,
  sessions: new Map<string, FakeSession>(),
  idem: new Map<string, { sessionId: string; body: string }>(),
  pis: new Map<string, Record<string, unknown>>(),
  charges: new Map<string, Record<string, unknown>>(),
  refunds: new Map<string, Record<string, unknown>>(),
  createCalls: 0,
  /** Stripe 側で表示される支払い方法（ダッシュボードの設定で有効なもの）。絞り込みの確認用に増やせる */
  eligible: ["card", "paypay", "link", "konbini"],
  extraMethods: [] as string[],
  /** 利用者の Sandbox と同じく、アカウントの既定で Managed Payments が有効（Session で enabled=false を明示しないと付く） */
  managedPaymentsDefault: true,
  /** 応答の managed_payments.enabled を強制的に true にする（アプリが移動を止めるかの確認用） */
  forceManagedResponse: false,
  /** 作成時の expires_at（ID ごと）と作成時刻 */
  created: new Map<string, number>(),
};
const stripeError = (res: ServerResponse, status: number, type: string, message: string, param?: string, code?: string) =>
  send(res, status, { error: { type, message, ...(param ? { param } : {}), ...(code ? { code } : {}) } });
// 本物の Stripe の ID は世界で一意。Emulator のデータは実行をまたいで残るので、実行ごとに異なる ID にする
const RUN = Date.now().toString(36);
const id = (p: string) => `${p}_test_${RUN}${(++fake.n).toString().padStart(6, "0")}`;

function piView(piId: string) {
  const pi = fake.pis.get(piId)!;
  return { ...pi, latest_charge: pi.latest_charge ? chargeView(String(pi.latest_charge)) : null };
}
function chargeView(chId: string) {
  const ch = fake.charges.get(chId)!;
  return { ...ch, balance_transaction: ch.fee === null ? null : { id: `txn_${chId}`, object: "balance_transaction", currency: "jpy", fee: ch.fee } };
}
function sessionView(s: FakeSession) {
  return { ...s, payment_intent: s.payment_intent ? piView(String(s.payment_intent)) : null };
}

async function readBody(req: IncomingMessage) {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}
function send(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json", "request-id": `req_${fake.n}` });
  res.end(JSON.stringify(body));
}

const stripeServer = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://127.0.0.1:${STRIPE_PORT}`);
  const body = await readBody(req);
  if (!url.pathname.startsWith("/__test") && req.headers.authorization !== "Bearer sk_test_e2e_dummy") return send(res, 401, { error: { type: "invalid_request_error", message: "bad key" } });
  const m = (re: RegExp) => re.exec(url.pathname);
  if (req.method === "POST" && url.pathname === "/v1/checkout/sessions") {
    const key = String(req.headers["idempotency-key"] ?? "");
    const prev = key ? fake.idem.get(key) : undefined;
    if (prev) {
      // 本物の Stripe と同じく、同じ冪等キーで別の内容を送ると 400
      if (prev.body !== body) return stripeError(res, 400, "idempotency_error", "Keys for idempotent requests can only be used with the same parameters they were first used with.");
      return send(res, 200, sessionView(fake.sessions.get(prev.sessionId)!));
    }
    const f = new URLSearchParams(body);
    const allowed = [...f.entries()].filter(([k]) => /^allowed_payment_method_types\[\d+\]$/.test(k)).map(([, v]) => v);
    if (f.has("payment_method_types[0]")) return send(res, 400, { error: { type: "invalid_request_error", message: "payment_method_types is not supported" } });
    // 検証に失敗した要求は冪等キーの結果として保存しない（本物の Stripe と同じ）
    const managed = f.has("managed_payments[enabled]") ? f.get("managed_payments[enabled]") === "true" : fake.managedPaymentsDefault;
    if (managed && allowed.length) return stripeError(res, 400, "invalid_request_error", "allowed_payment_method_types cannot be used with Managed Payments", "allowed_payment_method_types");
    const now = Math.floor(Date.now() / 1000);
    const exp = Number(f.get("expires_at"));
    if (!Number.isInteger(exp) || exp < now + 30 * 60 || exp > now + 24 * 60 * 60) {
      return stripeError(res, 400, "invalid_request_error", "The `expires_at` timestamp must be between 30 minutes and 24 hours from Checkout Session creation.", "expires_at", "parameter_invalid_integer");
    }
    fake.createCalls++;
    const s: FakeSession = {
      id: id("cs"),
      object: "checkout.session",
      livemode: false,
      mode: f.get("mode"),
      status: "open",
      payment_status: "unpaid",
      currency: f.get("line_items[0][price_data][currency]"),
      amount_total: Number(f.get("line_items[0][price_data][unit_amount]")) * Number(f.get("line_items[0][quantity]")),
      client_reference_id: f.get("client_reference_id"),
      metadata: { checkoutId: f.get("metadata[checkoutId]") ?? "", storeId: f.get("metadata[storeId]") ?? "", fortuneType: f.get("metadata[fortuneType]") ?? "" },
      pi_metadata: { checkoutId: f.get("payment_intent_data[metadata][checkoutId]"), storeId: f.get("payment_intent_data[metadata][storeId]"), fortuneType: f.get("payment_intent_data[metadata][fortuneType]") },
      success_url: f.get("success_url"),
      expires_at: Number(f.get("expires_at")),
      payment_intent: null,
      allowed_payment_method_types: allowed.length ? allowed : null,
      managed_payments_param: f.get("managed_payments[enabled]"),
      managed_payments: { enabled: fake.forceManagedResponse ? true : managed },
      // allowed_payment_method_types は「表示できる支払い方法」を絞り込む（指定が無ければ有効なものすべて）
      payment_method_types: [...(allowed.length ? fake.eligible.filter((t) => allowed.includes(t)) : fake.eligible), ...fake.extraMethods],
    };
    s.url = `http://127.0.0.1:${STRIPE_PORT}/pay/${s.id}`;
    fake.sessions.set(s.id, s);
    if (key) fake.idem.set(key, { sessionId: s.id, body });
    fake.created.set(s.id, now);
    return send(res, 200, sessionView(s));
  }
  let r = m(/^\/v1\/checkout\/sessions\/([^/]+)$/);
  if (req.method === "GET" && r) {
    const s = fake.sessions.get(r[1]);
    return s ? send(res, 200, sessionView(s)) : send(res, 404, { error: { type: "invalid_request_error", message: "No such session" } });
  }
  r = m(/^\/v1\/charges\/([^/]+)$/);
  if (req.method === "GET" && r) {
    return fake.charges.has(r[1]) ? send(res, 200, chargeView(r[1])) : send(res, 404, { error: { type: "invalid_request_error", message: "No such charge" } });
  }
  if (req.method === "GET" && url.pathname === "/v1/refunds") {
    const charge = url.searchParams.get("charge");
    return send(res, 200, { object: "list", url: "/v1/refunds", has_more: false, data: [...fake.refunds.values()].filter((x) => x.charge === charge) });
  }
  // ---- テスト用の操作（決済画面での支払い・返金・期限切れ・手数料の確定を再現） ----
  const ctl = JSON.parse(body || "{}") as { fee?: number | null; amount?: number; created?: number; metadataStoreId?: string; method?: string; async?: boolean; status?: string };
  r = m(/^\/__test\/pay\/([^/]+)$/);
  if (r) {
    // 決済画面での支払い。method: card | apple_pay | google_pay | paypay | link | samsung_pay、async: 確定待ち（PayPay の非同期の確定）
    const s = fake.sessions.get(r[1])!;
    const piId = id("pi");
    const chId = id("ch");
    const amount = ctl.amount ?? Number(s.amount_total);
    const method = ctl.method ?? "card";
    const pmd = method === "paypay" ? { type: "paypay", paypay: {} } : method === "link" ? { type: "link", link: {} } : { type: "card", card: { brand: "visa", wallet: method === "card" ? null : { type: method } } };
    const pending = ctl.async === true;
    fake.charges.set(chId, { id: chId, object: "charge", livemode: false, status: pending ? "pending" : "succeeded", paid: !pending, captured: !pending, refunded: false, amount_refunded: 0, currency: "jpy", amount, payment_intent: piId, created: ctl.created ?? Math.floor(Date.now() / 1000), payment_method_details: pmd, fee: ctl.fee === undefined ? 4 : ctl.fee });
    const md = { ...(s.pi_metadata as Record<string, string>), ...(ctl.metadataStoreId ? { storeId: ctl.metadataStoreId } : {}) };
    fake.pis.set(piId, { id: piId, object: "payment_intent", livemode: false, status: pending ? "processing" : "succeeded", currency: "jpy", amount, amount_received: pending ? 0 : amount, metadata: md, latest_charge: chId });
    Object.assign(s, { status: "complete", payment_status: pending ? "unpaid" : "paid", payment_intent: piId, amount_total: amount });
    return send(res, 200, { paymentIntent: piId, charge: chId });
  }
  r = m(/^\/__test\/decline\/([^/]+)$/);
  if (r) {
    // カードが拒否された（決済画面で支払い直せる。Session は open のまま、PaymentIntent は requires_payment_method）
    const s = fake.sessions.get(r[1])!;
    const piId = id("pi");
    fake.pis.set(piId, { id: piId, object: "payment_intent", livemode: false, status: "requires_payment_method", currency: "jpy", amount: s.amount_total, amount_received: 0, metadata: s.pi_metadata, latest_charge: null });
    Object.assign(s, { status: "open", payment_status: "unpaid", payment_intent: piId });
    return send(res, 200, { paymentIntent: piId });
  }
  r = m(/^\/__test\/async-(succeed|fail)\/([^/]+)$/);
  if (r) {
    const s = fake.sessions.get(r[2])!;
    const pi = fake.pis.get(String(s.payment_intent))!;
    const ch = fake.charges.get(String(pi.latest_charge))!;
    if (r[1] === "succeed") {
      Object.assign(pi, { status: "succeeded", amount_received: pi.amount });
      Object.assign(ch, { status: "succeeded", paid: true, captured: true });
      Object.assign(s, { payment_status: "paid" });
    } else {
      Object.assign(pi, { status: "requires_payment_method" });
      Object.assign(ch, { status: "failed", paid: false });
    }
    return send(res, 200, {});
  }
  const syncCharge = (chId: string) => {
    const ch = fake.charges.get(chId)!;
    const sum = [...fake.refunds.values()].filter((x) => x.charge === chId && (x.status === "succeeded" || x.status === "pending")).reduce((a, x) => a + Number(x.amount), 0);
    Object.assign(ch, { amount_refunded: sum, refunded: sum >= Number(ch.amount) });
  };
  r = m(/^\/__test\/refund\/([^/]+)$/);
  if (r) {
    const ch = fake.charges.get(r[1])!;
    const reId = id("re");
    fake.refunds.set(reId, { id: reId, object: "refund", charge: r[1], payment_intent: ch.payment_intent, currency: "jpy", amount: ctl.amount ?? ch.amount, status: ctl.status ?? "succeeded" });
    syncCharge(r[1]);
    return send(res, 200, { refund: reId });
  }
  r = m(/^\/__test\/refund-status\/([^/]+)$/);
  if (r) {
    const re = fake.refunds.get(r[1])!;
    re.status = ctl.status;
    syncCharge(String(re.charge));
    return send(res, 200, {});
  }
  r = m(/^\/__test\/expire\/([^/]+)$/);
  if (r) {
    Object.assign(fake.sessions.get(r[1])!, { status: "expired" });
    return send(res, 200, {});
  }
  r = m(/^\/__test\/fee\/([^/]+)$/);
  if (r) {
    Object.assign(fake.charges.get(r[1])!, { fee: ctl.fee });
    return send(res, 200, {});
  }
  send(res, 404, { error: { type: "invalid_request_error", message: `unknown ${req.method} ${url.pathname}` } });
});

async function ctl(path: string, body: Record<string, unknown> = {}) {
  const r = await fetch(`http://127.0.0.1:${STRIPE_PORT}/__test/${path}`, { method: "POST", body: JSON.stringify(body) });
  return r.json() as Promise<{ paymentIntent?: string; charge?: string; refund?: string }>;
}

// ================= アプリの利用者 =================
class Client {
  jar = new Map<string, string>();
  ip = `198.51.100.${Math.floor(Math.random() * 250) + 1}`;
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

const signer = new Stripe("sk_test_e2e_dummy");
let evN = 0;
async function webhook(type: string, object: Record<string, unknown>, opts: { eventId?: string; livemode?: boolean; secret?: string } = {}) {
  const payload = JSON.stringify({ id: opts.eventId ?? `evt_test_${++evN}_${Date.now()}`, object: "event", type, livemode: opts.livemode ?? false, data: { object } });
  const header = signer.webhooks.generateTestHeaderString({ payload, secret: opts.secret ?? WEBHOOK_SECRET });
  return fetch(`${BASE}/api/webhooks/stripe`, { method: "POST", headers: { "stripe-signature": header, "content-type": "application/json" }, body: payload });
}

/** 運営が店舗の QR から占いを選び、Stripe の決済画面へ移動するところまで */
async function startPurchase(op: Client, storeCode: string, fortuneType: "ZODIAC" | "BLOOD" | "BIRTHDAY") {
  op.jar.delete("fx_access");
  op.ip = `198.51.100.${Math.floor(Math.random() * 250) + 1}`; // 連続の購入でレート制限にかからないように
  await op.req(`/s/${storeCode}`);
  let r = await op.req("/api/checkout", { method: "POST", json: { fortuneType } });
  assert.equal(r.status, 201, await r.clone().text());
  const { checkoutId } = (await r.json()) as { checkoutId: string };
  r = await op.req("/api/checkout/stripe-session", { method: "POST", json: {} });
  assert.equal(r.status, 200, await r.clone().text());
  const j = (await r.json()) as { status: string; url: string };
  assert.equal(j.status, "redirect");
  const sessionId = j.url.split("/").pop()!;
  return { checkoutId, sessionId, url: j.url };
}

const stripeTxIdOf = (pi: string) => `stripe_${pi}`;
/** 注文だけを作る（決済画面への移動はしない） */
async function createOrder(c: Client, storeCode: string) {
  c.jar.delete("fx_access");
  c.ip = `198.51.100.${Math.floor(Math.random() * 250) + 1}`;
  await c.req(`/s/${storeCode}`);
  const r = await c.req("/api/checkout", { method: "POST", json: { fortuneType: "ZODIAC" } });
  assert.equal(r.status, 201, await r.clone().text());
  return ((await r.json()) as { checkoutId: string }).checkoutId;
}

const txOf = async (checkoutId: string) => (await fsdb().collection(C.transactions).where("checkoutId", "==", checkoutId).get()).docs;

async function main() {
  // 管理者の操作（権利の復旧）をこのスクリプトから直接呼ぶため、アプリと同じテスト決済の設定にする（ローカルの模擬サーバーだけ）
  Object.assign(process.env, { PAYMENT_PROVIDER: "payjp", ALLOW_MOCK_PAYMENTS_IN_PRODUCTION: "false", ENABLE_TEST_PAYMENT: "false", STRIPE_TEST_CHECKOUT: "on", STRIPE_SECRET_KEY: "sk_test_e2e_dummy", STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET, STRIPE_API_BASE: `http://127.0.0.1:${STRIPE_PORT}` });
  const host = process.env.FIRESTORE_EMULATOR_HOST ?? "";
  assert.match(host, /^(127\.0\.0\.1|localhost|\[::1\]):\d+$/, "FIRESTORE_EMULATOR_HOST（localhost の Emulator）が必要です");
  assert.match(process.env.FIREBASE_PROJECT_ID ?? "", /^demo-/, "FIREBASE_PROJECT_ID は demo- で始まる Emulator 用の ID にしてください");
  assert.equal(dataProvider(), "firestore");
  assert.match(BASE, /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/);
  await new Promise<void>((ok) => stripeServer.listen(STRIPE_PORT, "127.0.0.1", ok));
  console.log(`Stripe E2E against ${BASE} (emulator ${host} / ${process.env.FIREBASE_PROJECT_ID}, fake Stripe :${STRIPE_PORT})`);

  const stamp = Date.now();
  const storeA = await createStore({ name: `Stripe検証店舗A ${stamp}`, contactName: "", postalCode: "", address: "", phone: "", email: "" }, SYSTEM);
  const storeB = await createStore({ name: `Stripe検証店舗B ${stamp}`, contactName: "", postalCode: "", address: "", phone: "", email: "" }, SYSTEM);
  const opId = await createOperator({ name: "Stripe運営", email: `stripe-op-${stamp}@example.com`, password: "StripeOperator123" });
  const op2Id = await createOperator({ name: "Stripe運営2", email: `stripe-op2-${stamp}@example.com`, password: "StripeOperator123" });
  const staffId = await createStoreUser(storeA.id, { name: "店舗スタッフ", email: `stripe-staff-${stamp}@example.com`, password: "StripeStaff12345" }, SYSTEM);
  const ym = jstYearMonth(new Date());
  const before = { month: await monthTotals(ym), monthA: await monthTotals(ym, storeA.id) };

  // ---- 1. 運営以外は使えない（開発モードなので決済は停止） ----
  const anon = new Client();
  await anon.req(`/s/${storeA.storeCode}`);
  let r = await anon.req("/api/checkout", { method: "POST", json: { fortuneType: "ZODIAC" } });
  assert.equal(r.status, 503);
  assert.equal((await anon.req("/api/checkout/stripe-session", { method: "POST", json: {} })).status, 404);
  const staff = await loggedIn(staffId);
  await staff.req(`/s/${storeA.storeCode}`);
  assert.equal((await staff.req("/api/checkout", { method: "POST", json: { fortuneType: "ZODIAC" } })).status, 503);
  assert.equal((await staff.req("/api/checkout/stripe-session", { method: "POST", json: {} })).status, 404);
  step("ログインなし・店舗アカウント：注文は 503（開発モード）、決済画面への移動は 404");

  // ---- 2. 運営：注文 → 決済画面への移動（注文と Session を紐付け。何度押しても同じ Session） ----
  const op = await loggedIn(opId);
  const p1 = await startPurchase(op, storeA.storeCode, "ZODIAC");
  let co = (await fsdb().collection(C.checkouts).doc(p1.checkoutId).get()).data()!;
  assert.equal(co.provider, "stripe");
  assert.equal(co.providerPaymentId, p1.sessionId);
  assert.equal(co.status, "PROCESSING");
  assert.equal(co.storeId, storeA.id);
  const created = fake.createCalls;
  r = await op.req("/api/checkout/stripe-session", { method: "POST", json: {} });
  assert.equal(((await r.json()) as { url: string }).url, p1.url);
  assert.equal(fake.createCalls, created, "同じ注文で Session が増えました");
  const s1 = fake.sessions.get(p1.sessionId)!;
  assert.equal(s1.client_reference_id, p1.checkoutId);
  assert.deepEqual(s1.metadata, { checkoutId: p1.checkoutId, storeId: storeA.id, fortuneType: "ZODIAC" });
  assert.equal(s1.amount_total, 100);
  assert.match(String(s1.success_url), /\/payment\/return\?session_id=\{CHECKOUT_SESSION_ID\}$/);
  assert.deepEqual(s1.allowed_payment_method_types, ["card", "paypay"], "支払い方法がカード・PayPay に絞り込まれていません");
  assert.deepEqual(s1.payment_method_types, ["card", "paypay"]);
  assert.equal(s1.managed_payments_param, "false", "managed_payments.enabled=false を明示していません");
  assert.match(await (await op.req("/payment")).text(), /Stripe のテスト決済です/);
  step("運営：注文（provider=stripe）→ Session 作成。注文IDを metadata・client_reference_id に入れ、Session の ID を注文に保存。再度押しても同じ Session");

  // ---- 3. 支払い前に戻ってきても確定しない ----
  r = await op.req(`/payment/return?session_id=${p1.sessionId}`);
  assert.equal(r.status, 200);
  assert.match(await r.text(), /お支払いを確認しています/);
  assert.equal((await txOf(p1.checkoutId)).length, 0);
  step("支払い前の戻り先：確定しない（決済記録なし）");

  // ---- 4. 支払い → 戻り先と Webhook が同時に動いても1回だけ記録 ----
  await ctl(`pay/${p1.sessionId}`, { fee: 4 });
  const sessionObj = { id: p1.sessionId, object: "checkout.session" };
  const [ret, wh1, wh2] = await Promise.all([
    op.req(`/payment/return?session_id=${p1.sessionId}`),
    webhook("checkout.session.completed", sessionObj, { eventId: "evt_test_dup_1" }),
    webhook("checkout.session.completed", sessionObj, { eventId: "evt_test_dup_2" }),
  ]);
  assert.ok([303, 307, 308].includes(ret.status), `戻り先が占いの入力へ移動しません（${ret.status}）`);
  assert.match(ret.headers.get("location") ?? "", /\/fortune\/input$/);
  assert.equal(wh1.status, 200);
  assert.equal(wh2.status, 200);
  const txs = await txOf(p1.checkoutId);
  assert.equal(txs.length, 1, "決済記録が1件ではありません");
  const t1 = txs[0];
  assert.deepEqual(
    { provider: t1.get("paymentProvider"), amount: t1.get("amount"), storeShare: t1.get("storeShare"), operatorShare: t1.get("operatorShare"), fee: t1.get("paymentFee"), feeEstimated: t1.get("feeEstimated"), livemode: t1.get("livemode"), countable: t1.get("countable"), status: t1.get("paymentStatus"), storeId: t1.get("storeId") },
    { provider: "stripe", amount: 100, storeShare: 30, operatorShare: 70, fee: 4, feeEstimated: false, livemode: false, countable: false, status: "SUCCEEDED", storeId: storeA.id },
  );
  assert.equal(t1.get("stripeCheckoutSessionId"), p1.sessionId);
  assert.equal(t1.get("stripePaymentMethod"), "card");
  const ent = await fsdb().collection(C.fortuneSessions).doc(t1.id).get();
  assert.equal(ent.get("status"), "PAID");
  assert.equal((await fsdb().collection(C.fortuneSessions).where("transactionId", "==", t1.id).get()).size, 1);
  co = (await fsdb().collection(C.checkouts).doc(p1.checkoutId).get()).data()!;
  assert.equal(co.status, "SUCCEEDED");
  // 同じ通知の再送・別の通知の重複
  r = await webhook("checkout.session.completed", sessionObj, { eventId: "evt_test_dup_1" });
  assert.deepEqual(await r.json(), { received: true, duplicate: true });
  r = await webhook("checkout.session.completed", sessionObj);
  assert.equal(((await r.json()) as { outcome: string }).outcome, "duplicate");
  assert.equal((await txOf(p1.checkoutId)).length, 1);
  step("支払い後：戻り先と Webhook（2通）が同時でも決済記録・占い権利は1件。100円 → 店舗30円・運営70円・手数料4円（確定値）・テスト決済（売上対象外）。再送・重複も1件のまま");

  // ---- 5. 占い ----
  r = await op.req("/api/fortune", { method: "POST", json: { type: "ZODIAC", sign: "leo" } });
  assert.equal(r.status, 200, await r.clone().text());
  assert.match(await (await op.req("/fortune/result")).text(), /健康運/);
  assert.equal((await fsdb().collection(C.fortuneSessions).doc(t1.id).get()).get("status"), "USED");
  step("支払い済みの占い権利で占える（1回で USED）");

  // ---- 6. 手数料が未確定 → 推定値（feeEstimated）→ 確定値に更新 ----
  const p2 = await startPurchase(op, storeA.storeCode, "BLOOD");
  const pay2 = await ctl(`pay/${p2.sessionId}`, { fee: null });
  r = await webhook("checkout.session.completed", { id: p2.sessionId, object: "checkout.session" });
  assert.equal(((await r.json()) as { outcome: string }).outcome, "confirmed");
  let t2 = (await txOf(p2.checkoutId))[0];
  assert.equal(t2.get("feeEstimated"), true);
  assert.equal(t2.get("paymentFee"), calcFee(100, defaultFeeRateBps()));
  await ctl(`fee/${pay2.charge}`, { fee: 3 });
  r = await webhook("charge.updated", { id: pay2.charge, object: "charge" });
  assert.equal(((await r.json()) as { outcome: string }).outcome, "fee_updated");
  t2 = (await txOf(p2.checkoutId))[0];
  assert.deepEqual([t2.get("paymentFee"), t2.get("feeEstimated")], [3, false]);
  step("手数料が未確定：推定値で記録（feeEstimated=true）→ 確定後の通知で確定値（3円）に更新");

  // ---- 7. 返金：処理中 → 成功。未使用の占い権利は処理中の時点で止め、使用済みはそのまま。再送・重複しても1回だけ ----
  const rf2 = await ctl(`refund/${pay2.charge}`, { status: "pending" });
  r = await webhook("refund.created", { id: rf2.refund, object: "refund", charge: pay2.charge });
  assert.equal(((await r.json()) as { outcome: string }).outcome, "refund_pending");
  t2 = (await txOf(p2.checkoutId))[0];
  assert.deepEqual([t2.get("refundStatus"), t2.get("paymentStatus"), t2.get("refundPendingAmount"), t2.get("amountRefunded"), t2.get("refundNeedsReview")], ["pending", "SUCCEEDED", 100, 0, false]);
  let ent2 = await fsdb().collection(C.fortuneSessions).doc(t2.id).get();
  assert.deepEqual([ent2.get("status"), ent2.get("suspendedByRefund")], ["EXPIRED", true]);
  await ctl(`refund-status/${rf2.refund}`, { status: "succeeded" });
  // 返金の成功の通知が2通（別の通知 ID）同時に届いても、反映は1回
  const [wr1, wr2] = await Promise.all([
    webhook("refund.updated", { id: rf2.refund, object: "refund", charge: pay2.charge }),
    webhook("charge.refunded", { id: pay2.charge, object: "charge" }),
  ]);
  const outs = [((await wr1.json()) as { outcome: string }).outcome, ((await wr2.json()) as { outcome: string }).outcome].sort();
  assert.deepEqual(outs, ["refunded", "unchanged"], `返金の反映が重複しました: ${outs}`);
  t2 = (await txOf(p2.checkoutId))[0];
  assert.deepEqual([t2.get("paymentStatus"), t2.get("refundStatus"), t2.get("countable"), t2.get("amountRefunded"), t2.get("refundPendingAmount")], ["REFUNDED", "succeeded", false, 100, 0]);
  ent2 = await fsdb().collection(C.fortuneSessions).doc(t2.id).get();
  assert.equal(ent2.get("status"), "EXPIRED");
  r = await webhook("charge.refunded", { id: pay2.charge, object: "charge" });
  assert.equal(((await r.json()) as { outcome: string }).outcome, "unchanged");
  assert.equal(await restoreStripeEntitlement(t2.id, { userId: opId, role: "OPERATOR" }), "refund_not_failed"); // 返金が成功した権利は戻せない
  await ctl(`refund/${t1.get("stripeChargeId")}`);
  await webhook("charge.refunded", { id: t1.get("stripeChargeId"), object: "charge" });
  assert.equal((await fsdb().collection(C.transactions).doc(t1.id).get()).get("paymentStatus"), "REFUNDED");
  assert.equal((await fsdb().collection(C.fortuneSessions).doc(t1.id).get()).get("status"), "USED");
  step("返金：処理中（refundStatus=pending）で未使用の権利を停止 → 成功で REFUNDED。成功の通知2通が同時でも反映は1回。再送は何もしない。使用済みは USED のまま");

  // ---- 8. 期限切れ・支払い失敗：注文を閉じる（決済記録なし） ----
  const p3 = await startPurchase(op, storeA.storeCode, "BIRTHDAY");
  await ctl(`expire/${p3.sessionId}`);
  r = await webhook("checkout.session.expired", { id: p3.sessionId, object: "checkout.session" });
  assert.equal(((await r.json()) as { outcome: string }).outcome, "expired");
  assert.equal((await fsdb().collection(C.checkouts).doc(p3.checkoutId).get()).get("status"), "EXPIRED");
  assert.equal((await txOf(p3.checkoutId)).length, 0);
  assert.equal((await op.req("/api/checkout/stripe-session", { method: "POST", json: {} })).status, 410);
  step("期限切れ：注文を EXPIRED にする（決済記録なし）。期限切れの注文では決済画面に移動しない");

  // ---- 9. 照合の失敗：金額・店舗の食い違い、紐付いていない Session ----
  const p4 = await startPurchase(op, storeA.storeCode, "ZODIAC");
  await ctl(`pay/${p4.sessionId}`, { amount: 200 });
  r = await webhook("checkout.session.completed", { id: p4.sessionId, object: "checkout.session" });
  assert.equal(((await r.json()) as { outcome: string }).outcome, "rejected");
  assert.equal((await txOf(p4.checkoutId)).length, 0);
  const p5 = await startPurchase(op, storeA.storeCode, "ZODIAC");
  await ctl(`pay/${p5.sessionId}`, { metadataStoreId: storeB.id });
  r = await webhook("checkout.session.completed", { id: p5.sessionId, object: "checkout.session" });
  assert.equal(((await r.json()) as { outcome: string }).outcome, "rejected");
  assert.equal((await txOf(p5.checkoutId)).length, 0);
  // 別の運営の注文の Session を、自分のブラウザの戻り先に入れても確定しない
  const op2 = await loggedIn(op2Id);
  const p6 = await startPurchase(op2, storeA.storeCode, "ZODIAC");
  await ctl(`pay/${p6.sessionId}`);
  r = await op.req(`/payment/return?session_id=${p6.sessionId}`);
  assert.match(await r.text(), /お支払いを確認できませんでした/);
  assert.equal((await txOf(p6.checkoutId)).length, 0);
  step("照合の失敗：金額の食い違い・店舗の食い違いは記録しない。他人の注文の Session は戻り先で確定しない");

  // ---- 10. 署名の不一致・本番の通知は受け付けない ----
  r = await webhook("checkout.session.completed", { id: p6.sessionId, object: "checkout.session" }, { secret: "whsec_wrong" });
  assert.equal(r.status, 400);
  r = await webhook("checkout.session.completed", { id: p6.sessionId, object: "checkout.session" }, { livemode: true });
  assert.equal(r.status, 400);
  assert.equal((await txOf(p6.checkoutId)).length, 0);
  // 正しい通知なら（Webhook は戻り先と違いブラウザに関係なく）確定する
  r = await webhook("checkout.session.completed", { id: p6.sessionId, object: "checkout.session" });
  assert.equal(((await r.json()) as { outcome: string }).outcome, "confirmed");
  step("Webhook：署名の不一致・本番の通知は 400（記録しない）。正しい通知で確定");

  // ---- 12. Apple Pay・Google Pay・PayPay（即時の確定）は確定。Link など他の方法は記録しない ----
  for (const method of ["apple_pay", "google_pay", "paypay"] as const) {
    const p = await startPurchase(op, storeA.storeCode, "ZODIAC");
    await ctl(`pay/${p.sessionId}`, { method });
    r = await webhook("checkout.session.completed", { id: p.sessionId, object: "checkout.session" });
    assert.equal(((await r.json()) as { outcome: string }).outcome, "confirmed", method);
    const [t] = await txOf(p.checkoutId);
    assert.deepEqual([t.get("stripePaymentMethod"), t.get("amount"), t.get("storeShare"), t.get("operatorShare"), t.get("countable")], [method, 100, 30, 70, false]);
    assert.equal((await fsdb().collection(C.fortuneSessions).doc(t.id).get()).get("status"), "PAID");
  }
  for (const method of ["link", "samsung_pay"]) {
    const p = await startPurchase(op, storeA.storeCode, "ZODIAC");
    await ctl(`pay/${p.sessionId}`, { method });
    r = await webhook("checkout.session.completed", { id: p.sessionId, object: "checkout.session" });
    assert.equal(((await r.json()) as { outcome: string }).outcome, "rejected", method);
    assert.equal((await txOf(p.checkoutId)).length, 0);
  }
  // Stripe が想定外の支払い方法を表示する Session になったら、決済画面に移動させない（注文にも紐付けない）
  fake.extraMethods = ["konbini"];
  op.jar.delete("fx_access");
  await op.req(`/s/${storeA.storeCode}`);
  r = await op.req("/api/checkout", { method: "POST", json: { fortuneType: "ZODIAC" } });
  const { checkoutId: cx } = (await r.json()) as { checkoutId: string };
  assert.equal((await op.req("/api/checkout/stripe-session", { method: "POST", json: {} })).status, 502);
  assert.equal((await fsdb().collection(C.checkouts).doc(cx).get()).get("providerPaymentId") ?? null, null);
  fake.extraMethods = [];
  step("Apple Pay・Google Pay・PayPay（即時）は確定し支払い方法を記録。Link・Samsung Pay は記録しない。想定外の支払い方法を表示する Session には移動しない");

  // ---- 13. PayPay の確定待ち（非同期）→ 期限の後に確定：確定するまで権利を付与しない。注文は閉じない ----
  const p9 = await startPurchase(op, storeA.storeCode, "ZODIAC");
  await ctl(`pay/${p9.sessionId}`, { method: "paypay", async: true });
  r = await webhook("checkout.session.completed", { id: p9.sessionId, object: "checkout.session" });
  assert.equal(((await r.json()) as { outcome: string }).outcome, "not_paid");
  r = await op.req(`/payment/return?session_id=${p9.sessionId}`);
  assert.equal(r.status, 200);
  assert.match(await r.text(), /お支払いを確認しています/);
  assert.equal((await txOf(p9.checkoutId)).length, 0, "確定前に決済記録が作られました");
  assert.equal((await fsdb().collection(C.fortuneSessions).where("tokenHash", "==", (await fsdb().collection(C.checkouts).doc(p9.checkoutId).get()).get("accessTokenHash")).get()).size, 0, "確定前に占い権利が作られました");
  // 注文の期限が過ぎても、確定待ちなら閉じない。決済画面へのボタンも新しい Session を作らず確認中の画面へ
  await fsdb().collection(C.checkouts).doc(p9.checkoutId).update({ expiresAt: new Date(Date.now() - 60_000) });
  assert.equal(((await (await op.req("/api/checkout/status")).json()) as { status: string }).status, "processing");
  r = await webhook("checkout.session.expired", { id: p9.sessionId, object: "checkout.session" });
  assert.equal(((await r.json()) as { outcome: string }).outcome, "unchanged");
  const createdBefore = fake.createCalls;
  r = await op.req("/api/checkout/stripe-session", { method: "POST", json: {} });
  assert.deepEqual(await r.json(), { status: "pending", url: `/payment/return?session_id=${p9.sessionId}` });
  assert.equal(fake.createCalls, createdBefore);
  assert.equal((await fsdb().collection(C.checkouts).doc(p9.checkoutId).get()).get("status"), "PROCESSING");
  await ctl(`async-succeed/${p9.sessionId}`);
  r = await webhook("checkout.session.async_payment_succeeded", { id: p9.sessionId, object: "checkout.session" });
  assert.equal(((await r.json()) as { outcome: string }).outcome, "confirmed");
  const [t9] = await txOf(p9.checkoutId);
  assert.deepEqual([t9.get("stripePaymentMethod"), t9.get("paymentStatus")], ["paypay", "SUCCEEDED"]);
  assert.equal(((await (await op.req("/api/checkout/status")).json()) as { status: string }).status, "succeeded");
  r = await op.req("/api/fortune", { method: "POST", json: { type: "ZODIAC", sign: "leo" } });
  assert.equal(r.status, 200, await r.clone().text());
  step("PayPay（確定待ち）：完了の通知では権利を付与しない（not_paid・記録なし）。期限後も注文を閉じず、新しい Session も作らない。確定の通知で記録し、占える");

  // ---- 14. PayPay の確定待ち → 失敗：失敗の通知（API で再確認）でだけ FAILED。権利なし ----
  const p10 = await startPurchase(op, storeA.storeCode, "ZODIAC");
  await ctl(`pay/${p10.sessionId}`, { method: "paypay", async: true });
  await webhook("checkout.session.completed", { id: p10.sessionId, object: "checkout.session" });
  await ctl(`async-fail/${p10.sessionId}`);
  // requires_payment_method になっただけ（失敗の通知の前）では閉じない
  assert.equal(((await (await op.req("/api/checkout/status")).json()) as { status: string }).status, "processing");
  assert.equal((await fsdb().collection(C.checkouts).doc(p10.checkoutId).get()).get("status"), "PROCESSING");
  r = await webhook("checkout.session.async_payment_failed", { id: p10.sessionId, object: "checkout.session" });
  assert.equal(((await r.json()) as { outcome: string }).outcome, "failed");
  const co10 = (await fsdb().collection(C.checkouts).doc(p10.checkoutId).get()).data()!;
  assert.deepEqual([co10.status, co10.failureCode], ["FAILED", "stripe_async_payment_failed"]);
  assert.equal((await txOf(p10.checkoutId)).length, 0);
  assert.equal(((await (await op.req("/api/checkout/status")).json()) as { status: string }).status, "failed");
  r = await op.req("/api/checkout/stripe-session", { method: "POST", json: {} });
  assert.equal(r.status, 410);
  assert.match(await r.text(), /お支払いが完了しませんでした/);
  step("PayPay（確定待ち）→ 失敗：requires_payment_method だけでは閉じず、失敗の通知を Stripe API で再確認して FAILED。記録・権利なし。新しい決済には進まず、選び直しを案内");

  // ---- 15. カードの拒否（requires_payment_method）→ 同じ決済画面で支払い直して成功 ----
  const p11 = await startPurchase(op, storeA.storeCode, "ZODIAC");
  await ctl(`decline/${p11.sessionId}`);
  r = await webhook("checkout.session.async_payment_failed", { id: p11.sessionId, object: "checkout.session" }); // 誤って届いても、Session が open なら失敗にしない
  assert.equal(((await r.json()) as { outcome: string }).outcome, "unchanged");
  assert.equal(((await (await op.req("/api/checkout/status")).json()) as { status: string }).status, "processing");
  r = await op.req("/api/checkout/stripe-session", { method: "POST", json: {} });
  assert.deepEqual(((await r.json()) as { url: string }).url, p11.url); // 同じ決済画面へ戻れる
  await ctl(`pay/${p11.sessionId}`);
  r = await webhook("checkout.session.completed", { id: p11.sessionId, object: "checkout.session" });
  assert.equal(((await r.json()) as { outcome: string }).outcome, "confirmed");
  assert.equal((await txOf(p11.checkoutId)).length, 1);
  step("カードの拒否（requires_payment_method）は失敗扱いにせず、同じ決済画面で支払い直して確定");

  // ---- 16. 返金の失敗 → 管理者が確認して占い権利を戻す（1回だけ） ----
  const opR = await loggedIn(opId);
  const p12 = await startPurchase(opR, storeA.storeCode, "ZODIAC");
  const pay12 = await ctl(`pay/${p12.sessionId}`);
  await webhook("checkout.session.completed", { id: p12.sessionId, object: "checkout.session" });
  const rf12 = await ctl(`refund/${pay12.charge}`, { status: "pending" });
  r = await webhook("charge.refunded", { id: pay12.charge, object: "charge" });
  assert.equal(((await r.json()) as { outcome: string }).outcome, "refund_pending");
  r = await opR.req("/api/fortune", { method: "POST", json: { type: "ZODIAC", sign: "leo" } });
  assert.notEqual(r.status, 200, "返金の処理中に占えました");
  assert.equal(await restoreStripeEntitlement(stripeTxIdOf(pay12.paymentIntent!), { userId: opId, role: "OPERATOR" }), "refund_not_failed"); // 処理中は戻せない
  await ctl(`refund-status/${rf12.refund}`, { status: "failed" });
  r = await webhook("refund.failed", { id: rf12.refund, object: "refund", charge: pay12.charge });
  assert.equal(((await r.json()) as { outcome: string }).outcome, "refund_failed");
  r = await webhook("refund.updated", { id: rf12.refund, object: "refund", charge: pay12.charge });
  assert.equal(((await r.json()) as { outcome: string }).outcome, "unchanged");
  const [t12] = await txOf(p12.checkoutId);
  assert.deepEqual([t12.get("refundStatus"), t12.get("refundNeedsReview"), t12.get("paymentStatus"), t12.get("amountRefunded"), t12.get("refundFailedAmount")], ["failed", true, "SUCCEEDED", 0, 100]);
  assert.equal((await fsdb().collection(C.fortuneSessions).doc(t12.id).get()).get("status"), "EXPIRED");
  const adminHtml = await (await op.req("/admin/transactions")).text();
  assert.match(adminHtml, /返金の確認が必要なテスト決済/);
  assert.match(adminHtml, /占い権利を戻す/);
  assert.equal(await restoreStripeEntitlement(t12.id, { userId: opId, role: "OPERATOR" }), "restored");
  assert.equal(await restoreStripeEntitlement(t12.id, { userId: opId, role: "OPERATOR" }), "not_eligible"); // 2回目は何もしない
  const ent12 = await fsdb().collection(C.fortuneSessions).doc(t12.id).get();
  assert.deepEqual([ent12.get("status"), ent12.get("suspendedByRefund"), ent12.get("restoredBy")], ["PAID", false, opId]);
  assert.equal((await fsdb().collection(C.transactions).doc(t12.id).get()).get("refundNeedsReview"), false);
  const audits = await fsdb().collection(C.auditLogs).where("targetId", "==", t12.id).get();
  assert.deepEqual(audits.docs.map((d) => [d.get("action"), d.get("actorUserId")]), [["stripe_test.entitlement_restored", opId]]);
  assert.doesNotMatch(await (await op.req("/admin/transactions")).text(), /返金の確認が必要なテスト決済/);
  r = await opR.req("/api/fortune", { method: "POST", json: { type: "ZODIAC", sign: "leo" } });
  assert.equal(r.status, 200, await r.clone().text());
  step("返金の失敗：refundStatus=failed・要確認として管理画面に表示。処理中は戻せない。管理者が戻すと権利が PAID に戻り占える（監査ログ1件。2回目は何もしない）");

  // ---- 17. /fortune?pay=stripe-test：運営だけの入口。無料の占いは今までどおり。無料の Cookie（fx_dev）は有料の権利を妨げない ----
  const STRIPE_LABEL = "円で始める（Stripeテスト決済）";
  const FREE_LABEL = "テストモード：無料で占う";
  for (const c of [anon, staff]) {
    await c.req(`/s/${storeA.storeCode}`);
    const html = await (await c.req("/fortune?pay=stripe-test")).text();
    assert.ok(!html.includes(STRIPE_LABEL) && !html.includes("実店舗のQRコードから開いてください"), "運営以外に Stripe の入口が見えました");
  }
  const opF = await loggedIn(opId);
  await opF.req("/s/test");
  assert.match(await (await opF.req("/fortune?pay=stripe-test")).text(), /実店舗のQRコードから開いてください/);
  await opF.req(`/s/${storeA.storeCode}`);
  for (const path of ["/fortune", "/fortune?pay=other", "/fortune?pay=STRIPE-TEST"]) {
    const html = await (await opF.req(path)).text();
    assert.ok(html.includes(FREE_LABEL) && !html.includes(STRIPE_LABEL), `${path} が無料の占いのままではありません`);
  }
  let html17 = await (await opF.req("/fortune?pay=stripe-test")).text();
  assert.ok(html17.includes(STRIPE_LABEL) && !html17.includes(FREE_LABEL), "Stripe の入口が表示されません");
  // (a) 無料の占いを済ませた後に Stripe で購入：注文を作ると fx_dev を消す → 支払い後は有料の入力画面
  r = await opF.req("/api/test-fortune", { method: "POST", json: { fortuneType: "BLOOD" } });
  assert.equal(r.status, 200, await r.clone().text());
  assert.ok(opF.jar.get("fx_dev"), "無料の占いの Cookie がありません");
  r = await opF.req("/api/fortune", { method: "POST", json: { type: "BLOOD", bloodType: "A", birthMonth: 5 } });
  assert.equal(r.status, 200, await r.clone().text());
  const pF = await startPurchase(opF, storeA.storeCode, "ZODIAC");
  assert.ok(!opF.jar.get("fx_dev"), "Stripe の注文を作っても fx_dev が残っています");
  await ctl(`pay/${pF.sessionId}`);
  r = await opF.req(`/payment/return?session_id=${pF.sessionId}`);
  assert.match(r.headers.get("location") ?? "", /\/fortune\/input$/);
  html17 = await (await opF.req("/fortune/input")).text();
  assert.ok(!html17.includes("テストモードのため決済をスキップしました"), "有料の入力画面になりません");
  r = await opF.req("/api/fortune", { method: "POST", json: { type: "ZODIAC", sign: "leo" } });
  assert.equal(r.status, 200, await r.clone().text());
  const [tF] = await txOf(pF.checkoutId);
  assert.equal((await fsdb().collection(C.fortuneSessions).doc(tF.id).get()).get("status"), "USED");
  assert.match(await (await opF.req("/fortune/result")).text(), /健康運/);
  // (b) 支払いの確認中に無料の占いを始めても、確定後は有料の権利が優先される。未使用の権利があれば無料の占いは始めない
  const pG = await startPurchase(opF, storeA.storeCode, "ZODIAC");
  r = await opF.req("/api/test-fortune", { method: "POST", json: { fortuneType: "BLOOD" } });
  assert.equal(r.status, 200, "支払いの確認中に無料の占いを始められません");
  assert.ok(opF.jar.get("fx_dev"));
  await ctl(`pay/${pG.sessionId}`);
  r = await webhook("checkout.session.completed", { id: pG.sessionId, object: "checkout.session" });
  assert.equal(((await r.json()) as { outcome: string }).outcome, "confirmed");
  html17 = await (await opF.req("/fortune/input")).text();
  assert.ok(!html17.includes("テストモードのため決済をスキップしました"), "無料の占いの Cookie が有料の権利を隠しました");
  r = await opF.req("/api/test-fortune", { method: "POST", json: { fortuneType: "BLOOD" } });
  assert.equal(r.status, 409);
  assert.equal(((await r.json()) as { error: { code: string } }).error.code, "paid_session_exists");
  r = await opF.req("/api/fortune", { method: "POST", json: { type: "ZODIAC", sign: "virgo" } });
  assert.equal(r.status, 200, await r.clone().text());
  const [tG] = await txOf(pG.checkoutId);
  assert.equal((await fsdb().collection(C.fortuneSessions).doc(tG.id).get()).get("status"), "USED");
  assert.deepEqual([tG.get("livemode"), tG.get("countable")], [false, false]);
  // 有料の権利を使った後は、無料の占いを今までどおり始められる
  r = await opF.req("/api/test-fortune", { method: "POST", json: { fortuneType: "ZODIAC" } });
  assert.equal(r.status, 200);
  step("/fortune?pay=stripe-test：運営だけに Stripe の入口（テスト店舗では実店舗の案内）。パラメーターなしは無料のまま。fx_dev は注文時に消し、確認中に作られても確定後は有料の権利を優先。未使用の権利があれば無料は 409");

  // ---- 18. Managed Payments を使わない・Session の期限は作成時刻から・既存の Session の再利用 ----
  // (a) 占いを選んでから時間がたってボタンを押しても開ける（期限は押した時刻から31分。注文の期限も同じ値にそろう）
  const cA = await createOrder(op, storeA.storeCode);
  await fsdb().collection(C.checkouts).doc(cA).update({ expiresAt: new Date(Date.now() + 26 * 60_000) }); // 選んでから5分たった状態
  r = await op.req("/api/checkout/stripe-session", { method: "POST", json: {} });
  assert.equal(r.status, 200, `時間がたつと決済画面を開けません: ${await r.clone().text()}`);
  const jA = (await r.json()) as { status: string; url: string };
  assert.equal(jA.status, "redirect");
  const sA = fake.sessions.get(jA.url.split("/").pop()!)!;
  assert.ok(Number(sA.expires_at) >= Math.floor(Date.now() / 1000) + 30 * 60, "Session の期限が作成から30分未満です");
  assert.equal(sA.managed_payments_param, "false");
  assert.deepEqual(sA.managed_payments, { enabled: false });
  const coA = (await fsdb().collection(C.checkouts).doc(cA).get()).data()!;
  assert.equal(coA.providerPaymentId, sA.id);
  assert.equal(coA.expiresAt.toDate().getTime(), Number(sA.expires_at) * 1000, "注文の期限が Session の期限とそろっていません");
  // もう一度押しても Session を作り直さない（同じ決済画面。冪等キーの食い違いにもならない）。
  // 冪等キーの記録を消して「数分後に押した（期限・冪等キーが変わる）」状態にしても、紐付いた Session を使う
  const callsA = fake.createCalls;
  fake.idem.clear();
  for (let i = 0; i < 2; i++) {
    r = await op.req("/api/checkout/stripe-session", { method: "POST", json: {} });
    assert.equal(((await r.json()) as { url: string }).url, jA.url);
  }
  assert.equal(fake.createCalls, callsA);
  // (b) 注文の期限が過ぎてから押したら Session を作らない（410）
  const cB = await createOrder(op, storeA.storeCode);
  await fsdb().collection(C.checkouts).doc(cB).update({ expiresAt: new Date(Date.now() - 1000) });
  r = await op.req("/api/checkout/stripe-session", { method: "POST", json: {} });
  assert.equal(r.status, 410);
  assert.equal(fake.createCalls, callsA);
  assert.equal((await fsdb().collection(C.checkouts).doc(cB).get()).get("providerPaymentId") ?? null, null);
  // (c) Stripe の応答で Managed Payments が有効なら、決済画面に移動しない（注文にも紐付けない）
  fake.forceManagedResponse = true;
  const cC = await createOrder(op, storeA.storeCode);
  r = await op.req("/api/checkout/stripe-session", { method: "POST", json: {} });
  assert.equal(r.status, 502);
  assert.equal((await fsdb().collection(C.checkouts).doc(cC).get()).get("providerPaymentId") ?? null, null);
  fake.forceManagedResponse = false;
  // (d) 確定時に取り直した Session が Managed Payments なら記録しない
  const pM = await startPurchase(op, storeA.storeCode, "ZODIAC");
  await ctl(`pay/${pM.sessionId}`);
  fake.sessions.get(pM.sessionId)!.managed_payments = { enabled: true };
  r = await webhook("checkout.session.completed", { id: pM.sessionId, object: "checkout.session" });
  assert.equal(((await r.json()) as { outcome: string }).outcome, "rejected");
  assert.equal((await txOf(pM.checkoutId)).length, 0);
  step("Managed Payments：enabled=false を明示（アカウントの既定が有効でも決済画面を開ける）。応答・確定時に有効なら移動・記録しない。期限は押した時刻から31分で注文の期限もそろう。再度押しても同じ Session。期限切れの注文では作らない");

  // ---- 11. 売上・精算に含めない（テスト決済） ----
  assert.deepEqual(await monthTotals(ym), before.month);
  assert.deepEqual(await monthTotals(ym, storeA.id), before.monthA);
  const prev = shiftYearMonth(ym, -1);
  const p7 = await startPurchase(op, storeA.storeCode, "ZODIAC");
  const lastMonth = Math.floor(new Date(`${prev}-15T12:00:00+09:00`).getTime() / 1000);
  await ctl(`pay/${p7.sessionId}`, { created: lastMonth });
  await webhook("checkout.session.completed", { id: p7.sessionId, object: "checkout.session" });
  assert.equal((await txOf(p7.checkoutId)).length, 1);
  await generateSettlements(prev, SYSTEM);
  const st = await listSettlements({ yearMonth: prev, storeId: storeA.id });
  assert.ok(st.every((x) => x.s.storeShare === 0 && x.s.transactionCount === 0), "テスト決済が精算に含まれました");
  step("テスト決済は売上（今月・店舗別）に含めず、月次精算（先月分）にも含めない");

  console.log("\nSTRIPE E2E PASSED");
}

main()
  .then(() => {
    stripeServer.close();
    process.exit(0);
  })
  .catch((e) => {
    console.error("\nSTRIPE E2E FAILED:", e);
    stripeServer.close();
    process.exit(1);
  });
