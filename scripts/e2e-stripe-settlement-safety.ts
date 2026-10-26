/**
 * 精算の安全性の E2E 検証（返金・異議申し立てと精算の確定の組み合わせ）。
 *  - 以前の仕組みで確定した精算（取引ごとの支払った額の記録が無い）：推測で調整せず「決済要確認」に記録する
 *  - 照合の失敗：決済要確認に記録（再送で増えない・確認済み・内容が変わったら未確認に戻る）。署名が不正な通知は記録しない
 *  - 確定の順番：古い月から（逆順・同時の確定でも調整の二重反映・消失が無い）。反映先の追跡・繰越
 *  - 一部の額だけの異議申し立て、順不同・古い状態の通知、確定中の Webhook、大量の取引・調整
 * 本物の Stripe・本番の Firebase には一切接続しない（localhost の模擬 Stripe と Firestore Emulator の demo- プロジェクトだけ）。
 *
 *   firebase emulators:start --only firestore --project demo-uranai
 *   （別ターミナル）FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 FIREBASE_PROJECT_ID=demo-uranai-safety DB_PROVIDER=firestore npm run e2e:stripe-settlement-safety
 */
import "dotenv/config";
import assert from "node:assert/strict";
import Stripe from "stripe";
import { FieldValue } from "firebase-admin/firestore";
import { createFakeStripe } from "./lib/fake-stripe";
import { C, fsdb } from "@/lib/firestore/admin";
import { dataProvider } from "@/lib/data-provider";
import { createStore } from "@/lib/services/stores";
import { monthTotals } from "@/lib/services/reports";
import { generateSettlements, updateSettlementStatus } from "@/lib/services/settlements";
import { txFacts } from "@/lib/firestore/settlement-adjustments";
import { listPaymentReviews, paymentReviewId, resolvePaymentReview } from "@/lib/firestore/payment-reviews";
import { salesKeys } from "@/lib/firestore/shared";
import { createCheckout } from "@/lib/firestore/payments";
import { jstYearMonth, shiftYearMonth } from "@/lib/time";
import { entitledStoreShare, heldStoreShare } from "@/lib/payments/settlement-rules";
import { createSimulatedStripeRuntime, STRIPE_SESSION_TTL_MS, type StripeRuntime } from "@/lib/payments/stripe-checkout";
import { startStripeCheckout, syncStripeDispute } from "@/lib/payments/stripe-confirm";
import { handleStripeWebhook } from "@/lib/payments/stripe-webhook";

const SYSTEM = { userId: null, role: "SYSTEM" as const };
const OPERATOR = { userId: "op-safety", role: "OPERATOR" as const };
const step = (msg: string) => console.log(`  ✓ ${msg}`);
const ORIGIN = "http://localhost:3000";

const LIVE_PORT = 12119;
const TEST_PORT = 12120;
const LIVE_KEY = "sk_live_e2e_safety_dummy";
const TEST_KEY = "sk_test_e2e_safety_dummy";
const LIVE_WHSEC = "whsec_e2e_safety_live_dummy";
const TEST_WHSEC = "whsec_e2e_safety_test_dummy";
const liveStripe = createFakeStripe({ port: LIVE_PORT, mode: "live", apiKey: LIVE_KEY });
const testStripe = createFakeStripe({ port: TEST_PORT, mode: "test", apiKey: TEST_KEY });

const signer = new Stripe("sk_test_signer");
let evN = 0;
async function webhook(rt: StripeRuntime, type: string, object: Record<string, unknown>, opts: { livemode?: boolean; secret?: string; eventId?: string } = {}) {
  const livemode = opts.livemode ?? rt.mode === "live";
  const payload = JSON.stringify({ id: opts.eventId ?? `evt_safety_${++evN}_${Date.now()}`, object: "event", type, livemode, data: { object } });
  const sig = signer.webhooks.generateTestHeaderString({ payload, secret: opts.secret ?? rt.webhookSecret });
  return handleStripeWebhook(payload, sig, rt);
}
const outcomeOf = (r: { body: unknown }) => (r.body as { outcome?: string }).outcome;

async function paid(rt: StripeRuntime, stripe: ReturnType<typeof createFakeStripe>, storeCode: string, ym: string) {
  const { checkoutId, accessToken } = await createCheckout(storeCode, "ZODIAC", { provider: "stripe", ttlMs: STRIPE_SESSION_TTL_MS });
  const r = await startStripeCheckout(accessToken, ORIGIN, rt);
  const sessionId = (r as { url: string }).url.split("/").pop()!;
  const created = Math.floor(new Date(`${ym}-15T12:00:00+09:00`).getTime() / 1000);
  const p = await stripe.ctl(`pay/${sessionId}`, { created, fee: 4 });
  assert.equal(outcomeOf(await webhook(rt, "checkout.session.completed", { id: sessionId, object: "checkout.session" })), "confirmed");
  const [t] = (await fsdb().collection(C.transactions).where("checkoutId", "==", checkoutId).get()).docs;
  return { txId: t.id, charge: p.charge!, pi: p.paymentIntent! };
}
const txDoc = async (id: string) => (await fsdb().collection(C.transactions).doc(id).get()).data()!;
const adjOf = async (txId: string) => (await fsdb().collection(C.settlementAdjustments).where("transactionId", "==", txId).get()).docs.map((d) => d.data());
const stDoc = async (storeId: string, ym: string) => (await fsdb().collection(C.settlements).doc(`${storeId}_${ym}`).get()).data();
const reviewDoc = async (kind: Parameters<typeof paymentReviewId>[0], objectId: string) => (await fsdb().collection(C.paymentReviews).doc(paymentReviewId(kind, objectId)).get()).data();
const newStore = async (label: string) => createStore({ name: `${label} ${Date.now()}`, contactName: "", postalCode: "", address: "", phone: "", email: "" }, SYSTEM);

/**
 * 精算の整合性（店舗ごと）：
 *  - 確定済みの精算に含めた取引は「支払った額 + これまでの調整 = 今の取り分」
 *  - 調整の合計は取引の記録（adjustmentTotal）と一致する
 *  - 確定済みの精算の店舗報酬 = 含めた取引の支払った額の合計、振込額 = max(0, 店舗報酬 + 反映した調整)
 *  - 反映済みの調整は1つの精算にだけ反映され、その精算の反映の一覧に入っている（追跡できる）
 */
async function checkInvariants(storeId: string) {
  const txs = await fsdb().collection(C.transactions).where("storeId", "==", storeId).get();
  const adjs = await fsdb().collection(C.settlementAdjustments).where("storeId", "==", storeId).get();
  const sts = await fsdb().collection(C.settlements).where("storeId", "==", storeId).get();
  const adjByTx = new Map<string, number>();
  for (const a of adjs.docs) if (a.get("transactionId")) adjByTx.set(a.get("transactionId"), (adjByTx.get(a.get("transactionId")) ?? 0) + Number(a.get("amount")));
  for (const t of txs.docs) {
    if (!t.get("settlementId")) continue;
    const settled = Number(t.get("settledShare"));
    const adjTotal = Number(t.get("adjustmentTotal") ?? 0);
    assert.equal(settled + adjTotal, entitledStoreShare(txFacts(t.data())), `取引 ${t.id}：支払った額＋調整 ≠ 今の取り分`);
    assert.equal(adjByTx.get(t.id) ?? 0, adjTotal, `取引 ${t.id}：調整の合計が記録と一致しません`);
  }
  for (const s of sts.docs) {
    if (s.get("status") === "UNPAID" || !s.get("lockedAt")) continue;
    const settledSum = txs.docs.filter((t) => t.get("settlementId") === s.id).reduce((a, t) => a + Number(t.get("settledShare")), 0);
    assert.equal(Number(s.get("storeShare")), settledSum, `精算 ${s.id}：店舗報酬 ≠ 支払った額の合計`);
    const applied = adjs.docs.filter((a) => a.get("appliedSettlementId") === s.id);
    const appliedSum = applied.reduce((a, d) => a + Number(d.get("amount")), 0);
    assert.equal(Number(s.get("adjustmentTotal")), appliedSum, `精算 ${s.id}：反映した調整の合計が一致しません`);
    assert.deepEqual([...(s.get("appliedAdjustmentIds") as string[])].sort(), applied.map((a) => a.id).sort(), `精算 ${s.id}：反映の一覧が一致しません`);
    const total = Number(s.get("storeShare")) + appliedSum;
    assert.deepEqual([Number(s.get("payableAmount")), Number(s.get("carryOver"))], [Math.max(0, total), Math.min(0, total)], `精算 ${s.id}：振込額・繰越`);
  }
  for (const a of adjs.docs) if (a.get("status") === "APPLIED") assert.ok(sts.docs.some((s) => s.id === a.get("appliedSettlementId")), `調整 ${a.id}：反映先の精算がありません`);
}

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
  console.log(`Stripe settlement safety E2E (emulator ${host} / ${process.env.FIREBASE_PROJECT_ID}, fake Stripe live :${LIVE_PORT} / test :${TEST_PORT})`);
  const now = jstYearMonth(new Date());
  const [Ma, Mb, Mc] = [shiftYearMonth(now, -3), shiftYearMonth(now, -2), shiftYearMonth(now, -1)];

  // ================= 1. 以前の仕組みで確定した精算（支払った額の記録が無い） =================
  const storeL = await newStore("旧精算検証店舗");
  const l1 = await paid(live, liveStripe, storeL.storeCode, Ma);
  const l2 = await paid(live, liveStripe, storeL.storeCode, Ma);
  await generateSettlements(Ma, SYSTEM);
  // 段階4より前のコードと同じく、状態だけを支払済にする（lockedAt・取引ごとの支払った額は記録されない）
  await fsdb().collection(C.settlements).doc(`${storeL.id}_${Ma}`).update({ status: "PAID", paidAt: new Date(), updatedAt: FieldValue.serverTimestamp() });
  const legacyBefore = await stDoc(storeL.id, Ma);
  const genL = await generateSettlements(Ma, SYSTEM);
  assert.equal(genL.late, 0, "以前に確定した精算の取引を「締め後の決済」として取り込みました（二重払いになります）");
  assert.equal((await txDoc(l1.txId)).settlementId ?? null, null);
  assert.equal((await adjOf(l1.txId)).length + (await adjOf(l2.txId)).length, 0);
  // 振込後の返金：推測で差し引かず、決済要確認に記録
  await liveStripe.ctl(`refund/${l1.charge}`);
  assert.equal(outcomeOf(await webhook(live, "charge.refunded", { id: l1.charge, object: "charge" })), "refunded");
  assert.equal(outcomeOf(await webhook(live, "charge.refunded", { id: l1.charge, object: "charge" })), "unchanged");
  assert.equal((await adjOf(l1.txId)).length, 0, "支払った額が不明なのに調整を作りました");
  let rv = await reviewDoc("legacy_settlement_change", l1.txId);
  assert.ok(rv, "以前に確定した精算の月の返金が要確認に記録されていません");
  assert.deepEqual([rv.status, rv.amount, rv.storeId, rv.yearMonth, rv.settlementId, rv.occurrences], ["OPEN", -30, storeL.id, Ma, `${storeL.id}_${Ma}`, 1]);
  // 異議申し立て（敗訴）も同じ
  const dL = await liveStripe.ctl(`dispute/${l2.charge}`, { status: "lost" });
  assert.equal(outcomeOf(await webhook(live, "charge.dispute.created", { id: dL.dispute, object: "dispute" })), "dispute_lost");
  assert.equal((await adjOf(l2.txId)).length, 0);
  assert.equal((await reviewDoc("legacy_settlement_change", l2.txId))?.amount, -30);
  // 再集計：金額の食い違いを要確認に（くり返しても1件）。精算の金額・取引の記録は変えない
  await generateSettlements(Ma, SYSTEM);
  await generateSettlements(Ma, SYSTEM);
  rv = await reviewDoc("legacy_settlement_mismatch", `${storeL.id}_${Ma}`);
  assert.deepEqual([rv?.amount, rv?.occurrences, rv?.status], [-60, 2, "OPEN"]);
  const legacyAfter = await stDoc(storeL.id, Ma);
  assert.deepEqual([legacyAfter!.storeShare, legacyAfter!.status, legacyAfter!.payableAmount ?? null], [legacyBefore!.storeShare, "PAID", legacyBefore!.payableAmount ?? null], "以前に確定した精算の金額を書き換えました");
  assert.deepEqual([(await txDoc(l1.txId)).amount, (await txDoc(l1.txId)).storeShare], [100, 30]);
  // 次の月（新しい仕組み）：以前の月の分は差し引かない（要確認のまま）
  await paid(live, liveStripe, storeL.storeCode, Mb);
  await generateSettlements(Mb, SYSTEM);
  await updateSettlementStatus(`${storeL.id}_${Mb}`, "PAID", "", SYSTEM);
  assert.deepEqual([(await stDoc(storeL.id, Mb))!.payableAmount, (await stDoc(storeL.id, Mb))!.adjustmentTotal], [30, 0]);
  // 新しい仕組みで確定した月の取引への返金は、今までどおり調整になる
  const [lb] = (await fsdb().collection(C.transactions).where("storeYm", "==", `${storeL.id}_${Mb}`).get()).docs;
  await liveStripe.ctl(`refund/${lb.get("stripeChargeId")}`);
  await webhook(live, "charge.refunded", { id: lb.get("stripeChargeId"), object: "charge" });
  assert.deepEqual((await adjOf(lb.id)).map((a) => [a.amount, a.reason]), [[-30, "refund"]]);
  await checkInvariants(storeL.id);
  step("以前に確定した精算：締め後の決済として取り込まない。返金・敗訴は推測で差し引かず要確認（取り分の変化 -30円）。再集計の食い違いも要確認（くり返しても1件）。精算の金額・取引は不変。新しい仕組みの月は調整");

  // ================= 2. 決済要確認：照合の失敗・再送で増えない・確認済み・署名が不正な通知は記録しない =================
  const storeR = await newStore("要確認検証店舗");
  const r1 = await paid(live, liveStripe, storeR.storeCode, Mc);
  await liveStripe.ctl(`pi-metadata/${r1.pi}`, { metadataStoreId: storeL.id });
  await liveStripe.ctl(`refund/${r1.charge}`);
  for (let i = 0; i < 3; i++) assert.equal(outcomeOf(await webhook(live, "charge.refunded", { id: r1.charge, object: "charge" })), "rejected");
  rv = await reviewDoc("charge_mismatch", r1.charge);
  assert.deepEqual([rv?.status, rv?.occurrences, rv?.mismatches, rv?.transactionId, rv?.storeId, rv?.eventType], ["OPEN", 3, ["store"], r1.txId, storeR.id, "charge.refunded"]);
  assert.equal((await txDoc(r1.txId)).paymentStatus, "SUCCEEDED", "照合に失敗した返金を反映しました");
  // 同じ通知の再送（同じ通知ID）は処理しないので回数も増えない
  const resendId = `evt_safety_resend_${Date.now()}`; // 実行ごとに別の通知ID（Emulator のデータは実行をまたいで残る）
  const resend = await webhook(live, "charge.refunded", { id: r1.charge, object: "charge" }, { eventId: resendId });
  await webhook(live, "charge.refunded", { id: r1.charge, object: "charge" }, { eventId: resendId });
  assert.equal(outcomeOf(resend), "rejected");
  assert.equal((await reviewDoc("charge_mismatch", r1.charge))?.occurrences, 4);
  // 確認済み → 同じ内容のくり返しでは戻らない → 内容が変わったら未確認に戻る
  assert.equal(await resolvePaymentReview(paymentReviewId("charge_mismatch", r1.charge), OPERATOR), true);
  await webhook(live, "charge.refunded", { id: r1.charge, object: "charge" });
  assert.deepEqual([(await reviewDoc("charge_mismatch", r1.charge))?.status, (await reviewDoc("charge_mismatch", r1.charge))?.occurrences], ["RESOLVED", 5]);
  // 内容が変わった（店舗に加えて金額も食い違う）→ 未確認に戻る
  await fsdb().collection(C.transactions).doc(r1.txId).update({ amount: 99 });
  await webhook(live, "charge.refunded", { id: r1.charge, object: "charge" });
  assert.deepEqual([(await reviewDoc("charge_mismatch", r1.charge))?.status, (await reviewDoc("charge_mismatch", r1.charge))?.mismatches], ["OPEN", ["amount", "store"]]);
  await fsdb().collection(C.transactions).doc(r1.txId).update({ amount: 100 });
  const dR = await liveStripe.ctl(`dispute/${r1.charge}`);
  await webhook(live, "charge.dispute.created", { id: dR.dispute, object: "dispute" });
  assert.deepEqual([(await reviewDoc("charge_mismatch", dR.dispute!))?.status, (await reviewDoc("charge_mismatch", dR.dispute!))?.objectType], ["OPEN", "dispute"]);
  // 決済記録が無い（このアプリの注文の決済）
  const r2 = await paid(live, liveStripe, storeR.storeCode, Mc);
  await fsdb().collection(C.transactions).doc(r2.txId).delete();
  const dN = await liveStripe.ctl(`dispute/${r2.charge}`);
  assert.equal(outcomeOf(await webhook(live, "charge.dispute.created", { id: dN.dispute, object: "dispute" })), "ignored");
  assert.equal((await reviewDoc("transaction_not_found", dN.dispute!))?.status, "OPEN");
  // 異議申し立ての金額が決済を超える
  const r3 = await paid(live, liveStripe, storeR.storeCode, Mc);
  const dBig = await liveStripe.ctl(`dispute/${r3.charge}`, { amount: 500 });
  assert.equal(outcomeOf(await webhook(live, "charge.dispute.created", { id: dBig.dispute, object: "dispute" })), "rejected");
  assert.deepEqual((await reviewDoc("dispute_amount_invalid", dBig.dispute!))?.mismatches, ["amount"]);
  // 本番とテストの取り違え（署名は正しい）
  await webhook(test, "charge.refunded", { id: "ch_live_mixed_up", object: "charge" }, { livemode: true });
  assert.equal((await reviewDoc("mode_mismatch", "ch_live_mixed_up"))?.status, "OPEN");
  // 署名が不正な通知は何も記録しない（決済要確認も、通知の処理済みの記録も）
  const before = (await fsdb().collection(C.paymentReviews).count().get()).data().count;
  const forged = await webhook(live, "charge.dispute.created", { id: "dp_forged_000001", object: "dispute" }, { secret: "whsec_forged" });
  const forged2 = await webhook(test, "charge.refunded", { id: "ch_forged_000001", object: "charge" }, { secret: "whsec_forged", livemode: true });
  assert.deepEqual([forged.status, forged2.status], [400, 400]);
  assert.equal((await fsdb().collection(C.paymentReviews).count().get()).data().count, before, "署名が不正な通知を要確認に記録しました");
  // 秘密情報・カード情報を保存していない（保存する項目は ID・金額・項目名だけ）
  const allowed = new Set(["kind", "objectType", "objectId", "eventType", "transactionId", "storeId", "chargeId", "paymentIntentId", "settlementId", "yearMonth", "mismatches", "amount", "livemode", "causeKey", "status", "occurrences", "firstSeenAt", "lastSeenAt", "resolvedAt", "resolvedBy"]);
  for (const d of (await fsdb().collection(C.paymentReviews).get()).docs) {
    for (const k of Object.keys(d.data())) assert.ok(allowed.has(k), `決済要確認に想定外の項目 ${k}`);
    assert.doesNotMatch(JSON.stringify(d.data()), /whsec_|sk_(live|test)_|card|"last4"/i, "決済要確認に秘密情報・カード情報が含まれています");
  }
  const openList = await listPaymentReviews({ status: "OPEN" });
  assert.ok(openList.some((r) => r.kind === "legacy_settlement_change") && openList.every((r) => r.status === "OPEN"));
  step("決済要確認：店舗の食い違いは反映せず記録（原因・対象ID・発生日時・回数）。再送で増えず回数だけ。確認済みは同じ内容では戻らず、内容が変われば未確認。記録なし・金額超過・取り違えも記録。署名が不正な通知は記録しない。秘密情報は保存しない");

  // ================= 3. 確定の順番：逆順は確定できない。同時に確定しても二重反映・消失なし。繰越の引き継ぎ =================
  const storeO = await newStore("確定順検証店舗");
  const o1 = await paid(live, liveStripe, storeO.storeCode, Ma);
  const o2 = await paid(live, liveStripe, storeO.storeCode, Ma);
  await paid(live, liveStripe, storeO.storeCode, Mb);
  await paid(live, liveStripe, storeO.storeCode, Mc);
  await paid(live, liveStripe, storeO.storeCode, Mc);
  for (const ym of [Ma, Mb, Mc]) await generateSettlements(ym, SYSTEM);
  await assert.rejects(updateSettlementStatus(`${storeO.id}_${Mc}`, "PAID", "", SYSTEM), new RegExp(`先に${Ma}の精算を確定してください`));
  await assert.rejects(updateSettlementStatus(`${storeO.id}_${Mb}`, "PROCESSING", "", SYSTEM), /先に/);
  assert.equal((await stDoc(storeO.id, Mc))!.status, "UNPAID");
  assert.equal((await txDoc(o1.txId)).settlementId ?? null, null, "確定できなかった精算の取引に支払った額を記録しました");
  await updateSettlementStatus(`${storeO.id}_${Ma}`, "PAID", "", SYSTEM);
  // 振込後の返金2件（-60円）→ Mb（30円）と Mc（60円）を同時に確定：Mc は Mb より先に確定できない
  for (const o of [o1, o2]) {
    await liveStripe.ctl(`refund/${o.charge}`);
    await webhook(live, "charge.refunded", { id: o.charge, object: "charge" });
  }
  const both = await Promise.allSettled([updateSettlementStatus(`${storeO.id}_${Mb}`, "PAID", "", SYSTEM), updateSettlementStatus(`${storeO.id}_${Mc}`, "PAID", "", SYSTEM)]);
  assert.equal(both[0].status, "fulfilled");
  if (both[1].status === "rejected") await updateSettlementStatus(`${storeO.id}_${Mc}`, "PAID", "", SYSTEM);
  const [sb, sc] = [(await stDoc(storeO.id, Mb))!, (await stDoc(storeO.id, Mc))!];
  assert.deepEqual([sb.storeShare, sb.adjustmentTotal, sb.payableAmount, sb.carryOver], [30, -60, 0, -30]);
  assert.deepEqual([sc.storeShare, sc.adjustmentTotal, sc.payableAmount, sc.carryOver], [60, -30, 30, 0]);
  const adjO = (await fsdb().collection(C.settlementAdjustments).where("storeId", "==", storeO.id).get()).docs;
  assert.ok(adjO.every((a) => a.get("status") === "APPLIED"), "反映されずに残った調整があります");
  assert.deepEqual(adjO.map((a) => [a.get("reason"), a.get("appliedSettlementId")]).sort(), [["carryover", `${storeO.id}_${Mc}`], ["refund", `${storeO.id}_${Mb}`], ["refund", `${storeO.id}_${Mb}`]].sort());
  // 振込額の合計 = 今の取り分の合計（返金の2件は0円）
  const payableSum = [Ma, Mb, Mc].reduce(async (p, ym) => (await p) + Number((await stDoc(storeO.id, ym))!.payableAmount), Promise.resolve(0));
  assert.equal(await payableSum, 30 * 3, "振込額の合計が今の取り分の合計と一致しません");
  await checkInvariants(storeO.id);
  step(`確定の順番：新しい月（${Mc}・${Mb}）は古い月（${Ma}）より先に確定できない。同時に確定しても調整は各1回だけ反映（反映先を記録）。繰越 -30円は ${Mc} に引き継ぎ。振込額の合計 90円 = 今の取り分の合計`);

  // ================= 4. 一部の額だけの異議申し立て：過剰に差し引かない =================
  const storeP = await newStore("一部申立検証店舗");
  const p1 = await paid(live, liveStripe, storeP.storeCode, Ma);
  const p2 = await paid(live, liveStripe, storeP.storeCode, Ma);
  const dp1 = await liveStripe.ctl(`dispute/${p1.charge}`, { amount: 40 });
  await webhook(live, "charge.dispute.created", { id: dp1.dispute, object: "dispute" });
  await generateSettlements(Ma, SYSTEM);
  assert.deepEqual([(await stDoc(storeP.id, Ma))!.storeShare, (await stDoc(storeP.id, Ma))!.heldShare], [48, 12], "一部の額の申し立てで取り分を過剰に保留しました");
  await updateSettlementStatus(`${storeP.id}_${Ma}`, "PAID", "", SYSTEM);
  assert.deepEqual([(await txDoc(p1.txId)).settledShare, (await stDoc(storeP.id, Ma))!.payableAmount], [18, 48]);
  // p1：一部敗訴 → 追加の調整なし（確定時に保留済み）。売上は60円分だけ残る（CHARGEBACK ではない）
  await liveStripe.ctl(`dispute-status/${dp1.dispute}`, { status: "lost" });
  assert.equal(outcomeOf(await webhook(live, "charge.dispute.closed", { id: dp1.dispute, object: "dispute" })), "dispute_lost");
  assert.equal((await adjOf(p1.txId)).length, 0);
  assert.deepEqual([(await txDoc(p1.txId)).paymentStatus, (await txDoc(p1.txId)).countable], ["SUCCEEDED", true]);
  // p2：振込後に一部（40円）の申し立て → 保留 -12円 → 勝訴 +12円
  const dp2 = await liveStripe.ctl(`dispute/${p2.charge}`, { amount: 40 });
  await webhook(live, "charge.dispute.created", { id: dp2.dispute, object: "dispute" });
  assert.deepEqual((await adjOf(p2.txId)).map((a) => [a.amount, a.reason]), [[-12, "dispute_hold"]]);
  await liveStripe.ctl(`dispute-status/${dp2.dispute}`, { status: "won" });
  await webhook(live, "charge.dispute.closed", { id: dp2.dispute, object: "dispute" });
  assert.deepEqual((await adjOf(p2.txId)).map((a) => [a.amount, a.reason]).sort(), [[-12, "dispute_hold"], [12, "dispute_won"]].sort());
  assert.deepEqual(await monthTotals(Ma, storeP.id), { count: 2, gross: 160, storeShare: 48, operatorShare: 112, fee: 8 });
  await checkInvariants(storeP.id);
  step("一部の額の異議申し立て：40円の申し立てでは12円だけ保留（店舗報酬48円）。一部敗訴は CHARGEBACK にせず売上60円分を残す。振込後の一部申し立ては -12円 → 勝訴で +12円");

  // ================= 5. 順不同・古い状態の通知：巻き戻らない =================
  const storeQ = await newStore("順不同検証店舗");
  const q1 = await paid(live, liveStripe, storeQ.storeCode, Mc);
  const dq = await liveStripe.ctl(`dispute/${q1.charge}`, { status: "lost" });
  // 先に「結果」の通知、後から古い「発生」の通知（Stripe API は今の状態＝敗訴を返す）
  assert.equal(outcomeOf(await webhook(live, "charge.dispute.closed", { id: dq.dispute, object: "dispute" })), "dispute_lost");
  assert.equal(outcomeOf(await webhook(live, "charge.dispute.created", { id: dq.dispute, object: "dispute" })), "unchanged");
  // Stripe API が古い状態（対応中）を返したとしても、結果が出た申し立ては戻さない（要確認に記録）
  await liveStripe.ctl(`dispute-status/${dq.dispute}`, { status: "needs_response" });
  assert.equal(outcomeOf(await webhook(live, "charge.dispute.updated", { id: dq.dispute, object: "dispute" })), "unchanged");
  assert.deepEqual([(await txDoc(q1.txId)).disputeStatus, (await txDoc(q1.txId)).paymentStatus], ["lost", "CHARGEBACK"]);
  assert.equal((await reviewDoc("dispute_state_regressed", dq.dispute!))?.status, "OPEN");
  // 返金：成功の後に古い「処理中」の通知が届いても、Stripe API の今の状態（成功）で判断する
  const q2 = await paid(live, liveStripe, storeQ.storeCode, Mc);
  const rq = await liveStripe.ctl(`refund/${q2.charge}`, { status: "pending" });
  await liveStripe.ctl(`refund-status/${rq.refund}`, { status: "succeeded" });
  assert.equal(outcomeOf(await webhook(live, "charge.refunded", { id: q2.charge, object: "charge" })), "refunded");
  assert.equal(outcomeOf(await webhook(live, "refund.created", { id: rq.refund, object: "refund", charge: q2.charge })), "unchanged");
  assert.equal((await txDoc(q2.txId)).paymentStatus, "REFUNDED");
  step("順不同・古い通知：結果の後の「発生」の通知は何もしない。API が古い状態を返しても結果が出た申し立ては戻さず要確認。返金も古い「処理中」の通知で巻き戻らない");

  // ================= 6. 精算の確定中に Webhook が届いても金額が矛盾しない =================
  for (let round = 0; round < 3; round++) {
    const storeW = await newStore(`確定中検証店舗${round}`);
    const ws = [];
    for (let i = 0; i < 8; i++) ws.push(await paid(live, liveStripe, storeW.storeCode, Ma));
    await generateSettlements(Ma, SYSTEM);
    for (const w of ws.slice(0, 4)) await liveStripe.ctl(`refund/${w.charge}`);
    const dW = await liveStripe.ctl(`dispute/${ws[4].charge}`);
    await Promise.all([
      updateSettlementStatus(`${storeW.id}_${Ma}`, "PROCESSING", "", SYSTEM),
      ...ws.slice(0, 4).map((w) => webhook(live, "charge.refunded", { id: w.charge, object: "charge" })),
      webhook(live, "charge.dispute.created", { id: dW.dispute, object: "dispute" }),
      syncStripeDispute(dW.dispute!, live),
    ]);
    await checkInvariants(storeW.id);
    // 確定の前後どちらで反映されても、最終的に店舗に支払う額は同じ（返金4件・保留1件を除いた3件＝90円）
    const sW = (await stDoc(storeW.id, Ma))!;
    const openW = (await fsdb().collection(C.settlementAdjustments).where("storeId", "==", storeW.id).where("status", "==", "OPEN").get()).docs.reduce((a, d) => a + Number(d.get("amount")), 0);
    assert.equal(Number(sW.payableAmount) + openW, 90, `確定中の通知で金額が矛盾しました（振込額 ${sW.payableAmount}・未反映 ${openW}）`);
    assert.equal(heldStoreShare(txFacts(await txDoc(ws[4].txId))), 30);
  }
  step("確定中の Webhook：確定と返金4件・異議申し立てが同時でも（3回）、振込額＋未反映の調整 = 90円。支払った額＋調整 = 今の取り分");

  // ================= 7. 大量の取引・調整（トランザクションの上限） =================
  const storeV = await newStore("大量検証店舗");
  const N = 600;
  const paidAt = new Date(`${Ma}-15T12:00:00+09:00`);
  const run = Date.now().toString(36);
  for (let i = 0; i < N; i += 400) {
    const batch = fsdb().batch();
    for (let j = i; j < Math.min(N, i + 400); j++) {
      const pi = `pi_bulk_${run}_${j}`;
      batch.set(fsdb().collection(C.transactions).doc(`stripe_${pi}`), {
        checkoutId: `bulk-${run}-${j}`,
        paymentProvider: "stripe",
        providerPaymentId: pi,
        stripeChargeId: `ch_bulk_${run}_${j}`,
        storeId: storeV.id,
        fortuneType: "ZODIAC",
        amount: 100,
        storeShare: 30,
        operatorShare: 70,
        paymentFee: 4,
        storeShareBps: 3000,
        paymentStatus: "SUCCEEDED",
        fortuneStatus: "COMPLETED",
        livemode: true,
        paidAt,
        ...salesKeys(storeV.id, "stripe", "SUCCEEDED", paidAt, true),
        createdAt: FieldValue.serverTimestamp(),
      });
    }
    await batch.commit();
  }
  await generateSettlements(Ma, SYSTEM);
  assert.equal((await stDoc(storeV.id, Ma))!.storeShare, N * 30);
  const t0 = Date.now();
  await updateSettlementStatus(`${storeV.id}_${Ma}`, "PAID", "", SYSTEM);
  const lockMs = Date.now() - t0;
  assert.deepEqual([(await stDoc(storeV.id, Ma))!.storeShare, (await stDoc(storeV.id, Ma))!.payableAmount], [N * 30, N * 30]);
  assert.equal((await fsdb().collection(C.transactions).where("settlementId", "==", `${storeV.id}_${Ma}`).count().get()).data().count, N);
  await checkInvariants(storeV.id);
  // 未反映の調整が上限（400件）を超える：上限までを反映し、残りは次回へ（消えない・二重にならない）
  const storeX = await newStore("調整上限検証店舗");
  for (let i = 0; i < 450; i += 400) {
    const batch = fsdb().batch();
    for (let j = i; j < Math.min(450, i + 400); j++) {
      batch.set(fsdb().collection(C.settlementAdjustments).doc(`bulkadj_${run}_${j}`), { storeId: storeX.id, transactionId: null, paymentProvider: null, providerPaymentId: null, stripeChargeId: null, yearMonth: Ma, amount: -1, reason: "refund", status: "OPEN", sourceSettlementId: null, appliedSettlementId: null, appliedAt: null, livemode: true, detail: "上限の検証", createdAt: new Date(Date.now() - (450 - j) * 1000) });
    }
    await batch.commit();
  }
  await paid(live, liveStripe, storeX.storeCode, Mb);
  await generateSettlements(Mb, SYSTEM);
  await updateSettlementStatus(`${storeX.id}_${Mb}`, "PAID", "", SYSTEM);
  let sx = (await stDoc(storeX.id, Mb))!;
  assert.deepEqual([sx.adjustmentTotal, sx.payableAmount, sx.carryOver, (sx.appliedAdjustmentIds as string[]).length], [-400, 0, -370, 400]);
  await paid(live, liveStripe, storeX.storeCode, Mc);
  await generateSettlements(Mc, SYSTEM);
  await updateSettlementStatus(`${storeX.id}_${Mc}`, "PAID", "", SYSTEM);
  sx = (await stDoc(storeX.id, Mc))!;
  assert.deepEqual([sx.adjustmentTotal, sx.payableAmount, sx.carryOver], [-50 - 370, 0, -390]);
  const openX = (await fsdb().collection(C.settlementAdjustments).where("storeId", "==", storeX.id).where("status", "==", "OPEN").get()).docs;
  assert.deepEqual(openX.map((d) => [d.get("reason"), d.get("amount")]), [["carryover", -390]]);
  await checkInvariants(storeX.id);
  step(`大量：${N}件の取引の月を確定（${lockMs}ms）・支払った額の記録 ${N}件・合計一致。未反映の調整450件は400件まで反映し、残り50件は次回へ（繰越 -390円まで一致）`);

  console.log("\nSTRIPE SETTLEMENT SAFETY E2E PASSED");
}

main()
  .then(async () => {
    await Promise.all([liveStripe.stop(), testStripe.stop()]);
    process.exit(0);
  })
  .catch(async (e) => {
    console.error("\nSTRIPE SETTLEMENT SAFETY E2E FAILED:", e);
    await Promise.all([liveStripe.stop(), testStripe.stop()]).catch(() => undefined);
    process.exit(1);
  });
