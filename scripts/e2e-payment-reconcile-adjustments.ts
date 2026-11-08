/**
 * Stripe 起点の決済照合 第2段階a（返金・異議申し立て・確定済みの精算の調整）の E2E 検証。
 * 本物の Stripe・本番の Firebase には一切接続しない（localhost の模擬 Stripe（本番モード）と Firestore Emulator の demo- プロジェクトだけ。キーは形だけの偽物）。
 *
 *  A. 返金：反映済みは一致・反映が無い（60分超過）は異常・60分以内は処理待ち・取引にだけ記録があるのは異常
 *  B. 部分返金・返金の失敗は要確認、返金の処理中（取引にも反映）は正常な一時状態
 *  C. 異議申し立て：対応中・敗訴（反映済み）は一致、反映が無い・Stripe で結果が変わったのに反映が無いは異常
 *  元の決済が照合の期間より前：返金・異議申し立ての一覧から見つけて照合（反映済みは一致・反映が無いは異常）
 *  D. 確定済みの精算（前月）：返金の後の調整が正しければ一致・調整の記録の欠落・調整の不足は異常。以前の仕組みの精算は要確認
 *  途中停止・再開（1回1ページ・確認の件数の上限）・返金の一覧／異議申し立ての一覧の取得の失敗 → 未完了 → 再開で同じ結果
 *  読み取り専用：照合の前後で Firestore のすべての文書が変わらない・Stripe への要求は GET だけ
 *
 *   firebase emulators:start --only firestore --project demo-uranai
 *   （別ターミナル）FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 FIREBASE_PROJECT_ID=demo-uranai-reconcile-adj DB_PROVIDER=firestore SESSION_SECRET=<32文字以上> \
 *     npx tsx --conditions=react-server scripts/e2e-payment-reconcile-adjustments.ts
 */
import "dotenv/config";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import Stripe from "stripe";
import { createFakeStripe } from "./lib/fake-stripe";
import { C, fsdb } from "@/lib/firestore/admin";
import { dataProvider } from "@/lib/data-provider";
import { createStore } from "@/lib/services/stores";
import { generateSettlements, updateSettlementStatus } from "@/lib/services/settlements";
import { createCheckout } from "@/lib/firestore/payments";
import { createSimulatedStripeRuntime, STRIPE_SESSION_TTL_MS, type StripeRuntime } from "@/lib/payments/stripe-checkout";
import { startStripeCheckout } from "@/lib/payments/stripe-confirm";
import { handleStripeWebhook } from "@/lib/payments/stripe-webhook";
import { resumeReconcile, startReconcile, type ReconcileRun } from "@/lib/payments/stripe-reconcile";
import { jstYearMonth, shiftYearMonth } from "@/lib/time";

const SYSTEM = { userId: null, role: "SYSTEM" as const };
const step = (msg: string) => console.log(`  ✓ ${msg}`);
const ORIGIN = "http://localhost:3000";
const PORT = 12195;
const KEY = "sk_live_e2e_reconcile_adj_dummy";
const WHSEC = "whsec_e2e_reconcile_adj_dummy";
const stripe = createFakeStripe({ port: PORT, mode: "live", apiKey: KEY });
const signer = new Stripe("sk_test_signer");
const USER = "operator-e2e-adj";
let evN = 0;
const nowSec = () => Math.floor(Date.now() / 1000);
const OLD = () => nowSec() - 2 * 3600;

async function deliver(rt: StripeRuntime, type: string, object: Record<string, unknown>) {
  const id = `evt_ra_${++evN}_${Date.now()}`;
  const payload = JSON.stringify({ id, object: "event", type, livemode: true, data: { object } });
  const r = await handleStripeWebhook(payload, signer.webhooks.generateTestHeaderString({ payload, secret: rt.webhookSecret }), rt);
  return (r.body as { outcome?: string }).outcome ?? `status ${r.status}`;
}
type Pay = { checkoutId: string; sessionId: string; charge: string; pi: string; txId: string };
async function confirmed(rt: StripeRuntime, code: string, created = OLD()): Promise<Pay> {
  const { checkoutId, accessToken } = await createCheckout(code, "ZODIAC", { provider: "stripe", ttlMs: STRIPE_SESSION_TTL_MS });
  const sessionId = ((await startStripeCheckout(accessToken, ORIGIN, rt)) as { url: string }).url.split("/").pop()!;
  const p = await stripe.ctl(`pay/${sessionId}`, { fee: 4, created });
  const pay = { checkoutId, sessionId, charge: p.charge!, pi: p.paymentIntent!, txId: `stripe_${p.paymentIntent!}` };
  assert.equal(await deliver(rt, "checkout.session.completed", { id: sessionId, object: "checkout.session" }), "confirmed");
  return pay;
}
const refund = (p: Pay, o: Record<string, unknown> = {}) => stripe.ctl(`refund/${p.charge}`, { created: OLD(), ...o });
const syncRefund = async (rt: StripeRuntime, p: Pay) => deliver(rt, "charge.refunded", { id: p.charge, object: "charge" });
const dispute = (p: Pay, o: Record<string, unknown> = {}) => stripe.ctl(`dispute/${p.charge}`, { created: OLD(), ...o }).then((x) => x.dispute!);
const syncDispute = (rt: StripeRuntime, id: string) => deliver(rt, "charge.dispute.created", { id, object: "dispute" });
const tx = (p: Pay) => fsdb().collection(C.transactions).doc(p.txId);

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
const sorted = (x: ReconcileRun) => ({
  counts: x.state.counts,
  byKind: x.state.byKind,
  anomalies: x.state.anomalies.map((a) => JSON.stringify(a)).sort(),
  pending: x.state.pendingItems.map((a) => JSON.stringify(a)).sort(),
  review: x.state.reviewItems.map((a) => JSON.stringify(a)).sort(),
  truncated: x.state.truncated,
});

async function main() {
  const host = process.env.FIRESTORE_EMULATOR_HOST ?? "";
  assert.match(host, /^(127\.0\.0\.1|localhost|\[::1\]):\d+$/, "FIRESTORE_EMULATOR_HOST（localhost の Emulator）が必要です");
  assert.match(process.env.FIREBASE_PROJECT_ID ?? "", /^demo-/, "FIREBASE_PROJECT_ID は demo- で始まる Emulator 用の ID にしてください");
  assert.equal(dataProvider(), "firestore");
  assert.ok((process.env.SESSION_SECRET ?? "").length >= 32, "SESSION_SECRET（32文字以上）が必要です");
  for (const k of ["STRIPE_SECRET_KEY", "STRIPE_LIVE_CHECKOUT", "STRIPE_LIVE_OPERATOR_TEST", "VERCEL_ENV"]) delete process.env[k];
  await stripe.start();
  const rt = createSimulatedStripeRuntime("live", { apiBase: `http://127.0.0.1:${PORT}`, secretKey: KEY, webhookSecret: WHSEC, accountId: "acct_fakeliveaccount" });
  console.log(`Payment reconcile adjustments E2E (emulator ${host} / ${process.env.FIREBASE_PROJECT_ID}, fake Stripe live :${PORT})`);
  const store = await createStore({ name: `照合の返金の検証店舗 ${Date.now()}`, contactName: "", postalCode: "", address: "", phone: "", email: "" }, SYSTEM);
  const code = store.storeCode;

  // ===== A・B：返金（元の決済は期間の中） =====
  const R1 = await confirmed(rt, code); // 全額返金・反映済み
  await refund(R1);
  assert.equal(await syncRefund(rt, R1), "refunded");
  const R2 = await confirmed(rt, code); // 全額返金・反映が無い（2時間前）
  await refund(R2);
  const R2b = await confirmed(rt, code); // 全額返金・反映が無い（5分前＝処理待ち）
  await refund(R2b, { created: nowSec() - 300 });
  const R3 = await confirmed(rt, code); // 部分返金・反映済み（要確認）
  await refund(R3, { amount: 50 });
  assert.equal(await syncRefund(rt, R3), "partial");
  const R4 = await confirmed(rt, code); // 返金の処理中・反映済み（正常な一時状態）
  await refund(R4, { status: "pending" });
  assert.equal(await syncRefund(rt, R4), "refund_pending");
  const R5 = await confirmed(rt, code); // 返金の失敗・反映済み（要確認）
  await refund(R5, { status: "failed" });
  assert.equal(await syncRefund(rt, R5), "refund_failed");
  const R6 = await confirmed(rt, code); // 取引にだけ返金の記録（Stripe に返金なし）
  await tx(R6).update({ refundStatus: "succeeded", refundKey: "succeeded:100:0:0:re_fake", amountRefunded: 100, stripeRefundIds: ["re_fake"], paymentStatus: "REFUNDED" });
  // ===== C：異議申し立て（元の決済は期間の中） =====
  const C1 = await confirmed(rt, code); // 対応中・反映済み
  assert.equal(await syncDispute(rt, await dispute(C1, { status: "needs_response" })), "dispute_open");
  const C2 = await confirmed(rt, code); // 敗訴・反映済み（チャージバック）
  assert.equal(await syncDispute(rt, await dispute(C2, { status: "lost" })), "dispute_lost");
  const C3 = await confirmed(rt, code); // 反映が無い
  await dispute(C3);
  const C4 = await confirmed(rt, code); // 対応中を反映した後、Stripe で勝訴に変わったが反映が無い
  const c4d = await dispute(C4);
  assert.equal(await syncDispute(rt, c4d), "dispute_open");
  await stripe.ctl(`dispute-status/${c4d}`, { status: "won" });
  // ===== 元の決済が照合の期間より前（3日前） =====
  const threeDays = nowSec() - 3 * 86_400;
  const O1 = await confirmed(rt, code, threeDays); // 返金（期間の中）・反映が無い
  await refund(O1);
  const O1b = await confirmed(rt, code, threeDays + 60); // 返金・反映済み
  await refund(O1b);
  assert.equal(await syncRefund(rt, O1b), "refunded");
  const O2 = await confirmed(rt, code, threeDays + 120); // 異議申し立て（期間の中）・反映が無い
  await dispute(O2);
  // ===== D：確定済みの精算（前月）・以前の仕組みの精算（前々月） =====
  const ym = jstYearMonth(new Date());
  const prev = shiftYearMonth(ym, -1);
  const prev2 = shiftYearMonth(ym, -2);
  const midOf = (m: string) => Math.floor(Date.parse(`${m}-15T12:00:00+09:00`) / 1000);
  const S1 = await confirmed(rt, code, midOf(prev)); // 精算の後に返金・調整あり（一致）
  const S2 = await confirmed(rt, code, midOf(prev) + 60); // 精算の後に返金・調整の記録だけ欠落
  const S3 = await confirmed(rt, code, midOf(prev) + 120); // 精算の後に返金・調整の不足
  const S4 = await confirmed(rt, code, midOf(prev) + 180); // 精算に含め、返金なし（照合の対象にならない）
  await generateSettlements(prev, SYSTEM);
  await updateSettlementStatus(`${store.id}_${prev}`, "PAID", "", SYSTEM);
  for (const p of [S1, S2, S3, S4]) {
    const d = (await tx(p).get()).data()!;
    assert.deepEqual([d.settlementId, d.settledShare], [`${store.id}_${prev}`, 30], "精算の確定で支払った額が記録されていません");
  }
  for (const p of [S1, S2, S3]) {
    await refund(p);
    assert.equal(await syncRefund(rt, p), "refunded");
    const d = (await tx(p).get()).data()!;
    assert.deepEqual([d.adjustmentTotal, d.adjustmentCount], [-30, 1], "返金の後の調整が作られていません");
  }
  await fsdb().collection(C.settlementAdjustments).doc(`${S2.txId}_1`).delete(); // 調整の記録だけ欠落（adjustmentTotal は一致）
  await fsdb().collection(C.settlementAdjustments).doc(`${S3.txId}_1`).delete(); // 調整そのものが無い
  await tx(S3).update({ adjustmentTotal: 0, adjustmentCount: 0 });
  const L1 = await confirmed(rt, code, midOf(prev2)); // 以前の仕組みで確定した精算の月
  await fsdb().collection(C.settlements).doc(`${store.id}_${prev2}`).set({ storeId: store.id, yearMonth: prev2, status: "PAID", transactionCount: 1, grossSales: 100, storeShare: 30, heldShare: 0, paidAt: new Date(), note: "", createdAt: new Date(), updatedAt: new Date() });
  await refund(L1);
  assert.equal(await syncRefund(rt, L1), "refunded");
  step("データ：返金（反映済み・反映なし・処理待ち・部分・処理中・失敗・取引だけ）・異議申し立て（対応中・敗訴・反映なし・結果の変化）・期間より前の決済・確定済みの精算・以前の精算");

  // ===== 照合 =====
  await new Promise((ok) => setTimeout(ok, 1100)); // データを作った秒が過ぎてから（期間の終わりは開始の秒を含まない）
  const from = nowSec() - 86_400;
  const to = nowSec() + 60;
  const before = await snapshotAll();
  const callsBefore = stripe.fake.callLog.length;
  const { run, segments } = await runAll(rt, from, to);
  assert.equal(await snapshotAll(), before, "照合で Firestore の文書（決済・精算・調整を含む）が変わりました");
  const calls = stripe.fake.callLog.slice(callsBefore);
  assert.ok(calls.length > 0 && calls.every((c) => c.startsWith("GET ")), `GET 以外の要求：${calls.filter((c) => !c.startsWith("GET ")).join(",")}`);
  step(`読み取り専用：Firestore の全文書が不変・Stripe への要求は GET だけ（${calls.length}回：${[...new Set(calls.map((c) => c.replace(/\/(pi|ch|re|dp)_[A-Za-z0-9_]+/, "/{id}")))].join("・")}）`);

  const s = run.state;
  assert.equal(segments.length, 1);
  assert.deepEqual([run.verdict, run.stoppedBy, s.done, s.phase], ["issues", null, true, "disputes"]);
  const kinds = (p: Pay | string) => s.anomalies.filter((a) => a.paymentIntentId === (typeof p === "string" ? p : p.pi)).map((a) => `${a.kind}:${a.details.join("+")}`);
  const reasons = (p: Pay) => s.reviewItems.filter((r) => r.paymentIntentId === p.pi).map((r) => r.reason);
  const pendingOf = (p: Pay) => s.pendingItems.filter((r) => r.paymentIntentId === p.pi).map((r) => r.reason);
  assert.deepEqual(kinds(R1), []);
  assert.deepEqual(kinds(R2), ["refund_mismatch:amount+status+refund_ids"]);
  assert.deepEqual([kinds(R2b), pendingOf(R2b)], [[], ["refund_sync"]]);
  assert.deepEqual(kinds(R6), ["refund_mismatch:not_in_stripe"]);
  step("A：全額返金（反映済み）は一致・反映が無い（2時間前）は異常・5分前は処理待ち・取引にだけ記録があるのは異常");
  assert.deepEqual([kinds(R3), reasons(R3)], [[], ["refund_partial"]]);
  assert.deepEqual([kinds(R4), reasons(R4)], [[], []]);
  assert.deepEqual([kinds(R5), reasons(R5)], [[], ["refund_failed"]]);
  assert.equal(s.counts.refundInProgress, 1);
  step("B：返金の処理中（反映済み）は正常な一時状態として数える・部分返金と返金の失敗は要確認（異常とも正常とも言わない）");
  assert.deepEqual([kinds(C1), kinds(C2)], [[], []]);
  assert.deepEqual(kinds(C3), ["dispute_mismatch:dispute_id+status+dispute_amount"]);
  assert.deepEqual(kinds(C4), ["dispute_mismatch:status"]);
  assert.equal(s.counts.disputeOpen, 1);
  step("C：対応中・敗訴（チャージバック）を反映済みなら一致・反映が無い／Stripe で勝訴に変わったのに反映が無いのは異常");
  assert.deepEqual(kinds(O1), ["refund_mismatch:amount+status+refund_ids"]);
  assert.deepEqual(kinds(O1b), []);
  assert.deepEqual(kinds(O2), ["dispute_mismatch:dispute_id+status+dispute_amount"]);
  assert.ok(s.counts.refundsSeen >= 9 && s.counts.disputesSeen >= 5);
  step("元の決済が期間より前（3日前）：返金・異議申し立ての一覧から見つけて照合（反映済みは一致・反映が無いのは異常）");
  assert.deepEqual([kinds(S1), reasons(S1)], [[], []]);
  assert.deepEqual(kinds(S2), ["settlement_adjustment_mismatch:adjustment_doc_missing"]);
  assert.deepEqual(kinds(S3), ["settlement_adjustment_mismatch:adjustment_total"]);
  assert.equal(s.anomalies.find((a) => a.paymentIntentId === S3.pi)!.delta, -30);
  assert.deepEqual(kinds(S4), []);
  assert.equal(s.counts.settlementChecked, 3);
  step("D：精算の後に返金され調整が正しいものは一致（返金済みの取引が過去の精算に含まれるだけでは異常にしない）・調整の記録の欠落・調整の不足（差額 -30円）は異常");
  assert.deepEqual([kinds(L1), reasons(L1)], [[], ["legacy_settlement"]]);
  step("以前の仕組みで確定した精算の月：判定せず「要確認」（推測で正常・異常を決めない）");
  assert.deepEqual(s.byKind, { stripe_paid_no_checkout: 0, stripe_paid_no_transaction: 0, amount_or_mode_mismatch: 0, duplicate_or_bad_link: 0, refund_mismatch: 3, dispute_mismatch: 3, settlement_adjustment_mismatch: 2 });
  // 同じ Charge を二重に数えない（決済の一覧の段階と、返金・異議申し立ての一覧の段階）
  const checkedCharges = new Set([R1, R2, R2b, R3, R4, R5, R6, C1, C2, C3, C4, O1, O1b, O2, S1, S2, S3, L1].map((p) => p.charge));
  assert.equal(s.counts.adjustmentChecks, checkedCharges.size);
  assert.equal(s.checked.length, checkedCharges.size);
  step(`件数：異常8件（返金3・異議申し立て3・精算2）・確かめた Charge ${s.counts.adjustmentChecks}件（二重に数えない）・Stripe の呼び出し ${s.metrics.stripeCalls}回・Firestore の読み取り ${s.metrics.firestoreReads}件`);
  const text = JSON.stringify(run);
  for (const bad of [KEY, WHSEC, "client_secret", "billing_details", "@example.com"]) assert.equal(text.includes(bad), false, `結果に ${bad} が含まれています`);

  // ===== 途中停止・再開 =====
  const paged = await runAll(rt, from, to, { maxPagesPerSegment: 2, streamPageSize: 2, maxAdjustmentChecksPerSegment: 3 });
  assert.ok(paged.segments.length >= 6, `再開の回数が少なすぎます（${paged.segments.length}）`);
  assert.ok(paged.segments.some((x) => x.stoppedBy === "check_limit") && paged.segments.some((x) => x.stoppedBy === "page_limit"));
  assert.deepEqual(sorted(paged.run), sorted(run));
  step(`途中停止・再開：1回2ページ・返金の一覧2件ずつ・確認3件ずつで ${paged.segments.length}回に分けても、件数・異常・要確認・処理待ちの詳細まで同じ`);

  // ===== 取得の失敗（返金の一覧・異議申し立ての一覧） =====
  for (const [path, label] of [[/^\/v1\/refunds$/, "返金の一覧"], [/^\/v1\/disputes$/, "異議申し立ての一覧"]] as const) {
    stripe.fake.failCalls.push({ path, method: "GET", query: /created\[gte\]/, skip: 1, count: 1 });
    const first = await startReconcile({ rt, userId: USER, fromSec: from, toSec: to, limits: { streamPageSize: 3 } });
    assert.deepEqual([first.verdict, first.stoppedBy, first.state.done], ["incomplete", "stripe_error", false], `${label}の失敗が未完了になっていません`);
    assert.equal(first.state.phase, path.source.includes("refunds") ? "refunds" : "disputes");
    assert.notEqual(first.verdict, "ok");
    let r = first;
    while (r.token) r = await resumeReconcile({ rt, userId: USER, token: r.token, limits: { streamPageSize: 3 } });
    const once = await runAll(rt, from, to, { streamPageSize: 3 });
    assert.deepEqual(sorted(r), sorted(once.run));
    step(`${label}の2ページ目の取得に失敗：未完了（「異常なし」と表示しない）→ 再開で完了し、失敗しなかったときと同じ結果`);
  }
  // 個別の確認（Charge ごとの返金の一覧）の失敗も未完了
  stripe.fake.failCalls.push({ path: /^\/v1\/refunds$/, method: "GET", query: /charge=/, skip: 0, count: 1 });
  const chFail = await startReconcile({ rt, userId: USER, fromSec: from, toSec: to });
  assert.deepEqual([chFail.verdict, chFail.stoppedBy], ["incomplete", "stripe_error"]);
  step("Charge ごとの返金の取得に失敗：未完了");
  stripe.fake.failPaths.push(/^\/v1\/disputes$/);
  const down = await startReconcile({ rt, userId: USER, fromSec: from, toSec: to });
  stripe.fake.failPaths.length = 0;
  assert.deepEqual([down.verdict, down.stoppedBy, down.state.done], ["incomplete", "stripe_error", false]);
  step("異議申し立ての取得が続けて失敗：未完了（異常なしと表示しない）");

  await stripe.stop();
  console.log("\nPAYMENT RECONCILE ADJUSTMENTS E2E PASSED");
}

main().catch((e) => {
  console.error("PAYMENT RECONCILE ADJUSTMENTS E2E FAILED:", e);
  process.exit(1);
});
