/**
 * Stripe の Webhook の通知の処理状態（webhookEvents の state・回数・最後のエラー・対象の ID）の E2E 検証。
 * Firestore の webhookEvents を直接読んで確かめる。
 *  - 正常：RECEIVED → PROCESSED（processedAt と同時）。同じ通知の再送は処理済み（何も書かない）
 *  - 一時的な失敗：RETRYABLE・処理済みにしない → 再送で PROCESSED（二重に反映しない）
 *  - 処理済みにする直前の停止：反映済み・RETRYABLE → 再送で PROCESSED（二重に反映しない）
 *  - 失敗の状態も記録できない（処理中の強制終了と同じ）：RECEIVED のまま → 途中で止まった通知として見つけられる
 *  - 以前の記録（state などの項目が無い）でも動く
 *  - 通知の本文・カード情報・個人情報は保存しない
 * 本物の Stripe・本番の Firebase には一切接続しない（localhost の模擬 Stripe と Firestore Emulator の demo- プロジェクトだけ。キーは形だけの偽物）。
 *
 *   firebase emulators:start --only firestore --project demo-uranai
 *   （別ターミナル）FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 FIREBASE_PROJECT_ID=demo-uranai-webhook-state DB_PROVIDER=firestore npm run e2e:stripe-webhook-state
 */
import "dotenv/config";
import assert from "node:assert/strict";
import Stripe from "stripe";
import { FieldValue } from "firebase-admin/firestore";
import { createFakeStripe } from "./lib/fake-stripe";
import { C, fsdb, safeId } from "@/lib/firestore/admin";
import { dataProvider } from "@/lib/data-provider";
import { createStore } from "@/lib/services/stores";
import { createCheckout, listUnfinishedWebhookEvents } from "@/lib/firestore/payments";
import { createSimulatedStripeRuntime, STRIPE_SESSION_TTL_MS, type StripeRuntime } from "@/lib/payments/stripe-checkout";
import { startStripeCheckout } from "@/lib/payments/stripe-confirm";
import { handleStripeWebhook } from "@/lib/payments/stripe-webhook";

const SYSTEM = { userId: null, role: "SYSTEM" as const };
const step = (msg: string) => console.log(`  ✓ ${msg}`);
const ORIGIN = "http://localhost:3000";
const PORT = 12161;
const KEY = "sk_live_e2e_webhook_state_dummy";
const stripe = createFakeStripe({ port: PORT, mode: "live", apiKey: KEY });
const fake = stripe.fake;

/** テスト専用のフック：処理済みにする直前に止める通知・失敗の状態を記録しない通知・決済確定の直後に止める回数 */
const hook = { stopBeforeFinish: new Set<string>(), skipFailureRecord: new Set<string>(), crashAfterConfirm: 0 };

const signer = new Stripe("sk_test_signer");
let evN = 0;
type Ev = { type: string; object: Record<string, unknown>; id: string; created: number };
const ev = (type: string, object: Record<string, unknown>): Ev => ({ type, object, id: `evt_wst_${++evN}_${Date.now()}`, created: Math.floor(Date.now() / 1000) - 5 });
async function deliver(rt: StripeRuntime, e: Ev) {
  const payload = JSON.stringify({ id: e.id, object: "event", type: e.type, livemode: rt.mode === "live", created: e.created, data: { object: e.object } });
  const sig = signer.webhooks.generateTestHeaderString({ payload, secret: rt.webhookSecret });
  return handleStripeWebhook(payload, sig, rt);
}
const outcomeOf = (r: { body: unknown }) => (r.body as { outcome?: string }).outcome;

type Pay = { sessionId: string; charge: string; txId: string };
async function paidOnly(rt: StripeRuntime, storeCode: string): Promise<Pay> {
  const { accessToken } = await createCheckout(storeCode, "ZODIAC", { provider: "stripe", ttlMs: STRIPE_SESSION_TTL_MS });
  const r = await startStripeCheckout(accessToken, ORIGIN, rt);
  const sessionId = (r as { url: string }).url.split("/").pop()!;
  const p = await stripe.ctl(`pay/${sessionId}`, { fee: 4 });
  return { sessionId, charge: p.charge!, txId: `stripe_${p.paymentIntent!}` };
}
// 決済確定の通知の本文には、Stripe と同じく個人情報（購入者のメール）が入っている。記録に残らないことを確かめる
const completedEv = (p: Pay) => ev("checkout.session.completed", { id: p.sessionId, object: "checkout.session", customer_details: { email: "buyer@example.com", name: "購入者" } });
const refundEv = (p: Pay) => ev("charge.refunded", { id: p.charge, object: "charge" });
const evRef = (eventId: string) => fsdb().collection(C.webhookEvents).doc(safeId("stripe", eventId));
const evDoc = async (eventId: string) => (await evRef(eventId).get()).data() ?? null;
const txDoc = async (id: string) => (await fsdb().collection(C.transactions).doc(id).get()).data()!;
/** 処理が終わっていない Stripe の通知のうち、止まったとみなせるもの（全ページ） */
async function allUnfinished(staleMs: number) {
  const out = [];
  let cursor: string | null = null;
  for (;;) {
    const page: Awaited<ReturnType<typeof listUnfinishedWebhookEvents>> = await listUnfinishedWebhookEvents({ staleMs, cursor });
    out.push(...page.records);
    if (!page.hasMore) return out;
    cursor = page.nextCursor;
  }
}

const ALLOWED = new Set(["provider", "eventId", "type", "processedAt", "createdAt", "state", "attempts", "lastAttemptAt", "lastError", "replayLeaseUntil", "objectId", "chargeId", "livemode", "eventCreatedAt", "recordedReviewIds", "leaseOwner", "leaseExpiresAt"]);
function assertNoBody(d: Record<string, unknown>, at: string) {
  for (const k of Object.keys(d)) assert.ok(ALLOWED.has(k), `${at}: webhookEvents に想定外の項目 ${k}`);
  assert.doesNotMatch(JSON.stringify(d), /buyer@example\.com|購入者|whsec_|sk_(live|test)_|"card"|last4/i, `${at}: 通知の本文・個人情報・秘密情報が保存されています`);
}

async function main() {
  const host = process.env.FIRESTORE_EMULATOR_HOST ?? "";
  assert.match(host, /^(127\.0\.0\.1|localhost|\[::1\]):\d+$/, "FIRESTORE_EMULATOR_HOST（localhost の Emulator）が必要です");
  assert.match(process.env.FIREBASE_PROJECT_ID ?? "", /^demo-/, "FIREBASE_PROJECT_ID は demo- で始まる Emulator 用の ID にしてください");
  assert.equal(dataProvider(), "firestore");
  for (const k of ["STRIPE_SECRET_KEY", "STRIPE_LIVE_CHECKOUT", "STRIPE_LIVE_OPERATOR_TEST", "VERCEL_ENV"]) delete process.env[k];
  await stripe.start();
  const rt = createSimulatedStripeRuntime("live", {
    apiBase: `http://127.0.0.1:${PORT}`,
    secretKey: KEY,
    webhookSecret: "whsec_e2e_webhook_state_dummy",
    testHooks: {
      beforeFinishWebhookEvent: (id) => {
        if (hook.stopBeforeFinish.delete(id)) throw Object.assign(new Error("simulated stop right before marking processed"), { name: "SimulatedStop" });
      },
      skipFailureStateRecord: (id) => hook.skipFailureRecord.delete(id),
      afterConfirmCommit: () => {
        if (hook.crashAfterConfirm > 0) {
          hook.crashAfterConfirm--;
          throw Object.assign(new Error("simulated crash"), { name: "SimulatedCrash" });
        }
      },
    },
  });
  console.log(`Stripe webhook state E2E (emulator ${host} / ${process.env.FIREBASE_PROJECT_ID}, fake Stripe live :${PORT})`);
  const store = await createStore({ name: `通知状態検証店舗 ${Date.now()}`, contactName: "", postalCode: "", address: "", phone: "", email: "" }, SYSTEM);
  const code = store.storeCode;

  // ================= 1. 正常：PROCESSED と processedAt・対象の ID・モード・作成日時。本文は保存しない =================
  const p1 = await paidOnly(rt, code);
  {
    const e = completedEv(p1);
    const r = await deliver(rt, e);
    assert.deepEqual([r.status, outcomeOf(r)], [200, "confirmed"]);
    const d = (await evDoc(e.id))!;
    assert.equal(d.state, "PROCESSED");
    assert.ok(d.processedAt, "PROCESSED なのに processedAt がありません");
    assert.deepEqual([d.attempts, d.lastError, d.replayLeaseUntil, d.objectId, d.chargeId, d.livemode], [1, null, null, p1.sessionId, null, true]);
    assert.equal(d.eventCreatedAt.toDate().getTime(), e.created * 1000);
    assert.ok(d.lastAttemptAt);
    assertNoBody(d, "正常");
    // 同じ通知の再送：処理済み（何も書かない）
    const before = JSON.stringify(d);
    assert.deepEqual((await deliver(rt, e)).body, { received: true, duplicate: true });
    assert.equal(JSON.stringify(await evDoc(e.id)), before, "処理済みの通知の再送で記録が変わりました");
    step("正常：state=PROCESSED と processedAt を同時に記録。回数1・対象の ID・モード・作成日時。本文・個人情報は保存しない。同じ通知の再送は何も書かない");
  }

  // ================= 2. 同時の同じ通知：決済記録1件・最後は PROCESSED =================
  {
    const p = await paidOnly(rt, code);
    const e = completedEv(p);
    const rs = await Promise.all([deliver(rt, e), deliver(rt, e), deliver(rt, e)]);
    // 処理中の同じ通知は 409（処理権を取れない）。Stripe と同じく後で再送すると処理済み（200）
    for (const r of rs) assert.ok(r.status === 200 || r.status === 409, `想定外の応答 ${r.status}`);
    if (rs.some((r) => r.status === 409)) assert.deepEqual((await deliver(rt, e)).body, { received: true, duplicate: true });
    const d = (await evDoc(e.id))!;
    assert.equal(d.state, "PROCESSED");
    assert.equal(d.attempts, 1, `処理権を取った回数 ${d.attempts}（処理中の同じ通知は処理権を取れない）`);
    assert.equal((await fsdb().collection(C.transactions).where("stripeCheckoutSessionId", "==", p.sessionId).get()).size, 1, "決済記録が二重に作られました");
    step(`同時の同じ通知×3：決済記録は1件、最後は PROCESSED・処理権を取った回数1（409 は ${rs.filter((r) => r.status === 409).length} 件で再送は処理済み）`);
  }

  // ================= 3. 一時的な失敗（返金）：RETRYABLE・処理済みにしない → 再送で PROCESSED =================
  {
    await stripe.ctl(`refund/${p1.charge}`);
    fake.failCalls.push({ path: /^\/v1\/refunds$/, method: "GET", skip: 0, count: 1 });
    const e = refundEv(p1);
    const r1 = await deliver(rt, e);
    assert.equal(r1.status, 500);
    let d = (await evDoc(e.id))!;
    assert.deepEqual([d.state, d.processedAt, d.attempts, d.chargeId, d.objectId], ["RETRYABLE", null, 1, p1.charge, p1.charge]);
    assert.ok(typeof d.lastError === "string" && d.lastError.length > 0);
    assert.equal((await txDoc(p1.txId)).refundStatus, null, "失敗した通知で返金を反映しました");
    const r2 = await deliver(rt, e);
    assert.deepEqual([r2.status, outcomeOf(r2)], [200, "refunded"]);
    d = (await evDoc(e.id))!;
    assert.deepEqual([d.state, Boolean(d.processedAt), d.attempts], ["PROCESSED", true, 2]);
    assert.equal((await txDoc(p1.txId)).amountRefunded, 100);
    step("一時的な失敗（返金の一覧の取得）：500・state=RETRYABLE・処理済みにしない・エラーの名前 → 再送で PROCESSED（回数2・返金は1回）");
  }

  // ================= 4. 処理済みにする直前の停止（異議申し立て）：反映済み・RETRYABLE → 再送で二重にしない =================
  {
    const p = await paidOnly(rt, code);
    assert.equal(outcomeOf(await deliver(rt, completedEv(p))), "confirmed");
    const dp = stripe.addDispute(p.charge, { status: "lost" });
    const e = ev("charge.dispute.closed", { id: dp, object: "dispute", charge: p.charge });
    hook.stopBeforeFinish.add(e.id);
    assert.equal((await deliver(rt, e)).status, 500);
    let d = (await evDoc(e.id))!;
    assert.deepEqual([d.state, d.processedAt, d.lastError, d.objectId, d.chargeId], ["RETRYABLE", null, "SimulatedStop", dp, p.charge]);
    assert.equal((await txDoc(p.txId)).paymentStatus, "CHARGEBACK", "（前提）処理は終わっている");
    const adjBefore = (await fsdb().collection(C.settlementAdjustments).where("transactionId", "==", p.txId).get()).size;
    const r2 = await deliver(rt, e);
    assert.deepEqual([r2.status, outcomeOf(r2)], [200, "unchanged"], "再送で二重に反映しました");
    d = (await evDoc(e.id))!;
    assert.deepEqual([d.state, Boolean(d.processedAt), d.attempts], ["PROCESSED", true, 2]);
    assert.equal((await fsdb().collection(C.settlementAdjustments).where("transactionId", "==", p.txId).get()).size, adjBefore);
    step("処理済みにする直前の停止（異議申し立ての敗訴）：反映は済み・RETRYABLE → 再送は「変化なし」で PROCESSED（二重に反映しない）");
  }

  // ================= 5. 失敗の状態も記録できない（強制終了と同じ）：RECEIVED のまま → 見つけられる → 再送で回復 =================
  {
    const p = await paidOnly(rt, code);
    const e = completedEv(p);
    hook.crashAfterConfirm = 1;
    hook.skipFailureRecord.add(e.id);
    assert.equal((await deliver(rt, e)).status, 500);
    const d = (await evDoc(e.id))!;
    assert.deepEqual([d.state, d.processedAt, d.attempts, d.lastError], ["RECEIVED", null, 1, null]);
    const found = await allUnfinished(0);
    const hit = found.find((x) => x.eventId === e.id);
    assert.ok(hit, "途中で止まった通知を見つけられません");
    assert.deepEqual([hit!.state, hit!.objectId, hit!.type], ["RECEIVED", p.sessionId, "checkout.session.completed"]);
    assert.ok(!(await allUnfinished(3_600_000)).some((x) => x.eventId === e.id), "処理中かもしれない新しい通知を、止まったものとして扱いました");
    assert.equal((await txDoc(p.txId)).recheckState, "PENDING", "（前提）決済確定の直後に止まった");
    // 強制終了と同じなので処理権は外れていない：期限内の再送は 409（処理済みにしない）
    assert.ok(d.leaseOwner && d.leaseExpiresAt, "（前提）処理権が残っています");
    const busy = await deliver(rt, e);
    assert.equal(busy.status, 409, "期限内の処理権がある通知を処理しました");
    assert.equal((await evDoc(e.id))!.attempts, 1, "処理権を取れなかった再送を回数に数えました");
    // 処理権の期限が過ぎた後の再送：処理権を取り直して PROCESSED（期限が過ぎたことを、記録の期限を過去にして再現する）
    await evRef(e.id).update({ leaseExpiresAt: new Date(Date.now() - 1000) });
    const r2 = await deliver(rt, e);
    assert.equal(r2.status, 200);
    const done = (await evDoc(e.id))!;
    assert.deepEqual([done.state, done.attempts, done.leaseOwner, done.leaseExpiresAt, (await txDoc(p.txId)).recheckState], ["PROCESSED", 2, null, null, "DONE"]);
    assert.ok(!(await allUnfinished(0)).some((x) => x.eventId === e.id));
    step("失敗の状態も記録できない（強制終了と同じ）：RECEIVED のまま残り止まった通知として見つけられる。期限内の再送は 409、期限の後の再送で処理権を取り直して PROCESSED・再確認も完了");
  }

  // ================= 6. 以前の記録（state などの項目が無い）との互換 =================
  {
    const p = await paidOnly(rt, code);
    const e = completedEv(p);
    await evRef(e.id).set({ provider: "stripe", eventId: e.id, type: e.type, processedAt: null, createdAt: FieldValue.serverTimestamp() }); // 以前の形（途中で止まった）
    const r = await deliver(rt, e);
    assert.deepEqual([r.status, outcomeOf(r)], [200, "confirmed"]);
    const d = (await evDoc(e.id))!;
    assert.deepEqual([d.state, Boolean(d.processedAt), d.attempts, d.objectId, d.livemode, d.replayLeaseUntil], ["PROCESSED", true, 1, p.sessionId, true, null]);
    // 以前の形の処理済みの記録：再送は処理済み（何も書かない）
    const old = ev("charge.refunded", { id: "ch_live_legacy_000001", object: "charge" });
    await evRef(old.id).set({ provider: "stripe", eventId: old.id, type: old.type, processedAt: new Date(), createdAt: new Date() });
    assert.deepEqual((await deliver(rt, old)).body, { received: true, duplicate: true });
    assert.equal((await evDoc(old.id))!.state, undefined, "以前の処理済みの記録を書き換えました");
    step("以前の記録：途中で止まった以前の形は処理し直して項目を補う（PROCESSED）。以前の形の処理済みは処理済みのまま書き換えない");
  }

  console.log("\nSTRIPE WEBHOOK STATE E2E PASSED");
}

main()
  .then(async () => {
    await stripe.stop();
    process.exit(0);
  })
  .catch(async (e) => {
    console.error("\nSTRIPE WEBHOOK STATE E2E FAILED:", e);
    await stripe.stop().catch(() => {});
    process.exit(1);
  });
