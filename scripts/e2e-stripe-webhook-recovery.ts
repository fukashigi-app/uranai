/**
 * Stripe の Webhook の通知の復旧（自動・手動で共通の recoverStripeWebhookEvent・runStripeWebhookRecovery）の E2E 検証
 * （Firestore Emulator と模擬 Stripe だけ）。webhookEvents・決済記録・決済要確認を直接読んで確かめる。
 *  - 途中で止まった（処理権の期限切れ）・失敗した（RETRYABLE）通知を見つけ、Stripe API から取り直して Webhook と同じ処理で反映する
 *    （決済確定・返金・異議申し立て・別の環境・決済要確認の重複の防止）
 *  - 処理済みは何もしない。処理中（期限内の処理権）は待つ。同じ通知の同時の復旧・Webhook との競合でも1回だけ反映する
 *  - Stripe API の失敗・通知を取得できない（保存期間切れ）・処理の失敗は処理済みにしない（理由を記録）
 *  - ページ・件数・時間の上限、復旧できない古い通知が後の通知を追い出さない
 * 本物の Stripe・本番の Firebase には一切接続しない（localhost の模擬 Stripe と Firestore Emulator の demo- プロジェクトだけ。キーは形だけの偽物）。
 *
 *   firebase emulators:start --only firestore --project demo-uranai
 *   （別ターミナル）FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 FIREBASE_PROJECT_ID=demo-uranai-webhook-recovery DB_PROVIDER=firestore npm run e2e:stripe-webhook-recovery
 */
import "dotenv/config";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import Stripe from "stripe";
import { createFakeStripe } from "./lib/fake-stripe";
import { C, fsdb, safeId } from "@/lib/firestore/admin";
import { dataProvider } from "@/lib/data-provider";
import { createStore } from "@/lib/services/stores";
import { paymentReviewId } from "@/lib/firestore/payment-reviews";
import { acquireWebhookEventLease, createCheckout, readWebhookRecoveryRun, recordWebhookEventFailure } from "@/lib/firestore/payments";
import { createSimulatedStripeRuntime, createStripeCheckoutSession, STRIPE_SESSION_TTL_MS, stripeEnvTag, stripeSessionExpiry, type StripeRuntime } from "@/lib/payments/stripe-checkout";
import { startStripeCheckout } from "@/lib/payments/stripe-confirm";
import { handleStripeWebhook } from "@/lib/payments/stripe-webhook";
import { recoverStripeWebhookEvent, runStripeWebhookRecovery } from "@/lib/payments/webhook-recovery";
import { RECOVERY_MAX_AUTO_ATTEMPTS } from "@/lib/payments/webhook-recovery-rules";

const SYSTEM = { userId: null, role: "SYSTEM" as const };
const step = (msg: string) => console.log(`  ✓ ${msg}`);
const ORIGIN = "http://localhost:3000";
const PORT = 12195;
const KEY = "sk_test_e2e_webhook_recovery_dummy";
const stripe = createFakeStripe({ port: PORT, mode: "test", apiKey: KEY });
const hooks = { failReview: false, failFinish: new Set<string>() };

const signer = new Stripe("sk_test_signer");
let evN = 0;
type Ev = { type: string; object: Record<string, unknown>; id: string };
/** 通知を作り、模擬 Stripe にも保存する（Stripe が保存している通知＝events.retrieve で取得できる） */
function ev(type: string, object: Record<string, unknown>): Ev {
  const e = { type, object, id: `evt_rcv_${++evN}_${Date.now()}` };
  stripe.fake.events.set(e.id, { id: e.id, object: "event", type, livemode: false, created: Math.floor(Date.now() / 1000), data: { object } });
  return e;
}
async function deliver(rt: StripeRuntime, e: Ev) {
  const payload = JSON.stringify({ id: e.id, object: "event", type: e.type, livemode: rt.mode === "live", data: { object: e.object } });
  return handleStripeWebhook(payload, signer.webhooks.generateTestHeaderString({ payload, secret: rt.webhookSecret }), rt);
}
/** 1回だけ失敗させる（Stripe API の1回の呼び出し） */
const failOnce = (path: RegExp, method = "GET") => stripe.fake.failCalls.push({ path, method, skip: 0, count: 1 });
/** Webhook の受信で失敗させて、RETRYABLE の記録を作る（Stripe の再送が終わった通知の再現） */
async function deliverFailing(rt: StripeRuntime, e: Ev, path: RegExp) {
  failOnce(path);
  const r = await deliver(rt, e);
  assert.equal(r.status, 500, `失敗させた受信が ${r.status}`);
  assert.equal((await evDoc(e.id))!.state, "RETRYABLE");
}

type Pay = { checkoutId: string; sessionId: string; charge: string; pi: string; txId: string };
async function paidOnly(rt: StripeRuntime, storeCode: string): Promise<Pay> {
  const { checkoutId, accessToken } = await createCheckout(storeCode, "ZODIAC", { provider: "stripe", ttlMs: STRIPE_SESSION_TTL_MS });
  const r = await startStripeCheckout(accessToken, ORIGIN, rt);
  const sessionId = (r as { url: string }).url.split("/").pop()!;
  const p = await stripe.ctl(`pay/${sessionId}`, { fee: 4 });
  return { checkoutId, sessionId, charge: p.charge!, pi: p.paymentIntent!, txId: `stripe_${p.paymentIntent!}` };
}
const completedEv = (p: { sessionId: string }) => ev("checkout.session.completed", { id: p.sessionId, object: "checkout.session" });
const refundEv = (p: Pay) => ev("charge.refunded", { id: p.charge, object: "charge" });
const evRef = (id: string) => fsdb().collection(C.webhookEvents).doc(safeId("stripe", id));
const evDoc = async (id: string) => (await evRef(id).get()).data() ?? null;
const txDoc = async (id: string) => (await fsdb().collection(C.transactions).doc(id).get()).data() ?? null;
const txCount = async (sessionId: string) => (await fsdb().collection(C.transactions).where("stripeCheckoutSessionId", "==", sessionId).get()).size;
const reviewOf = async (kind: Parameters<typeof paymentReviewId>[0], objectId: string) => (await fsdb().collection(C.paymentReviews).doc(paymentReviewId(kind, objectId)).get()).data() ?? null;
const eventsCalls = () => stripe.fake.callLog.filter((c) => c.startsWith("GET /v1/events/")).length;
/** 最後の処理から時間がたったことにする（テストの準備だけ。復旧の対象の時間の条件を満たす） */
const age = (id: string, ms = 60 * 60 * 1000) => evRef(id).update({ lastAttemptAt: new Date(Date.now() - ms) });

async function main() {
  const host = process.env.FIRESTORE_EMULATOR_HOST ?? "";
  assert.match(host, /^(127\.0\.0\.1|localhost|\[::1\]):\d+$/, "FIRESTORE_EMULATOR_HOST（localhost の Emulator）が必要です");
  assert.match(process.env.FIREBASE_PROJECT_ID ?? "", /^demo-/, "FIREBASE_PROJECT_ID は demo- で始まる Emulator 用の ID にしてください");
  assert.equal(dataProvider(), "firestore");
  for (const k of ["STRIPE_SECRET_KEY", "STRIPE_LIVE_CHECKOUT", "STRIPE_LIVE_OPERATOR_TEST", "VERCEL_ENV"]) delete process.env[k];
  await stripe.start();
  const base = { apiBase: `http://127.0.0.1:${PORT}`, secretKey: KEY, webhookSecret: "whsec_e2e_webhook_recovery_dummy" };
  const rt = createSimulatedStripeRuntime("test", {
    ...base,
    testHooks: {
      beforeReviewRecord: () => {
        if (hooks.failReview) throw Object.assign(new Error("simulated review write failure"), { name: "FirebaseError" });
      },
      beforeFinishWebhookEvent: (id) => {
        if (hooks.failFinish.has(id)) {
          hooks.failFinish.delete(id);
          throw Object.assign(new Error("simulated stop before finish"), { name: "SimulatedStop" });
        }
      },
    },
  });
  const other = createSimulatedStripeRuntime("test", { ...base, envTag: stripeEnvTag("demo-uranai-recovery-other-env") });
  console.log(`Stripe webhook recovery E2E (emulator ${host} / ${process.env.FIREBASE_PROJECT_ID}, fake Stripe test :${PORT})`);
  const store = await createStore({ name: `復旧検証店舗 ${Date.now()}`, contactName: "", postalCode: "", address: "", phone: "", email: "" }, SYSTEM);
  const code = store.storeCode;

  // 1. 発見と RETRYABLE の再処理（決済確定）。最後の処理からの時間が短い通知はまだ対象にしない
  const p1 = await paidOnly(rt, code);
  const e1 = completedEv(p1);
  await deliverFailing(rt, e1, /^\/v1\/checkout\/sessions\//);
  {
    const fresh = await runStripeWebhookRecovery(rt, { source: "cron" });
    assert.equal(fresh.scanned, 0, "失敗した直後の通知を対象にしました（Stripe の再送と重ならないよう時間をおく）");
    await age(e1.id);
    const s = await runStripeWebhookRecovery(rt, { source: "cron" });
    assert.deepEqual([s.status, s.scanned, s.candidates, s.attempted, s.results.recovered], ["completed", 1, 1, 1, 1]);
    const d = (await evDoc(e1.id))!;
    assert.deepEqual([d.state, Boolean(d.processedAt), d.leaseOwner, d.recoveryAttempts, d.lastRecoveryResult, d.lastRecoveryError], ["PROCESSED", true, null, 1, "recovered", null]);
    assert.equal(await txCount(p1.sessionId), 1);
    const run = (await readWebhookRecoveryRun())!;
    assert.deepEqual([run.source, run.status, run.counts.attempted, run.counts.recovered], ["cron", "completed", 1, 1]);
    const again = await runStripeWebhookRecovery(rt, { source: "cron" });
    assert.equal(again.scanned, 0, "処理済みの通知が一覧に残っています");
    step("RETRYABLE の決済確定の通知：30分たってから見つけ、Stripe から取り直して確定（PROCESSED・復旧1回）。実行の件数を記録。処理済みは次から対象外");
  }

  // 2. 処理済みの通知：何もしない（Stripe にも問い合わせない）。記録の無い ID・形の違う ID も処理しない
  {
    const before = eventsCalls();
    assert.equal((await recoverStripeWebhookEvent(e1.id, rt)).result, "already_processed");
    const unknown = `evt_unknown_${Date.now()}`;
    assert.equal((await recoverStripeWebhookEvent(unknown, rt)).result, "not_found");
    assert.equal(await evDoc(unknown), null, "記録の無い ID の記録を作りました");
    assert.equal((await recoverStripeWebhookEvent("cs_test_not_event", rt)).result, "not_found");
    assert.equal(eventsCalls(), before, "処理済み・記録の無い通知で Stripe に問い合わせました");
    assert.equal(await txCount(p1.sessionId), 1);
    step("処理済みの通知は何もしない（Stripe に問い合わせない）。記録の無い ID・通知の ID の形でない値は処理しない（記録も作らない）");
  }

  // 3. 途中で止まった通知（処理権が残っている）：期限内は待つ。期限切れの後に再処理（返金）
  const p3 = await paidOnly(rt, code);
  assert.equal((await deliver(rt, completedEv(p3))).status, 200);
  await stripe.ctl(`refund/${p3.charge}`);
  const e3 = refundEv(p3);
  {
    const held = await acquireWebhookEventLease("stripe", e3.id, e3.type, { objectId: p3.charge, chargeId: p3.charge, livemode: false, eventCreatedAt: new Date() });
    assert.equal(held.status, "acquired"); // 処理を始めた直後に関数が止まった（処理権・RECEIVED のまま）
    await age(e3.id);
    const s = await runStripeWebhookRecovery(rt, { source: "cron" });
    assert.deepEqual([s.candidates, s.attempted], [0, 0], "処理権の期限内の通知を再処理しました");
    assert.equal((await recoverStripeWebhookEvent(e3.id, rt)).result, "busy");
    assert.equal((await txDoc(p3.txId))!.paymentStatus, "SUCCEEDED");
    await evRef(e3.id).update({ leaseExpiresAt: new Date(Date.now() - 1000) }); // 期限切れ（6分を待つ代わり）
    const s2 = await runStripeWebhookRecovery(rt, { source: "cron" });
    assert.equal(s2.results.recovered, 1);
    assert.equal((await txDoc(p3.txId))!.paymentStatus, "REFUNDED");
    const d = (await evDoc(e3.id))!;
    assert.deepEqual([d.state, d.leaseOwner, d.recoveryAttempts], ["PROCESSED", null, 1]);
    step("途中で止まった返金の通知：処理権の期限内は自動・手動とも待つ（busy・回数に数えない）。期限切れの後に再処理して返金済み");
  }

  // 4. 異議申し立ての再処理
  {
    const p = await paidOnly(rt, code);
    assert.equal((await deliver(rt, completedEv(p))).status, 200);
    const dp = (await stripe.ctl(`dispute/${p.charge}`)).dispute!;
    const e = ev("charge.dispute.created", { id: dp, object: "dispute", charge: p.charge });
    await deliverFailing(rt, e, /^\/v1\/disputes\//);
    const o = await recoverStripeWebhookEvent(e.id, rt); // 手動は時間の条件なし
    assert.deepEqual([o.result, o.outcome], ["recovered", "dispute_open"]);
    assert.equal((await txDoc(p.txId))!.disputeStatus, "open");
    assert.deepEqual([(await recoverStripeWebhookEvent(e.id, rt)).result, (await txDoc(p.txId))!.disputeStatus], ["already_processed", "open"]);
    step("異議申し立ての通知の手動の再処理：対応中を反映。続けて実行しても処理済み（二重にしない）");
  }

  // 5. 同じ通知の同時の復旧・Webhook の再送との競合：反映は1回
  {
    const p = await paidOnly(rt, code);
    const e = completedEv(p);
    await deliverFailing(rt, e, /^\/v1\/checkout\/sessions\//);
    await age(e.id);
    const rs = await Promise.all([recoverStripeWebhookEvent(e.id, rt), recoverStripeWebhookEvent(e.id, rt), recoverStripeWebhookEvent(e.id, rt), deliver(rt, e), runStripeWebhookRecovery(rt, { source: "cron" })]);
    const results = rs.slice(0, 3).map((r) => (r as { result: string }).result);
    const web = rs[3] as { status: number; body: unknown };
    const processedBy = results.filter((r) => r === "recovered").length + (web.status === 200 && (web.body as { outcome?: string }).outcome === "confirmed" ? 1 : 0) + ((rs[4] as { results: { recovered: number } }).results.recovered ?? 0);
    assert.equal(processedBy, 1, `処理した件数が1件ではありません：${results.join(",")} / webhook ${web.status} / cron ${JSON.stringify((rs[4] as { results: unknown }).results)}`);
    for (const r of results) assert.ok(["recovered", "busy", "already_processed"].includes(r), r);
    assert.equal(await txCount(p.sessionId), 1);
    assert.equal((await evDoc(e.id))!.state, "PROCESSED");
    step(`同じ通知の手動の復旧×3・定期の復旧・Webhook の再送が同時：反映は1回（${results.join("・")}／Webhook ${web.status}）。決済記録1件`);
  }

  let unavailableId = "";
  // 6. Stripe API の失敗・通知を取得できない（保存期間切れ）：処理済みにしない。理由を記録
  {
    const p = await paidOnly(rt, code);
    const e = completedEv(p);
    await deliverFailing(rt, e, /^\/v1\/checkout\/sessions\//);
    failOnce(/^\/v1\/events\//);
    const o = await recoverStripeWebhookEvent(e.id, rt);
    assert.equal(o.result, "stripe_error");
    let d = (await evDoc(e.id))!;
    assert.deepEqual([d.processedAt, d.state, d.recoveryAttempts, d.lastRecoveryResult, typeof d.lastRecoveryError], [null, "RETRYABLE", 1, "stripe_error", "string"]);
    unavailableId = e.id;
    stripe.fake.events.delete(e.id); // Stripe の保存期間を過ぎた
    assert.equal((await recoverStripeWebhookEvent(e.id, rt)).result, "event_unavailable");
    d = (await evDoc(e.id))!;
    assert.deepEqual([d.processedAt, d.state, d.lastError, d.lastRecoveryResult, d.recoveryAttempts], [null, "FAILED_PERMANENT", "StripeEventUnavailable", "event_unavailable", 2]);
    assert.equal(await txCount(p.sessionId), 0, "取得できない通知の決済を推測で記録しました");
    await age(e.id);
    const s = await runStripeWebhookRecovery(rt, { source: "cron" });
    assert.equal(s.scanned, 0, "要確認（FAILED_PERMANENT）の通知を自動の復旧の対象にしました");
    step("Stripe API の失敗は stripe_error（RETRYABLE のまま・理由を記録）。通知を取得できなければ FAILED_PERMANENT（要確認・処理済みにしない・自動の対象外）");
  }

  // 7. 記録の書き込みの失敗（決済要確認の記録＝Firestore）：処理済みにしない。直れば再処理で記録し、回数は1回だけ
  {
    // 決済記録の無い返金（記録が無い＝決済要確認）を作る。この環境の注文がある決済の先着の返金は先に確定する（記録しない）ので、
    // 本当の異常（注文が無い決済）にする：支払いの後で注文を消し、確定の通知は送らない
    const p = await paidOnly(rt, code);
    await fsdb().collection(C.checkouts).doc(p.checkoutId).delete();
    await stripe.ctl(`refund/${p.charge}`);
    const e = refundEv(p);
    hooks.failReview = true;
    assert.equal((await deliver(rt, e)).status, 500);
    hooks.failReview = true;
    await age(e.id);
    const s = await runStripeWebhookRecovery(rt, { source: "cron" });
    assert.equal(s.results.failed, 1, JSON.stringify(s.results));
    let d = (await evDoc(e.id))!;
    assert.deepEqual([d.processedAt, d.state, d.lastRecoveryResult, d.lastRecoveryError], [null, "RETRYABLE", "failed", "FirebaseError"]);
    assert.equal(await reviewOf("transaction_not_found", p.charge), null);
    hooks.failReview = false;
    // 記録した後・処理済みにする前に止まる → 再処理（決済要確認は同じ通知で1回だけ数える）
    hooks.failFinish.add(e.id);
    assert.equal((await recoverStripeWebhookEvent(e.id, rt)).result, "failed");
    assert.equal((await reviewOf("transaction_not_found", p.charge))!.occurrences, 1);
    assert.equal((await recoverStripeWebhookEvent(e.id, rt)).result, "recovered");
    assert.equal((await reviewOf("transaction_not_found", p.charge))!.occurrences, 1, "同じ通知の決済要確認を2回数えました");
    d = (await evDoc(e.id))!;
    assert.deepEqual([d.state, d.recoveryAttempts], ["PROCESSED", 3]);
    step("決済要確認の記録の失敗（Firestore）：failed・RETRYABLE・理由を記録。処理済みにする前に止まっても、再処理で決済要確認は1回だけ");
  }

  // 8. 別の環境の通知：IGNORED_OTHER_ENV で処理済み（何も書かない）
  {
    const s0 = await createStripeCheckoutSession({ checkoutId: randomUUID(), storeId: store.id, fortuneType: "ZODIAC", productName: "別の環境", origin: ORIGIN, expiresAt: stripeSessionExpiry() }, other);
    await stripe.ctl(`pay/${s0.id}`, { fee: 4 });
    const e = completedEv({ sessionId: s0.id });
    await deliverFailing(rt, e, /^\/v1\/checkout\/sessions\//);
    await age(e.id);
    const s = await runStripeWebhookRecovery(rt, { source: "cron" });
    assert.equal(s.results.ignored_other_env, 1);
    assert.deepEqual([(await evDoc(e.id))!.state, await txCount(s0.id)], ["IGNORED_OTHER_ENV", 0]);
    step("別の環境の決済の通知：再処理で IGNORED_OTHER_ENV（決済記録なし）");
  }

  // 9. モードが違う記録は処理しない
  {
    const e = ev("checkout.session.completed", { id: "cs_test_mode", object: "checkout.session" });
    await acquireWebhookEventLease("stripe", e.id, e.type, { objectId: "cs_test_mode", chargeId: null, livemode: true, eventCreatedAt: new Date() });
    await evRef(e.id).update({ leaseOwner: null, leaseExpiresAt: null });
    await age(e.id);
    const s = await runStripeWebhookRecovery(rt, { source: "cron" });
    assert.equal(s.candidates, 0);
    assert.equal((await recoverStripeWebhookEvent(e.id, rt)).result, "mode_mismatch");
    assert.equal((await evDoc(e.id))!.processedAt, null);
    await evRef(e.id).update({ processedAt: new Date() }); // 以降の件数の確認の邪魔にならないよう片付ける（テストの準備だけ）
    step("記録のモードが接続と違う通知は、自動・手動とも処理しない");
  }

  // 10. ページ・件数・時間の上限。復旧できない古い通知が、後の通知を追い出し続けない
  {
    await evRef(unavailableId).update({ processedAt: new Date() }); // 6. の要確認の記録を片付ける（ページの件数を決めるため。テストの準備だけ）
    const ids: string[] = [];
    for (let i = 0; i < 6; i++) {
      const e = ev("customer.created", { id: `cus_${i}`, object: "customer" });
      const l = await acquireWebhookEventLease("stripe", e.id, e.type);
      await recordWebhookEventFailure("stripe", e.id, "Error", (l as { token: string }).token);
      await age(e.id, 3_600_000 - i * 1000);
      ids.push(e.id);
    }
    // 一番古い通知は、自動の復旧の上限の回数まで失敗済み・2番目は1回失敗済み（後回し）
    await evRef(ids[0]).update({ recoveryAttempts: RECOVERY_MAX_AUTO_ATTEMPTS, lastRecoveryAt: new Date(Date.now() - 86_400_000) });
    await evRef(ids[1]).update({ recoveryAttempts: 1, lastRecoveryAt: new Date(Date.now() - 86_400_000) });
    const deadline = await runStripeWebhookRecovery(rt, { source: "cron", deadlineMs: 0 });
    assert.deepEqual([deadline.status, deadline.attempted, deadline.deferred], ["partial", 0, 5], "時間の上限を過ぎても新しい通知を始めました");
    const s = await runStripeWebhookRecovery(rt, { source: "cron", maxEvents: 2, pageSize: 2, maxPages: 2 });
    assert.deepEqual([s.status, s.truncated, s.scanned, s.attempted, s.results.recovered], ["partial", true, 4, 2, 2]);
    // 1回失敗済みの ids[1] より、未実施の ids[2]・ids[3] が先
    assert.deepEqual([(await evDoc(ids[2]))!.state, (await evDoc(ids[3]))!.state, (await evDoc(ids[1]))!.state], ["PROCESSED", "PROCESSED", "RETRYABLE"]);
    const s2 = await runStripeWebhookRecovery(rt, { source: "cron" });
    assert.equal(s2.results.recovered, 3); // ids[1]・ids[4]・ids[5]
    assert.equal((await evDoc(ids[0]))!.state, "RETRYABLE", "上限の回数を超えた通知を自動で再処理しました");
    assert.equal((await recoverStripeWebhookEvent(ids[0], rt)).result, "recovered"); // 手動ならできる
    step("時間の上限で新しい通知を始めない・件数とページの上限（partial・truncated）。未実施の通知が先、上限の回数を超えた通知は自動の対象外（手動で再処理できる）");
  }

  console.log("\nSTRIPE WEBHOOK RECOVERY E2E PASSED");
}

main()
  .then(async () => {
    await stripe.stop();
    process.exit(0);
  })
  .catch(async (e) => {
    console.error("\nSTRIPE WEBHOOK RECOVERY E2E FAILED:", e);
    await stripe.stop().catch(() => {});
    process.exit(1);
  });
