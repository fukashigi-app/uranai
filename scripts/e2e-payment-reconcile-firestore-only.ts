/**
 * Stripe 起点の決済照合 第2段階b（Firestore の取引の一覧・逆方向）の E2E 検証。
 * 本物の Stripe・本番の Firebase には一切接続しない（localhost の模擬 Stripe（本番モード）と Firestore Emulator の demo- プロジェクトだけ。キーは形だけの偽物）。
 *
 *  - 期間の中の正常な決済：決済の一覧で照合済み（重ねて数えない）
 *  - 期間の境目（PaymentIntent は期間より前・支払いは期間の中）：Stripe と一致（一覧で見つかるもの・1件ずつ取り直すもの）。返金・異議申し立て・チャージバック済みも一致
 *  - Firestore にだけある取引（Stripe が 404）：stripe_payment_missing
 *  - 対象外：テスト決済（モード違い）・疑似決済。紐付けの不正：文書 ID の不一致・Charge の不一致・未払い・別の環境。環境を表す値が無い：要確認
 *  - paidAt が無い取引は対象外（読まない）
 *  - 1件ずつの取り直しの 401・429・500、取引の段階の一覧の失敗：未完了（「Stripe に無い」としない）→ 再開で同じ結果
 *  - ページ送り・途中停止・再開で同じ結果。返金・異議申し立て・精算の判定は変わらない
 *  - 読み取り専用：照合の前後で Firestore のすべての文書が変わらない・Stripe への要求は GET だけ
 *
 *   firebase emulators:start --only firestore --project demo-uranai
 *   （別ターミナル）FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 FIREBASE_PROJECT_ID=demo-uranai-reconcile-rev DB_PROVIDER=firestore SESSION_SECRET=<32文字以上> \
 *     npx tsx --conditions=react-server scripts/e2e-payment-reconcile-firestore-only.ts
 */
import "dotenv/config";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import Stripe from "stripe";
import { createFakeStripe } from "./lib/fake-stripe";
import { C, fsdb } from "@/lib/firestore/admin";
import { dataProvider } from "@/lib/data-provider";
import { createStore } from "@/lib/services/stores";
import { createCheckout } from "@/lib/firestore/payments";
import { createSimulatedStripeRuntime, STRIPE_SESSION_TTL_MS, type StripeRuntime } from "@/lib/payments/stripe-checkout";
import { startStripeCheckout } from "@/lib/payments/stripe-confirm";
import { handleStripeWebhook } from "@/lib/payments/stripe-webhook";
import { resumeReconcile, startReconcile, type ReconcileRun } from "@/lib/payments/stripe-reconcile";

const SYSTEM = { userId: null, role: "SYSTEM" as const };
const step = (msg: string) => console.log(`  ✓ ${msg}`);
const ORIGIN = "http://localhost:3000";
const PORT = 12197;
const KEY = "sk_live_e2e_reconcile_rev_dummy";
const WHSEC = "whsec_e2e_reconcile_rev_dummy";
const OTHER_TAG = "fp_fedcba9876543210";
const stripe = createFakeStripe({ port: PORT, mode: "live", apiKey: KEY });
const signer = new Stripe("sk_test_signer");
const USER = "operator-e2e-rev";
let evN = 0;
const nowSec = () => Math.floor(Date.now() / 1000);

async function deliver(rt: StripeRuntime, type: string, object: Record<string, unknown>) {
  const id = `evt_rv_${++evN}_${Date.now()}`;
  const payload = JSON.stringify({ id, object: "event", type, livemode: true, data: { object } });
  const r = await handleStripeWebhook(payload, signer.webhooks.generateTestHeaderString({ payload, secret: rt.webhookSecret }), rt);
  return (r.body as { outcome?: string }).outcome ?? `status ${r.status}`;
}
type Pay = { checkoutId: string; sessionId: string; charge: string; pi: string; txId: string };
async function confirmed(rt: StripeRuntime, code: string, created: number, chargeCreated = created): Promise<Pay> {
  const { checkoutId, accessToken } = await createCheckout(code, "ZODIAC", { provider: "stripe", ttlMs: STRIPE_SESSION_TTL_MS });
  const sessionId = ((await startStripeCheckout(accessToken, ORIGIN, rt)) as { url: string }).url.split("/").pop()!;
  const p = await stripe.ctl(`pay/${sessionId}`, { fee: 4, created, chargeCreated });
  const pay = { checkoutId, sessionId, charge: p.charge!, pi: p.paymentIntent!, txId: `stripe_${p.paymentIntent!}` };
  assert.equal(await deliver(rt, "checkout.session.completed", { id: sessionId, object: "checkout.session" }), "confirmed");
  return pay;
}
const tx = (id: string) => fsdb().collection(C.transactions).doc(id);

async function snapshotAll(): Promise<string> {
  const h = createHash("sha256");
  const walk = async (cols: FirebaseFirestore.CollectionReference[]) => {
    for (const col of cols.sort((a, b) => a.path.localeCompare(b.path))) {
      const docs = await col.get();
      for (const d of docs.docs.sort((a, b) => a.id.localeCompare(b.id))) {
        h.update(`${d.ref.path}@${d.updateTime.toMillis()}\n`);
        await walk(await d.ref.listCollections());
      }
    }
  };
  await walk(await fsdb().listCollections());
  return h.digest("hex");
}
async function runAll(rt: StripeRuntime, from: number, to: number, limits: Parameters<typeof startReconcile>[0]["limits"] = {}) {
  let run = await startReconcile({ rt, userId: USER, fromSec: from, toSec: to, limits });
  const segments = [run];
  while (run.token) {
    run = await resumeReconcile({ rt, userId: USER, token: run.token, limits });
    segments.push(run);
    assert.ok(segments.length < 80, "再開が終わりません");
  }
  return { run, segments };
}
const sorted = (x: ReconcileRun, withLookups = true) => {
  const { reverseLookups, ...counts } = x.state.counts;
  return {
    counts: withLookups ? { ...counts, reverseLookups } : counts,
    byKind: x.state.byKind,
    anomalies: x.state.anomalies.map((a) => JSON.stringify(a)).sort(),
    pending: x.state.pendingItems.map((a) => JSON.stringify(a)).sort(),
    review: x.state.reviewItems.map((a) => JSON.stringify(a)).sort(),
    truncated: x.state.truncated,
  };
};

async function main() {
  const host = process.env.FIRESTORE_EMULATOR_HOST ?? "";
  assert.match(host, /^(127\.0\.0\.1|localhost|\[::1\]):\d+$/, "FIRESTORE_EMULATOR_HOST（localhost の Emulator）が必要です");
  assert.match(process.env.FIREBASE_PROJECT_ID ?? "", /^demo-/, "FIREBASE_PROJECT_ID は demo- で始まる Emulator 用の ID にしてください");
  assert.equal(dataProvider(), "firestore");
  assert.ok((process.env.SESSION_SECRET ?? "").length >= 32, "SESSION_SECRET（32文字以上）が必要です");
  for (const k of ["STRIPE_SECRET_KEY", "STRIPE_LIVE_CHECKOUT", "STRIPE_LIVE_OPERATOR_TEST", "VERCEL_ENV"]) delete process.env[k];
  await stripe.start();
  const rt = createSimulatedStripeRuntime("live", { apiBase: `http://127.0.0.1:${PORT}`, secretKey: KEY, webhookSecret: WHSEC, accountId: "acct_fakeliveaccount" });
  console.log(`Payment reconcile Firestore-only E2E (emulator ${host} / ${process.env.FIREBASE_PROJECT_ID}, fake Stripe live :${PORT})`);
  const store = await createStore({ name: `照合の逆方向の検証店舗 ${Date.now()}`, contactName: "", postalCode: "", address: "", phone: "", email: "" }, SYSTEM);
  const code = store.storeCode;
  const from = nowSec() - 86_400; // 照合の期間の開始（終わりは照合の開始の時刻）
  const OLD = nowSec() - 2 * 3600;

  // ===== データ =====
  const N1 = await confirmed(rt, code, OLD); // 期間の中の正常な決済
  const B1 = await confirmed(rt, code, from - 3600, from + 600); // 境目：PaymentIntent は1時間前（一覧で見つかる）
  const B2 = await confirmed(rt, code, from - 5 * 3600, from + 600); // 境目：5時間前（1件ずつ取り直す）
  const B3 = await confirmed(rt, code, from - 3600, from + 700); // 境目・返金済み
  await stripe.ctl(`refund/${B3.charge}`, { created: OLD });
  assert.equal(await deliver(rt, "charge.refunded", { id: B3.charge, object: "charge" }), "refunded");
  const B4 = await confirmed(rt, code, from - 3600, from + 800); // 境目・異議申し立て中
  const d4 = (await stripe.ctl(`dispute/${B4.charge}`, { created: OLD, status: "needs_response" })).dispute!;
  assert.equal(await deliver(rt, "charge.dispute.created", { id: d4, object: "dispute" }), "dispute_open");
  const B5 = await confirmed(rt, code, from - 3600, from + 900); // 境目・チャージバック済み（敗訴）
  const d5 = (await stripe.ctl(`dispute/${B5.charge}`, { created: OLD, status: "lost" })).dispute!;
  assert.equal(await deliver(rt, "charge.dispute.created", { id: d5, object: "dispute" }), "dispute_lost");
  const B6 = await confirmed(rt, code, from - 5 * 3600, from + 1000); // 境目・取引の Charge だけ書き換え（不一致）
  await tx(B6.txId).update({ stripeChargeId: "ch_live_other_charge" });
  const base = (await tx(N1.txId).get()).data()!;
  const paidIn = new Date((from + 1200) * 1000);
  const fake = async (pi: string, o: Record<string, unknown> = {}, docId = `stripe_${pi}`) => tx(docId).set({ ...base, stripePaymentIntentId: pi, providerPaymentId: pi, stripeChargeId: `ch_${pi.slice(3)}`, paidAt: paidIn, ...o });
  await fake("pi_live_missing000001"); // Firestore にだけある（Stripe は 404）
  await fake("pi_test_mode000000001", { livemode: false }); // テスト決済（本番の接続では対象外）
  await fake("pi_mock_provider00001", { paymentProvider: "mock" }); // 疑似決済（対象外）
  await fake("pi_live_bbb0000000001", {}, "stripe_pi_live_aaa0000000001"); // 文書 ID と PaymentIntent が一致しない
  const raw = async (o: Record<string, unknown>) => (await stripe.ctl("raw-pi", { created: from - 5 * 3600, ...o })).paymentIntent!;
  const M6 = await raw({ status: "requires_payment_method", metadata: { checkoutId: "co_m6", uranaiEnv: rt.envTag } });
  await fake(M6); // Stripe では未払い
  const M7 = await raw({ metadata: { checkoutId: "co_m7", uranaiEnv: OTHER_TAG }, latestCharge: "ch_live_m7" });
  await fake(M7, { stripeChargeId: "ch_live_m7" }); // 別の環境の決済
  const M8 = await raw({ metadata: { checkoutId: "co_m8" }, latestCharge: "ch_live_m8" });
  await fake(M8, { stripeChargeId: "ch_live_m8" }); // 環境を表す値が無い
  {
    const { paidAt: _omit, ...noPaidAt } = base; // paidAt が無い取引（検索の対象外）
    void _omit;
    await tx("stripe_pi_live_nopaidat00001").set({ ...noPaidAt, stripePaymentIntentId: "pi_live_nopaidat00001", providerPaymentId: "pi_live_nopaidat00001", stripeChargeId: "ch_live_nopaidat00001" });
  }
  step("データ：期間の中の決済・境目の決済（返金・異議申し立て・チャージバック）・Stripe に無い取引・テスト決済・疑似決済・紐付けの不正・paidAt なし");

  // ===== 照合 =====
  await new Promise((ok) => setTimeout(ok, 1100));
  const to = nowSec() + 60;
  const before = await snapshotAll();
  const callsBefore = stripe.fake.callLog.length;
  const { run } = await runAll(rt, from, to);
  assert.equal(await snapshotAll(), before, "照合で Firestore の文書（決済・精算を含む）が変わりました");
  const calls = stripe.fake.callLog.slice(callsBefore);
  assert.ok(calls.length > 0 && calls.every((c) => c.startsWith("GET ")), `GET 以外の要求：${calls.filter((c) => !c.startsWith("GET ")).join(",")}`);
  step(`読み取り専用：Firestore の全文書が不変・Stripe への要求は GET だけ（${calls.length}回）`);

  const s = run.state;
  assert.deepEqual([run.verdict, run.stoppedBy, s.done, s.phase], ["issues", null, true, "transactions"]);
  const kinds = (txId: string) => s.anomalies.filter((a) => a.transactionId === txId && a.details.includes("found_via_transactions")).map((a) => `${a.kind}:${a.details.join("+")}`);
  const all = (txId: string) => s.anomalies.filter((a) => a.transactionId === txId).map((a) => a.kind);
  assert.deepEqual(all(N1.txId), []);
  assert.equal(s.counts.txCovered, 1);
  step("期間の中の正常な決済：決済の一覧で照合済み（取引の一覧では重ねて数えない）");
  for (const p of [B1, B2, B3, B4, B5]) assert.deepEqual(all(p.txId), [], `境目の決済 ${p.pi} が異常になりました`);
  assert.equal(s.counts.txMatched, 5);
  step("期間の境目（作成は期間より前・支払いは期間の中）：一覧で見つかるもの・取り直したもの・返金済み・異議申し立て中・チャージバック済みのどれも一致");
  assert.deepEqual(kinds("stripe_pi_live_missing000001"), ["stripe_payment_missing:stripe_not_found+found_via_transactions"]);
  step("Firestore にだけある取引（Stripe が 404）：stripe_payment_missing");
  assert.deepEqual([s.counts.txOtherMode, s.counts.txOtherProvider], [1, 1]);
  assert.deepEqual([all("stripe_pi_test_mode000000001"), all("stripe_pi_mock_provider00001")], [[], []]);
  step("対象外：テスト決済（モード違い）・疑似決済（異常にしない）");
  assert.deepEqual(kinds("stripe_pi_live_aaa0000000001"), ["duplicate_or_bad_link:tx_id_mismatch+found_via_transactions"]);
  assert.deepEqual(kinds(B6.txId), ["amount_or_mode_mismatch:charge+found_via_transactions"]);
  assert.deepEqual(kinds(`stripe_${M6}`), ["duplicate_or_bad_link:stripe_not_paid+found_via_transactions"]);
  assert.deepEqual(kinds(`stripe_${M7}`), ["duplicate_or_bad_link:stripe_other_env+found_via_transactions"]);
  assert.deepEqual(s.reviewItems.filter((r) => r.transactionId === `stripe_${M8}`).map((r) => r.reason), ["untagged"]);
  step("紐付けの不正：文書 ID の不一致・Charge の不一致・Stripe では未払い・別の環境は異常、環境を表す値が無いのは要確認");
  assert.equal(s.counts.txScanned, 14);
  assert.equal(JSON.stringify(s).includes("pi_live_nopaidat00001"), false);
  step("paidAt が無い取引は検索の対象外（読んだ件数14件に含まれない）");
  assert.deepEqual(s.byKind, { stripe_paid_no_checkout: 0, stripe_paid_no_transaction: 0, amount_or_mode_mismatch: 1, duplicate_or_bad_link: 3, refund_mismatch: 0, dispute_mismatch: 0, settlement_adjustment_mismatch: 0, stripe_payment_missing: 1 });
  assert.equal(s.counts.reverseLookups, 6);
  step(`件数：異常5件（Stripe に無い1・紐付け3・Charge 1）・返金・異議申し立ての異常0件（既存の判定は変わらない）・1件ずつの取り直し ${s.counts.reverseLookups}回・Stripe ${s.metrics.stripeCalls}回・Firestore ${s.metrics.firestoreReads}件`);
  for (const bad of [KEY, WHSEC, "client_secret", "billing_details"]) assert.equal(JSON.stringify(run).includes(bad), false, `結果に ${bad} が含まれています`);

  // ===== ページ送り・途中停止・再開 =====
  const small = { txPageSize: 3 };
  const once = await runAll(rt, from, to, small);
  const paged = await runAll(rt, from, to, { ...small, maxPagesPerSegment: 1 });
  assert.ok(paged.segments.length >= 8, `再開の回数が少なすぎます（${paged.segments.length}）`);
  assert.deepEqual(sorted(paged.run), sorted(once.run));
  assert.deepEqual(sorted(once.run, false), sorted(run, false)); // ページの大きさが違っても、取り直しの回数以外は同じ
  const capped = await runAll(rt, from, to, { ...small, maxReverseLookupsPerSegment: 1 });
  assert.ok(capped.segments.some((x) => x.stoppedBy === "check_limit"));
  assert.deepEqual(sorted(capped.run), sorted(once.run));
  step(`ページ送り（取引3件ずつ）・1回1ページで ${paged.segments.length}回に分けても・取り直しの上限で区切っても、件数・詳細まで同じ`);

  // ===== 取得の失敗：「Stripe に無い」としない =====
  for (const status of [401, 429, 500]) {
    // Stripe に無い PaymentIntent の取り直しで、404 の代わりに 401・429・500 が返ったとき（取引の段階だけで取り直す ID）
    stripe.fake.failCalls.push({ path: /^\/v1\/payment_intents\/pi_live_missing000001$/, method: "GET", skip: 0, count: 1, status });
    const first = await startReconcile({ rt, userId: USER, fromSec: from, toSec: to });
    assert.deepEqual([first.verdict, first.stoppedBy, first.state.phase, first.state.done], ["incomplete", "stripe_error", "transactions", false], `${status} が未完了になっていません`);
    assert.equal(first.state.byKind.stripe_payment_missing, 0, `${status} を「Stripe に無い」と判定しました`);
    let r = first;
    while (r.token) r = await resumeReconcile({ rt, userId: USER, token: r.token });
    assert.deepEqual(sorted(r), sorted(run));
    step(`1件ずつの取り直しが ${status}：未完了（「Stripe に無い」としない）→ 再開で同じ結果`);
  }
  stripe.fake.failCalls.push({ path: /^\/v1\/payment_intents$/, method: "GET", query: /created\[gte\]/, skip: 1, count: 1 });
  const lf = await startReconcile({ rt, userId: USER, fromSec: from, toSec: to });
  assert.deepEqual([lf.verdict, lf.stoppedBy, lf.state.phase], ["incomplete", "stripe_error", "transactions"]);
  let lr = lf;
  while (lr.token) lr = await resumeReconcile({ rt, userId: USER, token: lr.token });
  assert.deepEqual(sorted(lr), sorted(run));
  step("取引の段階の Stripe の一覧の取得に失敗：未完了 → 再開で同じ結果");

  await stripe.stop();
  console.log("\nPAYMENT RECONCILE FIRESTORE-ONLY E2E PASSED");
}

main().catch((e) => {
  console.error("PAYMENT RECONCILE FIRESTORE-ONLY E2E FAILED:", e);
  process.exit(1);
});
