/**
 * Stripe の返金・異議申し立て（チャージバック）と精算の調整の E2E 検証。
 * 本物の Stripe・本番の Firebase には一切接続しない：
 *  - Stripe は、このスクリプトが起動する localhost の模擬サーバーだけ（本番として振る舞うものと、テストのもの）
 *  - Firebase は Firestore Emulator の demo- プロジェクトだけ
 *  - キーは形だけの偽物（環境変数には入れず、模擬の接続を作るときだけ使う）
 * 振込（精算）の対象は本番の決済（livemode=true）だけなので、決済のライブラリを直接呼び、模擬の本番モードの接続を渡して確かめる。
 *
 *   firebase emulators:start --only firestore --project demo-uranai
 *   （別ターミナル）FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 FIREBASE_PROJECT_ID=demo-uranai-settle DB_PROVIDER=firestore npm run e2e:stripe-settlement
 */
import "dotenv/config";
import assert from "node:assert/strict";
import Stripe from "stripe";
import { createFakeStripe } from "./lib/fake-stripe";
import { C, fsdb } from "@/lib/firestore/admin";
import { dataProvider } from "@/lib/data-provider";
import { spawn, type ChildProcess } from "node:child_process";
import { createOperator, createStore, createStoreUser } from "@/lib/services/stores";
import { randomToken, sha256Hex } from "@/lib/security/crypto";
import { monthTotals } from "@/lib/services/reports";
import { generateSettlements, listSettlements, updateSettlementStatus } from "@/lib/services/settlements";
import { listAdjustments } from "@/lib/firestore/settlement-adjustments";
import { createCheckout } from "@/lib/firestore/payments";
import { jstYearMonth, shiftYearMonth } from "@/lib/time";
import { createSimulatedStripeRuntime, STRIPE_SESSION_TTL_MS, type StripeRuntime } from "@/lib/payments/stripe-checkout";
import { startStripeCheckout, syncStripeDispute, syncStripeRefunds } from "@/lib/payments/stripe-confirm";
import { handleStripeWebhook } from "@/lib/payments/stripe-webhook";

const SYSTEM = { userId: null, role: "SYSTEM" as const };
const step = (msg: string) => console.log(`  ✓ ${msg}`);
const ORIGIN = "http://localhost:3000";

const LIVE_PORT = 12117;
const TEST_PORT = 12118;
const LIVE_KEY = "sk_live_e2e_settle_dummy";
const TEST_KEY = "sk_test_e2e_settle_dummy";
const LIVE_WHSEC = "whsec_e2e_settle_live_dummy";
const TEST_WHSEC = "whsec_e2e_settle_test_dummy";
const liveStripe = createFakeStripe({ port: LIVE_PORT, mode: "live", apiKey: LIVE_KEY });
const testStripe = createFakeStripe({ port: TEST_PORT, mode: "test", apiKey: TEST_KEY });

const signer = new Stripe("sk_test_signer");
let evN = 0;
async function webhook(rt: StripeRuntime, type: string, object: Record<string, unknown>, opts: { livemode?: boolean; secret?: string; eventId?: string } = {}) {
  const livemode = opts.livemode ?? rt.mode === "live";
  const payload = JSON.stringify({ id: opts.eventId ?? `evt_settle_${++evN}_${Date.now()}`, object: "event", type, livemode, data: { object } });
  const sig = signer.webhooks.generateTestHeaderString({ payload, secret: opts.secret ?? rt.webhookSecret });
  return handleStripeWebhook(payload, sig, rt);
}
const outcomeOf = (r: { body: unknown }) => (r.body as { outcome?: string }).outcome;

/** 指定した月の15日に支払われた決済を作る（本番またはテストの模擬 Stripe） */
async function paid(rt: StripeRuntime, stripe: ReturnType<typeof createFakeStripe>, storeCode: string, ym: string) {
  const { checkoutId, accessToken } = await createCheckout(storeCode, "ZODIAC", { provider: "stripe", ttlMs: STRIPE_SESSION_TTL_MS });
  const r = await startStripeCheckout(accessToken, ORIGIN, rt);
  assert.equal(r.status, "redirect");
  const sessionId = (r as { url: string }).url.split("/").pop()!;
  const created = Math.floor(new Date(`${ym}-15T12:00:00+09:00`).getTime() / 1000);
  const p = await stripe.ctl(`pay/${sessionId}`, { created, fee: 4 });
  assert.equal(outcomeOf(await webhook(rt, "checkout.session.completed", { id: sessionId, object: "checkout.session" })), "confirmed");
  const [t] = (await fsdb().collection(C.transactions).where("checkoutId", "==", checkoutId).get()).docs;
  return { txId: t.id, charge: p.charge!, pi: p.paymentIntent! };
}
const txDoc = async (id: string) => (await fsdb().collection(C.transactions).doc(id).get()).data()!;
const adjOf = async (txId: string) => (await fsdb().collection(C.settlementAdjustments).where("transactionId", "==", txId).get()).docs.map((d) => d.data());
const settlementOf = async (storeId: string, ym: string) => (await listSettlements({ storeId, yearMonth: ym }))[0]?.s;

async function main() {
  const host = process.env.FIRESTORE_EMULATOR_HOST ?? "";
  assert.match(host, /^(127\.0\.0\.1|localhost|\[::1\]):\d+$/, "FIRESTORE_EMULATOR_HOST（localhost の Emulator）が必要です");
  assert.match(process.env.FIREBASE_PROJECT_ID ?? "", /^demo-/, "FIREBASE_PROJECT_ID は demo- で始まる Emulator 用の ID にしてください");
  assert.equal(dataProvider(), "firestore");
  for (const k of ["STRIPE_SECRET_KEY", "STRIPE_LIVE_CHECKOUT", "STRIPE_LIVE_OPERATOR_TEST", "VERCEL_ENV"]) delete process.env[k];
  await liveStripe.start();
  await testStripe.start();
  const live = createSimulatedStripeRuntime("live", { apiBase: `http://127.0.0.1:${LIVE_PORT}`, secretKey: LIVE_KEY, webhookSecret: LIVE_WHSEC });
  const test = createSimulatedStripeRuntime("test", { apiBase: `http://127.0.0.1:${TEST_PORT}`, secretKey: TEST_KEY, webhookSecret: TEST_WHSEC });
  console.log(`Stripe refund/dispute/settlement E2E (emulator ${host} / ${process.env.FIREBASE_PROJECT_ID}, fake Stripe live :${LIVE_PORT} / test :${TEST_PORT})`);

  const now = jstYearMonth(new Date());
  const [Ma, Mb, Mc] = [shiftYearMonth(now, -3), shiftYearMonth(now, -2), shiftYearMonth(now, -1)];
  const stamp = Date.now();
  const storeA = await createStore({ name: `調整検証店舗A ${stamp}`, contactName: "", postalCode: "", address: "", phone: "", email: "" }, SYSTEM);
  const storeB = await createStore({ name: `調整検証店舗B ${stamp}`, contactName: "", postalCode: "", address: "", phone: "", email: "" }, SYSTEM);

  // ================= 1. 振込前（未払い）の返金・異議申し立て =================
  const a1 = await paid(live, liveStripe, storeA.storeCode, Ma);
  const a2 = await paid(live, liveStripe, storeA.storeCode, Ma);
  const a3 = await paid(live, liveStripe, storeA.storeCode, Ma);
  const a4 = await paid(live, liveStripe, storeA.storeCode, Ma);
  const at = await paid(test, testStripe, storeA.storeCode, Ma); // 同じ店舗・同じ月のテスト決済
  // a4：振込前に全額返金（成功）
  await liveStripe.ctl(`refund/${a4.charge}`);
  assert.equal(outcomeOf(await webhook(live, "charge.refunded", { id: a4.charge, object: "charge" })), "refunded");
  // a3：返金の処理中 → 失敗（売上・取り分を減らさない）
  const rf3 = await liveStripe.ctl(`refund/${a3.charge}`, { status: "pending" });
  assert.equal(outcomeOf(await webhook(live, "refund.created", { id: rf3.refund, object: "refund", charge: a3.charge })), "refund_pending");
  await generateSettlements(Ma, SYSTEM);
  let sA = (await settlementOf(storeA.id, Ma))!;
  assert.deepEqual([sA.transactionCount, sA.grossSales, sA.storeShare, sA.heldShare], [3, 300, 90, 0], "返金の処理中に取り分が減りました");
  await liveStripe.ctl(`refund-status/${rf3.refund}`, { status: "failed" });
  assert.equal(outcomeOf(await webhook(live, "refund.failed", { id: rf3.refund, object: "refund", charge: a3.charge })), "refund_failed");
  assert.equal((await txDoc(a3.txId)).paymentStatus, "SUCCEEDED");
  // a2：異議申し立て（対応中）→ 精算を保留
  const d2 = await liveStripe.ctl(`dispute/${a2.charge}`);
  assert.equal(outcomeOf(await webhook(live, "charge.dispute.created", { id: d2.dispute, object: "dispute", charge: a2.charge })), "dispute_open");
  await generateSettlements(Ma, SYSTEM);
  sA = (await settlementOf(storeA.id, Ma))!;
  assert.deepEqual([sA.transactionCount, sA.grossSales, sA.storeShare, sA.heldShare, sA.status], [3, 300, 60, 30, "UNPAID"]);
  assert.equal((await adjOf(a4.txId)).length + (await adjOf(a2.txId)).length, 0, "振込前なのに調整が作られました");
  // 売上：全額返金は除く。異議申し立ての対応中は売上に数えたまま。テスト決済は含めない
  assert.deepEqual(await monthTotals(Ma, storeA.id), { count: 3, gross: 300, storeShare: 90, operatorShare: 210, fee: 12 });
  assert.equal((await txDoc(at.txId)).livemode, false);
  step("振込前：全額返金は精算から除く（調整なし）。返金の処理中・失敗は減らさない。異議申し立ての対応中は保留（店舗報酬60円・保留30円）。テスト決済は含めない");

  // ================= 2. 精算の確定（処理中 → 支払済）。同時に2回確定しても1回だけ =================
  const lock = await Promise.allSettled([updateSettlementStatus(sA.id, "PROCESSING", "", SYSTEM), updateSettlementStatus(sA.id, "PROCESSING", "", SYSTEM)]);
  assert.equal(lock.filter((r) => r.status === "fulfilled").length >= 1, true);
  sA = (await settlementOf(storeA.id, Ma))!;
  assert.deepEqual([sA.status, sA.storeShare, sA.heldShare, sA.adjustmentTotal, sA.payableAmount, sA.carryOver], ["PROCESSING", 60, 30, 0, 60, 0]);
  assert.deepEqual([(await txDoc(a1.txId)).settledShare, (await txDoc(a2.txId)).settledShare, (await txDoc(a3.txId)).settledShare, (await txDoc(a4.txId)).settledShare], [30, 0, 30, 0]);
  assert.equal((await txDoc(at.txId)).settlementId ?? null, null, "テスト決済が精算に含まれました");
  await updateSettlementStatus(sA.id, "PAID", "振込済み（テスト）", SYSTEM);
  await assert.rejects(updateSettlementStatus(sA.id, "UNPAID", "", SYSTEM), /未払いに戻せません/);
  const paidA = (await settlementOf(storeA.id, Ma))!;
  assert.deepEqual([paidA.status, paidA.payableAmount], ["PAID", 60]);
  step("確定：同時に2回押しても1回だけ。各取引に支払う額を記録（保留・返金済みは0円）。振込額60円。支払済は未払いに戻せない。テスト決済は含めない");

  // ================= 3. 振込後の返金：Webhook の再送・重複・同時実行でも調整は1件 =================
  await liveStripe.ctl(`refund/${a1.charge}`);
  const dupRun = Date.now().toString(36); // 実行ごとに別の通知ID（Emulator のデータは実行をまたいで残る）
  const re = await Promise.all([
    webhook(live, "charge.refunded", { id: a1.charge, object: "charge" }, { eventId: `evt_settle_dup_A_${dupRun}` }),
    webhook(live, "charge.refunded", { id: a1.charge, object: "charge" }, { eventId: `evt_settle_dup_B_${dupRun}` }),
    webhook(live, "refund.updated", { id: "re_x", object: "refund", charge: a1.charge }),
    syncStripeRefunds(a1.charge, live),
  ]);
  assert.deepEqual((await webhook(live, "charge.refunded", { id: a1.charge, object: "charge" }, { eventId: `evt_settle_dup_A_${dupRun}` })).body, { received: true, duplicate: true });
  assert.ok(re.slice(0, 3).every((r) => (r as { status: number }).status === 200));
  let adj = await adjOf(a1.txId);
  assert.equal(adj.length, 1, `振込後の返金の調整が${adj.length}件です`);
  assert.deepEqual(
    { amount: adj[0].amount, reason: adj[0].reason, status: adj[0].status, storeId: adj[0].storeId, yearMonth: adj[0].yearMonth, providerPaymentId: adj[0].providerPaymentId, stripeChargeId: adj[0].stripeChargeId, source: adj[0].sourceSettlementId },
    { amount: -30, reason: "refund", status: "OPEN", storeId: storeA.id, yearMonth: Ma, providerPaymentId: a1.pi, stripeChargeId: a1.charge, source: sA.id },
  );
  assert.deepEqual([(await settlementOf(storeA.id, Ma))!.payableAmount, (await settlementOf(storeA.id, Ma))!.status], [60, "PAID"], "支払済みの精算が書き換えられました");
  step("振込後の返金：通知2通（別ID）・再送・別の通知・直接の再取得が同時でも調整は1件（-30円・理由・元の決済ID・店舗・対象月・状態 OPEN）。支払済みの精算は変えない");

  // ================= 4. 振込後の異議申し立て（勝訴）・一部返金・敗訴 =================
  // a2（確定時に保留＝0円）：勝訴 → +30円（保留の解除）
  await liveStripe.ctl(`dispute-status/${d2.dispute}`, { status: "under_review" });
  assert.equal(outcomeOf(await webhook(live, "charge.dispute.updated", { id: d2.dispute, object: "dispute" })), "dispute_open");
  assert.equal((await adjOf(a2.txId)).length, 0, "保留中の取引に調整が作られました");
  await liveStripe.ctl(`dispute-status/${d2.dispute}`, { status: "won" });
  const dw = await Promise.all([
    webhook(live, "charge.dispute.closed", { id: d2.dispute, object: "dispute" }),
    webhook(live, "charge.dispute.funds_reinstated", { id: d2.dispute, object: "dispute" }),
    syncStripeDispute(d2.dispute!, live),
  ]);
  assert.ok(dw.slice(0, 2).every((r) => (r as { status: number }).status === 200));
  adj = await adjOf(a2.txId);
  assert.deepEqual(adj.map((a) => [a.amount, a.reason]), [[30, "dispute_won"]]);
  assert.equal((await txDoc(a2.txId)).disputeStatus, "won");
  // a3：一部返金（30円。Stripe 側で発生）→ 店舗の取り分は 70円×30%＝21円（-9円）
  await liveStripe.ctl(`refund/${a3.charge}`, { amount: 30 });
  assert.equal(outcomeOf(await webhook(live, "charge.refunded", { id: a3.charge, object: "charge" })), "partial");
  adj = await adjOf(a3.txId);
  assert.deepEqual(adj.map((a) => [a.amount, a.reason]), [[-9, "partial_refund"]]);
  const t3 = await txDoc(a3.txId);
  assert.deepEqual([t3.amount, t3.storeShare, t3.operatorShare, t3.amountRefunded, t3.paymentStatus, t3.refundNeedsReview], [100, 30, 70, 30, "SUCCEEDED", true], "決済時の記録が書き換えられました");
  // a3：その後に異議申し立て → 保留（-21円）→ 敗訴（追加の調整なし。売上から除く）
  const d3 = await liveStripe.ctl(`dispute/${a3.charge}`, { amount: 70 });
  assert.equal(outcomeOf(await webhook(live, "charge.dispute.created", { id: d3.dispute, object: "dispute" })), "dispute_open");
  await liveStripe.ctl(`dispute-status/${d3.dispute}`, { status: "lost" });
  assert.equal(outcomeOf(await webhook(live, "charge.dispute.closed", { id: d3.dispute, object: "dispute" })), "dispute_lost");
  assert.equal(outcomeOf(await webhook(live, "charge.dispute.funds_withdrawn", { id: d3.dispute, object: "dispute" })), "unchanged");
  adj = await adjOf(a3.txId);
  assert.deepEqual(adj.map((a) => [a.amount, a.reason]).sort(), [[-21, "dispute_hold"], [-9, "partial_refund"]].sort());
  assert.deepEqual([(await txDoc(a3.txId)).paymentStatus, (await txDoc(a3.txId)).countable], ["CHARGEBACK", false]);
  // 売上（Ma・店舗A）：a1 返金・a3 敗訴・a4 返金を除き、a2（勝訴）だけ
  assert.deepEqual(await monthTotals(Ma, storeA.id), { count: 1, gross: 100, storeShare: 30, operatorShare: 70, fee: 4 });
  step("振込後の異議申し立て：対応中は調整なし（確定時に保留済み）→ 勝訴で +30円（同時の通知でも1件）。一部返金は -9円（返金後70円の30%＝21円）・決済時の記録は不変。その後の敗訴は保留の -21円だけで二重に引かない。売上から除く");

  // ================= 5. 締め後に確定した決済（確定済みの月）：支払った額0円＋調整 =================
  const late = await paid(live, liveStripe, storeA.storeCode, Ma);
  const gen = await generateSettlements(Ma, SYSTEM);
  assert.equal(gen.late, 1);
  assert.deepEqual((await adjOf(late.txId)).map((a) => [a.amount, a.reason]), [[30, "late_transaction"]]);
  await generateSettlements(Ma, SYSTEM); // もう一度集計しても増えない
  assert.equal((await adjOf(late.txId)).length, 1);
  assert.deepEqual([(await settlementOf(storeA.id, Ma))!.payableAmount, (await settlementOf(storeA.id, Ma))!.storeShare], [60, 60], "支払済みの精算が書き換えられました");
  step("締め後に確定した決済：支払済みの月に取り込み（支払った額0円）、+30円の調整。再集計しても1件。支払済みの精算は不変");

  // ================= 6. 次回の精算に調整を反映（店舗A：Mb） =================
  await paid(live, liveStripe, storeA.storeCode, Mb);
  await paid(live, liveStripe, storeA.storeCode, Mb);
  await generateSettlements(Mb, SYSTEM);
  let sAb = (await settlementOf(storeA.id, Mb))!;
  assert.deepEqual([sAb.storeShare, sAb.payableAmount], [60, null]);
  const openA = (await listAdjustments({ storeId: storeA.id })).filter((a) => a.status === "OPEN");
  const openSum = openA.reduce((s, a) => s + a.amount, 0);
  assert.equal(openSum, -30 + 30 - 9 - 21 + 30); // = 0
  await updateSettlementStatus(sAb.id, "PAID", "", SYSTEM);
  sAb = (await settlementOf(storeA.id, Mb))!;
  assert.deepEqual([sAb.storeShare, sAb.adjustmentTotal, sAb.payableAmount, sAb.carryOver], [60, 0, 60, 0]);
  const appliedA = (await listAdjustments({ storeId: storeA.id })).filter((a) => openA.some((o) => o.id === a.id));
  assert.ok(appliedA.every((a) => a.status === "APPLIED" && a.appliedSettlementId === sAb.id), "調整が次回の精算に反映されていません");
  step(`次回の精算（${Mb}）：未反映の調整5件（-30・+30・-9・-21・+30）を反映して振込額 60円。調整は APPLIED（反映先の精算を記録）`);

  // ================= 7. 調整が次回の振込額を超える → 0円にして繰越（店舗B：Ma → Mb → Mc） =================
  const b1 = await paid(live, liveStripe, storeB.storeCode, Ma);
  const b2 = await paid(live, liveStripe, storeB.storeCode, Ma);
  await generateSettlements(Ma, SYSTEM);
  const sBa = (await settlementOf(storeB.id, Ma))!;
  await updateSettlementStatus(sBa.id, "PAID", "", SYSTEM);
  assert.equal((await settlementOf(storeB.id, Ma))!.payableAmount, 60);
  await liveStripe.ctl(`refund/${b1.charge}`);
  await webhook(live, "charge.refunded", { id: b1.charge, object: "charge" });
  const db2 = await liveStripe.ctl(`dispute/${b2.charge}`, { status: "lost" });
  assert.equal(outcomeOf(await webhook(live, "charge.dispute.created", { id: db2.dispute, object: "dispute" })), "dispute_lost");
  assert.deepEqual((await adjOf(b2.txId)).map((a) => [a.amount, a.reason]), [[-30, "dispute_lost"]]);
  await paid(live, liveStripe, storeB.storeCode, Mb);
  await generateSettlements(Mb, SYSTEM);
  const sBb = (await settlementOf(storeB.id, Mb))!;
  await updateSettlementStatus(sBb.id, "PAID", "", SYSTEM);
  const sBb2 = (await settlementOf(storeB.id, Mb))!;
  assert.deepEqual([sBb2.storeShare, sBb2.adjustmentTotal, sBb2.payableAmount, sBb2.carryOver], [30, -60, 0, -30]);
  const carry = (await fsdb().collection(C.settlementAdjustments).doc(`carry_${sBb2.id}`).get()).data()!;
  assert.deepEqual([carry.amount, carry.reason, carry.status, carry.storeId, carry.yearMonth], [-30, "carryover", "OPEN", storeB.id, Mb]);
  await paid(live, liveStripe, storeB.storeCode, Mc);
  await paid(live, liveStripe, storeB.storeCode, Mc);
  await generateSettlements(Mc, SYSTEM);
  const sBc = (await settlementOf(storeB.id, Mc))!;
  await updateSettlementStatus(sBc.id, "PROCESSING", "", SYSTEM);
  const sBc2 = (await settlementOf(storeB.id, Mc))!;
  assert.deepEqual([sBc2.storeShare, sBc2.adjustmentTotal, sBc2.payableAmount, sBc2.carryOver], [60, -30, 30, 0]);
  assert.equal((await fsdb().collection(C.settlementAdjustments).doc(`carry_${sBb2.id}`).get()).get("status"), "APPLIED");
  step(`繰越：${Ma}振込後の返金・敗訴で -60円 → ${Mb}（30円）は振込0円・-30円を繰越 → ${Mc}（60円）で差し引いて振込30円`);

  // ================= 8. 照合：決済ID・店舗・金額・モードが一致しない通知は反映しない =================
  const c1 = await paid(live, liveStripe, storeA.storeCode, Mc);
  await liveStripe.ctl(`pi-metadata/${c1.pi}`, { metadataStoreId: storeB.id });
  await liveStripe.ctl(`refund/${c1.charge}`);
  assert.equal(outcomeOf(await webhook(live, "charge.refunded", { id: c1.charge, object: "charge" })), "rejected");
  const dc = await liveStripe.ctl(`dispute/${c1.charge}`);
  assert.equal(outcomeOf(await webhook(live, "charge.dispute.created", { id: dc.dispute, object: "dispute" })), "rejected");
  assert.deepEqual([(await txDoc(c1.txId)).paymentStatus, (await txDoc(c1.txId)).disputeStatus ?? null], ["SUCCEEDED", null]);
  const c2 = await paid(live, liveStripe, storeA.storeCode, Mc);
  const dbig = await liveStripe.ctl(`dispute/${c2.charge}`, { amount: 1000 });
  assert.equal(outcomeOf(await webhook(live, "charge.dispute.created", { id: dbig.dispute, object: "dispute" })), "rejected");
  // 署名の不一致・モードの取り違え（テストの環境に本番の通知、本番の環境にテストの通知）
  assert.equal((await webhook(live, "charge.dispute.created", { id: dc.dispute }, { secret: "whsec_wrong" })).status, 400);
  assert.equal((await webhook(test, "charge.dispute.created", { id: dc.dispute }, { livemode: true })).status, 400);
  assert.equal((await webhook(live, "charge.refunded", { id: c2.charge }, { livemode: false })).status, 400);
  // テストの接続では、本番の返金・異議申し立てを扱えない（Stripe も別のモードは「見つからない」と返す）
  await assert.rejects(syncStripeDispute(dc.dispute!, test), /No such dispute/);
  step("照合：店舗の食い違い・金額の食い違いは反映しない（rejected）。署名の不一致・本番とテストの取り違えは 400。テストの接続では本番の返金・異議申し立てを扱わない");

  // ================= 9. テスト決済の返金・異議申し立ては本番の精算に混ざらない =================
  await testStripe.ctl(`refund/${at.charge}`);
  assert.equal(outcomeOf(await webhook(test, "charge.refunded", { id: at.charge, object: "charge" })), "refunded");
  const dt = await testStripe.ctl(`dispute/${at.charge}`, { status: "lost" });
  await webhook(test, "charge.dispute.created", { id: dt.dispute, object: "dispute" });
  assert.equal((await adjOf(at.txId)).length, 0, "テスト決済の調整が作られました");
  assert.equal((await txDoc(at.txId)).settlementId ?? null, null);
  const allAdj = await listAdjustments({ storeId: storeA.id });
  assert.ok(allAdj.every((a) => a.transactionId !== at.txId));
  step("テスト決済の返金・異議申し立て：調整は作らず、精算にも含めない");

  // ================= 10. 画面：運営の精算・決済履歴、店舗の振込状況で確認できる =================
  const opId = await createOperator({ name: "調整検証運営", email: `settle-op-${stamp}@example.com`, password: "SettleOperator123" });
  const staffId = await createStoreUser(storeB.id, { name: "店舗B担当", email: `settle-staff-${stamp}@example.com`, password: "SettleStaff12345" }, SYSTEM);
  const app = await startApp();
  try {
    const opHtml = async (path: string) => (await fetchAs(opId, path)).text();
    let html = await opHtml(`/admin/settlements?ym=${Mb}`);
    for (const w of ["精算の調整", "振込後の返金", "異議申し立て（敗訴）", "前回からの繰越", "繰越 -¥30", a1.pi]) assert.ok(html.includes(w), `運営の精算画面: ${w}`);
    html = await opHtml(`/admin/settlements?ym=${Ma}`);
    assert.ok(html.includes("保留（異議申し立て）"), "運営の精算画面: 保留");
    html = await opHtml(`/admin/transactions?ym=${Ma}&storeId=${storeA.id}`);
    for (const w of ["チャージバック", "異議申し立て勝訴", "異議申し立て（チャージバック）の確認が必要な決済"]) assert.ok(html.includes(w), `運営の決済履歴: ${w}`);
    const csv = await (await fetchAs(opId, `/api/admin/settlements?ym=${Mb}`)).text();
    assert.ok(csv.includes(`"${Mb}","${storeB.name}","1","100","30","0","-60","-30","0"`), "振込用CSVの調整・繰越・振込額");
    html = await (await fetchAs(staffId, "/store/settlements")).text();
    for (const w of ["振込額の調整", "振込後の返金", "異議申し立て（敗訴）", "前回からの繰越", "次回へ繰越 -¥30"]) assert.ok(html.includes(w), `店舗の振込状況: ${w}`);
    assert.ok(!html.includes(storeA.name) && !html.includes(a1.pi), "店舗の画面に他店舗・決済IDが表示されました");
    assert.equal((await fetchAs(staffId, `/admin/settlements?ym=${Mb}`)).status, 404, "店舗アカウントが運営の精算画面を開けました");
    html = await opHtml("/admin/payment-reviews");
    for (const w of ["決済要確認", "Stripe の決済と記録が一致しない", "一致しない項目：店舗", "異議申し立ての金額・通貨が決済と合わない", c1.charge, "未確認"]) assert.ok(html.includes(w), `運営の決済要確認: ${w}`);
    assert.doesNotMatch(html, /whsec_|sk_live_|sk_test_/, "決済要確認の画面に秘密情報が表示されました");
    assert.equal((await fetchAs(staffId, "/admin/payment-reviews")).status, 404, "店舗アカウントが決済要確認を開けました");
  } finally {
    await stopApp(app);
  }
  step("画面：運営の精算（調整の一覧・理由・元の決済ID・繰越・保留）、決済要確認（原因・対象ID・未確認）、決済履歴（チャージバック・勝訴・確認が必要な一覧）、振込用CSV（調整・繰越・振込額）、店舗の振込状況（自店舗の調整だけ）");

  console.log("\nSTRIPE SETTLEMENT E2E PASSED");
}

const APP_PORT = 3220;
async function fetchAs(userId: string, path: string) {
  const token = randomToken(32);
  await fsdb().collection(C.authSessions).doc(sha256Hex(token)).set({ userId, expiresAt: new Date(Date.now() + 3600_000) });
  return fetch(`http://localhost:${APP_PORT}${path}`, { headers: { cookie: `sid=${token}`, "x-real-ip": "203.0.113.77" }, redirect: "manual" });
}
async function startApp(): Promise<ChildProcess> {
  const env: NodeJS.ProcessEnv = { ...process.env, PORT: String(APP_PORT), APP_URL: `http://localhost:${APP_PORT}`, DB_PROVIDER: "firestore", SITE_STATUS: "open", ENABLE_TEST_PAYMENT: "false", PAYMENT_PROVIDER: "payjp", PAYJP_PUBLIC_KEY: "", PAYJP_SECRET_KEY: "", PAYJP_WEBHOOK_TOKEN: "", SESSION_SECRET: `e2e-settle-${randomToken(24)}` };
  delete env.VERCEL_ENV;
  const child = spawn("node_modules/.bin/next", ["start", "-p", String(APP_PORT)], { env, stdio: ["ignore", "pipe", "pipe"] });
  let log = "";
  child.stdout!.on("data", (d) => (log += d));
  child.stderr!.on("data", (d) => (log += d));
  for (let i = 0; i < 120; i++) {
    if (child.exitCode !== null) throw new Error(`アプリが起動しませんでした\n${log.slice(-2000)}`);
    try {
      await fetch(`http://localhost:${APP_PORT}/api/health`);
      return child;
    } catch {
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  throw new Error("アプリが起動しませんでした");
}
async function stopApp(child: ChildProcess) {
  if (child.exitCode !== null) return;
  await new Promise<void>((resolve) => {
    child.once("exit", () => resolve());
    child.kill("SIGTERM");
  });
}

main()
  .then(async () => {
    await Promise.all([liveStripe.stop(), testStripe.stop()]);
    process.exit(0);
  })
  .catch(async (e) => {
    console.error("\nSTRIPE SETTLEMENT E2E FAILED:", e);
    await Promise.all([liveStripe.stop(), testStripe.stop()]).catch(() => undefined);
    process.exit(1);
  });
