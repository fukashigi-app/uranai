/**
 * Stripe の決済・返金・異議申し立ての通知の順序・同時実行・再送と、運営による権利の復旧の総合の E2E 検証。
 * 各操作の後に、次の不変条件をまとめて確かめる（checkPayment・checkStoreMonth）：
 *  - 決済記録・占い権利は同じ決済につき1件
 *  - 返金の処理中・全額の返金・チャージバックの敗訴で、未使用の権利が有効（PAID）にならない（一部の返金は運営が理由付きで戻したときだけ）
 *  - 返金・チャージバックで権利を止めたら注文も REFUNDED。REFUNDED から SUCCEEDED に戻るのは運営の復旧の操作だけ
 *  - 監査ログは復旧の成功1回につき1件
 *  - 手数料は決済記録ごとに1回だけ集計。Sandbox（テスト決済）は本番の集計から除く。店舗の精算額は今までの規則のまま
 * 本物の Stripe・本番の Firebase には一切接続しない（localhost の模擬 Stripe と Firestore Emulator の demo- プロジェクトだけ。キーは形だけの偽物）。
 *
 *   firebase emulators:start --only firestore --project demo-uranai
 *   （別ターミナル）FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 FIREBASE_PROJECT_ID=demo-uranai-ordering DB_PROVIDER=firestore npm run e2e:stripe-ordering
 */
import "dotenv/config";
import assert from "node:assert/strict";
import Stripe from "stripe";
import { createFakeStripe } from "./lib/fake-stripe";
import { C, fsdb } from "@/lib/firestore/admin";
import { dataProvider } from "@/lib/data-provider";
import { createStore } from "@/lib/services/stores";
import { monthTotals } from "@/lib/services/reports";
import { generateSettlements, listSettlements } from "@/lib/services/settlements";
import { txFacts } from "@/lib/firestore/settlement-adjustments";
import { entitledStoreShare, heldStoreShare } from "@/lib/payments/settlement-rules";
import { createCheckout } from "@/lib/firestore/payments";
import { jstYearMonth, shiftYearMonth } from "@/lib/time";
import { createSimulatedStripeRuntime, STRIPE_SESSION_TTL_MS, type StripeRuntime } from "@/lib/payments/stripe-checkout";
import { confirmStripeCheckout, dismissStripeRefundReview, restoreStripeEntitlement, startStripeCheckout } from "@/lib/payments/stripe-confirm";
import { handleStripeWebhook } from "@/lib/payments/stripe-webhook";

const SYSTEM = { userId: null, role: "SYSTEM" as const };
const OP1 = { userId: "op-ordering-1", role: "OPERATOR" as const };
const OP2 = { userId: "op-ordering-2", role: "OPERATOR" as const };
const step = (msg: string) => console.log(`  ✓ ${msg}`);
const ORIGIN = "http://localhost:3000";

const LIVE_PORT = 12121;
const TEST_PORT = 12122;
const LIVE_KEY = "sk_live_e2e_ordering_dummy";
const TEST_KEY = "sk_test_e2e_ordering_dummy";
const liveStripe = createFakeStripe({ port: LIVE_PORT, mode: "live", apiKey: LIVE_KEY });
const testStripe = createFakeStripe({ port: TEST_PORT, mode: "test", apiKey: TEST_KEY });

const signer = new Stripe("sk_test_signer");
let evN = 0;
type Ev = { type: string; object: Record<string, unknown>; id: string };
const ev = (type: string, object: Record<string, unknown>): Ev => ({ type, object, id: `evt_ord_${++evN}_${Date.now()}` });
async function deliver(rt: StripeRuntime, e: Ev) {
  const payload = JSON.stringify({ id: e.id, object: "event", type: e.type, livemode: rt.mode === "live", data: { object: e.object } });
  const sig = signer.webhooks.generateTestHeaderString({ payload, secret: rt.webhookSecret });
  return handleStripeWebhook(payload, sig, rt);
}
const outcomeOf = (r: { body: unknown }) => (r.body as { outcome?: string }).outcome;

type Pay = { checkoutId: string; sessionId: string; charge: string; pi: string; rt: StripeRuntime; stripe: ReturnType<typeof createFakeStripe>; restores: number; wasRefunded: boolean; label: string };

/** 支払いまで（決済確定はしない。通知の順序をテストごとに決める）。決済日時は指定した月の15日 */
async function paidOnly(rt: StripeRuntime, stripe: ReturnType<typeof createFakeStripe>, storeCode: string, ym: string, label: string): Promise<Pay> {
  const { checkoutId, accessToken } = await createCheckout(storeCode, "ZODIAC", { provider: "stripe", ttlMs: STRIPE_SESSION_TTL_MS });
  const r = await startStripeCheckout(accessToken, ORIGIN, rt);
  assert.equal(r.status, "redirect");
  const sessionId = (r as { url: string }).url.split("/").pop()!;
  const created = Math.floor(new Date(`${ym}-15T12:00:00+09:00`).getTime() / 1000);
  const p = await stripe.ctl(`pay/${sessionId}`, { created, fee: 4 });
  return { checkoutId, sessionId, charge: p.charge!, pi: p.paymentIntent!, rt, stripe, restores: 0, wasRefunded: false, label };
}
const completedEv = (p: Pay) => ev("checkout.session.completed", { id: p.sessionId, object: "checkout.session" });
const refundEv = (p: Pay) => ev("charge.refunded", { id: p.charge, object: "charge" });
const disputeEv = (dpId: string) => ev("charge.dispute.created", { id: dpId, object: "dispute" });

const txsOf = async (checkoutId: string) => (await fsdb().collection(C.transactions).where("checkoutId", "==", checkoutId).get()).docs;
async function stateOf(p: Pay) {
  const [t] = await txsOf(p.checkoutId);
  const fs = t ? await fsdb().collection(C.fortuneSessions).doc(t.id).get() : null;
  const co = (await fsdb().collection(C.checkouts).doc(p.checkoutId).get()).data()!;
  return { t, fs, co };
}

/** 1件の決済の不変条件（各操作の後に呼ぶ） */
async function checkPayment(p: Pay, when: string) {
  const at = `${p.label}／${when}`;
  const txs = await txsOf(p.checkoutId);
  assert.ok(txs.length <= 1, `${at}: 決済記録が${txs.length}件`);
  const co = (await fsdb().collection(C.checkouts).doc(p.checkoutId).get()).data()!;
  if (txs.length === 0) {
    assert.ok(!["SUCCEEDED", "REFUNDED"].includes(co.status), `${at}: 決済記録が無いのに注文が ${co.status}`);
    return;
  }
  const t = txs[0];
  const sessions = await fsdb().collection(C.fortuneSessions).where("transactionId", "==", t.id).get();
  assert.equal(sessions.size, 1, `${at}: 占い権利が${sessions.size}件`);
  const fs = sessions.docs[0];
  const refundStatus = t.get("refundStatus");
  const lost = t.get("disputeStatus") === "lost";
  if (fs.get("status") === "PAID") {
    assert.equal(t.get("paymentStatus"), "SUCCEEDED", `${at}: ${t.get("paymentStatus")} の決済の権利が有効`);
    assert.ok(!lost, `${at}: 敗訴した決済の権利が有効`);
    assert.ok(refundStatus !== "pending" && refundStatus !== "succeeded", `${at}: 返金（${refundStatus}）の権利が有効`);
    if (refundStatus === "partial") assert.ok(fs.get("restoredAt"), `${at}: 一部の返金の権利が、運営の復旧なしに有効`);
    assert.equal(co.status, "SUCCEEDED", `${at}: 権利が有効なのに注文が ${co.status}`);
  }
  if (fs.get("status") === "EXPIRED" && (fs.get("suspendedByRefund") === true || fs.get("suspendedByDispute") === true)) {
    assert.equal(co.status, "REFUNDED", `${at}: 権利を止めたのに注文が ${co.status}`);
  }
  if (co.status === "REFUNDED") {
    assert.notEqual(fs.get("status"), "PAID", `${at}: REFUNDED の注文の権利が有効`);
    assert.ok(["refund", "chargeback"].includes(co.refundReason), `${at}: REFUNDED の理由 ${co.refundReason}`);
    if (lost) assert.equal(co.refundReason, "chargeback", `${at}: 敗訴なのに理由が ${co.refundReason}`);
    p.wasRefunded = true;
  }
  // REFUNDED から SUCCEEDED に戻るのは、運営の復旧の操作だけ
  if (co.status === "SUCCEEDED" && p.wasRefunded) assert.ok(p.restores > 0, `${at}: 復旧の操作なしに REFUNDED から SUCCEEDED に戻りました`);
  const audits = await fsdb().collection(C.auditLogs).where("targetId", "==", t.id).where("action", "==", "stripe_test.entitlement_restored").get();
  assert.equal(audits.size, p.restores, `${at}: 復旧の監査ログが${audits.size}件（復旧の成功は${p.restores}回）`);
  // 売上・手数料の集計のキー
  const live = t.get("livemode") === true;
  assert.equal(t.get("countable"), live && t.get("paymentStatus") === "SUCCEEDED", `${at}: 売上の対象の判定`);
  assert.equal(t.get("feeCountable"), live, `${at}: 手数料の集計の対象の判定`);
}

/** 店舗・月の集計と精算の不変条件（決済記録から独立に計算した値と一致） */
async function checkStoreMonth(storeId: string, ym: string, when: string) {
  const docs = (await fsdb().collection(C.transactions).where("storeYm", "==", `${storeId}_${ym}`).get()).docs;
  const live = docs.filter((d) => d.get("paymentProvider") === "stripe" && d.get("livemode") === true);
  const sales = live.filter((d) => d.get("paymentStatus") === "SUCCEEDED");
  const t = await monthTotals(ym, storeId);
  assert.equal(t.count, sales.length, `${when}: 売上の件数`);
  assert.equal(t.fee, live.reduce((a, d) => a + Number(d.get("paymentFee")), 0), `${when}: 手数料が決済記録ごとに1回ではありません`);
  assert.equal(t.feeEstimated, live.filter((d) => d.get("feeEstimated") === true).reduce((a, d) => a + Number(d.get("paymentFee")), 0), `${when}: 推定手数料`);
  await generateSettlements(ym, SYSTEM);
  const [s] = (await listSettlements({ storeId, yearMonth: ym })).map((x) => x.s);
  assert.equal(s.storeShare, sales.reduce((a, d) => a + entitledStoreShare(txFacts(d.data())), 0), `${when}: 店舗の精算額`);
  assert.equal(s.heldShare, sales.reduce((a, d) => a + heldStoreShare(txFacts(d.data())), 0), `${when}: 精算の保留`);
  return { totals: t, settlement: s };
}

function permutations<T>(xs: T[]): T[][] {
  if (xs.length <= 1) return [xs];
  return xs.flatMap((x, i) => permutations([...xs.slice(0, i), ...xs.slice(i + 1)]).map((r) => [x, ...r]));
}

async function main() {
  const host = process.env.FIRESTORE_EMULATOR_HOST ?? "";
  assert.match(host, /^(127\.0\.0\.1|localhost|\[::1\]):\d+$/, "FIRESTORE_EMULATOR_HOST（localhost の Emulator）が必要です");
  assert.match(process.env.FIREBASE_PROJECT_ID ?? "", /^demo-/, "FIREBASE_PROJECT_ID は demo- で始まる Emulator 用の ID にしてください");
  assert.equal(dataProvider(), "firestore");
  for (const k of ["STRIPE_SECRET_KEY", "STRIPE_LIVE_CHECKOUT", "STRIPE_LIVE_OPERATOR_TEST", "VERCEL_ENV"]) delete process.env[k];
  await liveStripe.start();
  await testStripe.start();
  const live = createSimulatedStripeRuntime("live", { apiBase: `http://127.0.0.1:${LIVE_PORT}`, secretKey: LIVE_KEY, webhookSecret: "whsec_e2e_ordering_live_dummy" });
  const test = createSimulatedStripeRuntime("test", { apiBase: `http://127.0.0.1:${TEST_PORT}`, secretKey: TEST_KEY, webhookSecret: "whsec_e2e_ordering_test_dummy" });
  console.log(`Stripe ordering/concurrency E2E (emulator ${host} / ${process.env.FIREBASE_PROJECT_ID}, fake Stripe live :${LIVE_PORT} / test :${TEST_PORT})`);

  const stamp = Date.now();
  const Mo = shiftYearMonth(jstYearMonth(new Date()), -7); // 精算を作れる過去の月
  const storeO = await createStore({ name: `順序検証店舗 ${stamp}`, contactName: "", postalCode: "", address: "", phone: "", email: "" }, SYSTEM);
  const toDismiss: string[] = [];

  // ================= 1. 通知の到着順序（すべての並び）・同時・同じ通知の重複 =================
  // Stripe の状態を先に作り、checkout.session.completed・返金・異議申し立ての通知をすべての順序で届ける。
  // 決済確定より先に届いた返金・異議申し立ての通知は記録が無いので反映されないが、確定のときに Stripe の今の状態を読むので、最後は同じ状態になる
  type Final = { paymentStatus: string; fortune: "PAID" | "EXPIRED"; checkout: "SUCCEEDED" | "REFUNDED"; reason: string | null };
  const states: { name: string; setup: (p: Pay) => Promise<string | null>; want: Final }[] = [
    { name: "返金（成功）", setup: async (p) => (await liveStripe.ctl(`refund/${p.charge}`), null), want: { paymentStatus: "REFUNDED", fortune: "EXPIRED", checkout: "REFUNDED", reason: "refund" } },
    { name: "返金（処理中）", setup: async (p) => (await liveStripe.ctl(`refund/${p.charge}`, { status: "pending" }), null), want: { paymentStatus: "SUCCEEDED", fortune: "EXPIRED", checkout: "REFUNDED", reason: "refund" } },
    { name: "一部の返金", setup: async (p) => (await liveStripe.ctl(`refund/${p.charge}`, { amount: 30 }), null), want: { paymentStatus: "SUCCEEDED", fortune: "EXPIRED", checkout: "REFUNDED", reason: "refund" } },
    { name: "異議申し立て（対応中）", setup: async (p) => (await liveStripe.ctl(`dispute/${p.charge}`)).dispute!, want: { paymentStatus: "SUCCEEDED", fortune: "PAID", checkout: "SUCCEEDED", reason: null } },
    { name: "異議申し立て（敗訴）", setup: async (p) => (await liveStripe.ctl(`dispute/${p.charge}`, { status: "lost" })).dispute!, want: { paymentStatus: "CHARGEBACK", fortune: "EXPIRED", checkout: "REFUNDED", reason: "chargeback" } },
    {
      name: "一部の返金＋残りの敗訴",
      setup: async (p) => {
        await liveStripe.ctl(`refund/${p.charge}`, { amount: 30 });
        return (await liveStripe.ctl(`dispute/${p.charge}`, { amount: 70, status: "lost" })).dispute!;
      },
      want: { paymentStatus: "CHARGEBACK", fortune: "EXPIRED", checkout: "REFUNDED", reason: "chargeback" },
    },
  ];
  let combos = 0;
  for (const st of states) {
    const probe = { setupNeedsDispute: st.name.includes("異議申し立て") || st.name.includes("敗訴") };
    const kinds = probe.setupNeedsDispute ? (st.name.includes("返金") ? ["completed", "refund", "dispute"] : ["completed", "dispute"]) : ["completed", "refund"];
    const orders = [...permutations(kinds).map((o) => ({ name: o.join("→"), order: o, concurrent: false })), { name: "すべて同時", order: kinds, concurrent: true }];
    for (const o of orders) {
      const p = await paidOnly(live, liveStripe, storeO.storeCode, Mo, `${st.name}・${o.name}`);
      const dpId = await st.setup(p);
      const evs = o.order.map((k) => (k === "completed" ? completedEv(p) : k === "refund" ? refundEv(p) : disputeEv(dpId!)));
      if (o.concurrent) await Promise.all(evs.map((e) => deliver(live, e)));
      else for (const e of evs) {
        await deliver(live, e);
        await checkPayment(p, `通知 ${e.type} の後`);
      }
      // 同じ通知の重複（同じイベント ID）と、同じ状態の別の通知（別のイベント ID）
      for (const e of evs) assert.deepEqual((await deliver(live, e)).body, { received: true, duplicate: true }, `${p.label}: 同じ通知の重複が処理されました`);
      await Promise.all(o.order.map((k) => deliver(live, k === "completed" ? completedEv(p) : k === "refund" ? refundEv(p) : disputeEv(dpId!))));
      await checkPayment(p, "すべての通知・重複・同じ状態の別の通知の後");
      const s = await stateOf(p);
      assert.deepEqual(
        { paymentStatus: s.t.get("paymentStatus"), fortune: s.fs!.get("status"), checkout: s.co.status, reason: s.co.refundReason ?? null },
        st.want,
        `${p.label}: 最後の状態が Stripe の状態と一致しません`,
      );
      if (s.t.get("refundNeedsReview") === true) toDismiss.push(s.t.id);
      combos++;
    }
  }
  await checkStoreMonth(storeO.id, Mo, "通知の順序の検証の後");
  step(`通知の到着順序：6種類の Stripe の状態 × すべての並び＋すべて同時（${combos}通り）。確定より先の返金・異議申し立ての通知があっても、最後は Stripe の状態どおり。同じ通知の重複は処理せず、同じ状態の別の通知でも変わらない。各通知の後に不変条件を確認`);

  // ================= 2. 決済確定の途中の返金・異議申し立て（確定と通知が同時） =================
  for (const kind of ["refund", "dispute_lost"] as const) {
    const p = await paidOnly(live, liveStripe, storeO.storeCode, Mo, `確定の途中の${kind}`);
    let dpId: string | null = null;
    // 確定が返金の一覧を読んだ直後に、Stripe で返金・敗訴が発生し、その通知が確定と同時に届く
    liveStripe.fake.afterRefundListOnce.set(p.charge, () => {
      if (kind === "refund") liveStripe.addRefund(p.charge);
      else dpId = liveStripe.addDispute(p.charge, { status: "lost" });
    });
    const conf = completedEv(p);
    await deliver(live, conf);
    await Promise.all([kind === "refund" ? deliver(live, refundEv(p)) : deliver(live, disputeEv(dpId!)), deliver(live, completedEv(p)), confirmStripeCheckout(p.sessionId, live)]);
    await checkPayment(p, "確定の途中の変化の後");
    const s = await stateOf(p);
    assert.deepEqual([s.fs!.get("status"), s.co.status, s.co.refundReason], ["EXPIRED", "REFUNDED", kind === "refund" ? "refund" : "chargeback"]);
  }
  step("決済確定の途中の返金・敗訴：確定・同じ確定の通知・返金や異議申し立ての通知が同時でも、権利は止まり注文は REFUNDED（不変条件を確認）");

  // ================= 3. 状態の遷移（通知の順番の入れ替わり・古い通知・重複） =================
  // 3a. 返金：処理中 → 成功（通知は同時・古い通知の再送を含む）
  let p = await paidOnly(live, liveStripe, storeO.storeCode, Mo, "処理中→成功");
  await deliver(live, completedEv(p));
  const rA = await liveStripe.ctl(`refund/${p.charge}`, { status: "pending" });
  const created3a = ev("refund.created", { id: rA.refund, object: "refund", charge: p.charge });
  await deliver(live, created3a);
  await checkPayment(p, "返金の処理中");
  liveStripe.setRefundStatus(rA.refund!, "succeeded");
  await Promise.all([deliver(live, ev("refund.updated", { id: rA.refund, object: "refund", charge: p.charge })), deliver(live, refundEv(p)), deliver(live, created3a), deliver(live, ev("refund.created", { id: rA.refund, object: "refund", charge: p.charge }))]);
  await checkPayment(p, "返金の成功");
  assert.deepEqual([(await stateOf(p)).t.get("paymentStatus"), (await stateOf(p)).co.status], ["REFUNDED", "REFUNDED"]);

  // 3b. 返金：処理中 → 失敗（自動では戻さない）→ 運営が理由付きで復旧 → 古い通知・同じ状態の通知では変わらない → 新しい返金で再び停止（監査ログは1件のまま）
  p = await paidOnly(live, liveStripe, storeO.storeCode, Mo, "処理中→失敗→復旧→新しい返金");
  await deliver(live, completedEv(p));
  const rB = await liveStripe.ctl(`refund/${p.charge}`, { status: "pending" });
  const created3b = ev("refund.created", { id: rB.refund, object: "refund", charge: p.charge });
  await deliver(live, created3b);
  liveStripe.setRefundStatus(rB.refund!, "failed");
  await deliver(live, ev("refund.failed", { id: rB.refund, object: "refund", charge: p.charge }));
  await checkPayment(p, "返金の失敗（自動では戻さない）");
  assert.deepEqual([(await stateOf(p)).fs!.get("status"), (await stateOf(p)).co.status], ["EXPIRED", "REFUNDED"]);
  let txId = (await stateOf(p)).t.id;
  assert.equal(await restoreStripeEntitlement(txId, OP1, "返金の失敗のため戻す", live), "restored");
  p.restores++;
  await checkPayment(p, "運営の復旧");
  assert.deepEqual((await deliver(live, created3b)).body, { received: true, duplicate: true });
  assert.equal(outcomeOf(await deliver(live, ev("refund.updated", { id: rB.refund, object: "refund", charge: p.charge }))), "unchanged");
  await checkPayment(p, "復旧の後の古い通知・同じ状態の通知");
  assert.equal((await stateOf(p)).fs!.get("status"), "PAID");
  await liveStripe.ctl(`refund/${p.charge}`); // 新しい返金（成功）
  await deliver(live, refundEv(p));
  await checkPayment(p, "復旧の後の新しい返金");
  assert.deepEqual([(await stateOf(p)).fs!.get("status"), (await stateOf(p)).co.status], ["EXPIRED", "REFUNDED"]);

  // 3c. 異議申し立て：対応中 → 審査中 → 勝訴（通知の順番が入れ替わっても、古い対応中の状態に戻らない）
  p = await paidOnly(live, liveStripe, storeO.storeCode, Mo, "対応中→勝訴");
  await deliver(live, completedEv(p));
  const dC = (await liveStripe.ctl(`dispute/${p.charge}`)).dispute!;
  const createdC = disputeEv(dC);
  await deliver(live, createdC);
  await checkPayment(p, "異議申し立ての対応中");
  await liveStripe.ctl(`dispute-status/${dC}`, { status: "won" });
  await Promise.all([deliver(live, ev("charge.dispute.closed", { id: dC, object: "dispute" })), deliver(live, ev("charge.dispute.funds_reinstated", { id: dC, object: "dispute" })), deliver(live, ev("charge.dispute.updated", { id: dC, object: "dispute" }))]);
  await deliver(live, createdC); // 古い通知の再送
  await checkPayment(p, "異議申し立ての勝訴");
  assert.deepEqual([(await stateOf(p)).t.get("disputeStatus"), (await stateOf(p)).fs!.get("status"), (await stateOf(p)).co.status], ["won", "PAID", "SUCCEEDED"]);

  // 3d. 異議申し立て：対応中 → 敗訴（同時の通知）
  p = await paidOnly(live, liveStripe, storeO.storeCode, Mo, "対応中→敗訴");
  await deliver(live, completedEv(p));
  const dD = (await liveStripe.ctl(`dispute/${p.charge}`)).dispute!;
  await deliver(live, disputeEv(dD));
  await liveStripe.ctl(`dispute-status/${dD}`, { status: "lost" });
  await Promise.all([deliver(live, ev("charge.dispute.closed", { id: dD, object: "dispute" })), deliver(live, ev("charge.dispute.funds_withdrawn", { id: dD, object: "dispute" }))]);
  await checkPayment(p, "異議申し立ての敗訴");
  assert.deepEqual([(await stateOf(p)).t.get("paymentStatus"), (await stateOf(p)).fs!.get("status"), (await stateOf(p)).co.status, (await stateOf(p)).co.refundReason], ["CHARGEBACK", "EXPIRED", "REFUNDED", "chargeback"]);

  // 3e. 一部の返金 → 運営が理由付きで復旧 → 残りの返金（処理中）で再び停止
  p = await paidOnly(live, liveStripe, storeO.storeCode, Mo, "一部の返金→復旧→残りの返金");
  await deliver(live, completedEv(p));
  await liveStripe.ctl(`refund/${p.charge}`, { amount: 30 });
  await deliver(live, refundEv(p));
  await checkPayment(p, "一部の返金");
  txId = (await stateOf(p)).t.id;
  assert.equal(await restoreStripeEntitlement(txId, OP1, "", live), "reason_required");
  assert.equal(await restoreStripeEntitlement(txId, OP1, "残りの代金で提供する", live), "restored");
  p.restores++;
  await checkPayment(p, "一部の返金の後の復旧");
  await liveStripe.ctl(`refund/${p.charge}`, { amount: 70, status: "pending" });
  await deliver(live, refundEv(p));
  await checkPayment(p, "残りの返金（処理中）");
  assert.deepEqual([(await stateOf(p)).fs!.get("status"), (await stateOf(p)).co.status], ["EXPIRED", "REFUNDED"]);
  await checkStoreMonth(storeO.id, Mo, "状態の遷移の後");
  step("状態の遷移：返金の処理中→成功、処理中→失敗（自動では戻さない）→運営の復旧→古い通知・同じ状態の通知では変わらない→新しい返金で再び停止、異議申し立ての対応中→勝訴・敗訴、一部の返金→復旧→残りの返金で再び停止。監査ログは復旧1回につき1件");

  // ================= 4. 運営の復旧と Webhook の競合 =================
  const failedRefund = async (label: string) => {
    const q = await paidOnly(live, liveStripe, storeO.storeCode, Mo, label);
    await deliver(live, completedEv(q));
    const r = await liveStripe.ctl(`refund/${q.charge}`, { status: "pending" });
    await deliver(live, ev("refund.created", { id: r.refund, object: "refund", charge: q.charge }));
    liveStripe.setRefundStatus(r.refund!, "failed");
    await deliver(live, ev("refund.failed", { id: r.refund, object: "refund", charge: q.charge }));
    return { q, refundId: r.refund!, txId: (await stateOf(q)).t.id };
  };
  // 4a. 復旧と同時に新しい返金（処理中）とその通知：戻さない
  let f = await failedRefund("復旧と新しい返金の通知が同時");
  await liveStripe.ctl(`refund/${f.q.charge}`, { status: "pending" });
  const [r4a] = await Promise.all([restoreStripeEntitlement(f.txId, OP1, "同時の返金", live), deliver(live, refundEv(f.q))]);
  assert.ok(["refund_pending", "state_changed"].includes(r4a), `新しい返金と同時なのに ${r4a}`);
  await checkPayment(f.q, "復旧と新しい返金の同時");
  assert.notEqual((await stateOf(f.q)).fs!.get("status"), "PAID");
  toDismiss.push(f.txId);
  // 4b. 復旧と同時に敗訴の異議申し立てとその通知：戻さない（注文は chargeback）
  f = await failedRefund("復旧と敗訴の通知が同時");
  const d4b = (await liveStripe.ctl(`dispute/${f.q.charge}`, { status: "lost" })).dispute!;
  const [r4b] = await Promise.all([restoreStripeEntitlement(f.txId, OP1, "同時の敗訴", live), deliver(live, disputeEv(d4b))]);
  // 全額の敗訴は決済が CHARGEBACK になるので、先に payment_not_succeeded で止まる（どれでも戻さない）
  assert.ok(["payment_not_succeeded", "dispute_lost", "state_changed"].includes(r4b), `敗訴と同時なのに ${r4b}`);
  await checkPayment(f.q, "復旧と敗訴の同時");
  assert.deepEqual([(await stateOf(f.q)).fs!.get("status"), (await stateOf(f.q)).co.refundReason], ["EXPIRED", "chargeback"]);
  toDismiss.push(f.txId);
  // 4c. 運営2人の復旧と、同じ状態の通知（別のイベント ID）が同時：成功は1回・監査ログ1件
  f = await failedRefund("運営2人の復旧と同じ状態の通知が同時");
  const r4c = await Promise.all([
    restoreStripeEntitlement(f.txId, OP1, "運営1", live),
    restoreStripeEntitlement(f.txId, OP2, "運営2", live),
    deliver(live, ev("refund.updated", { id: f.refundId, object: "refund", charge: f.q.charge })),
    deliver(live, refundEv(f.q)),
  ]);
  const restores4c = r4c.slice(0, 2).filter((x) => x === "restored").length;
  assert.equal(restores4c, 1, `同時の復旧の成功が${restores4c}回: ${r4c.slice(0, 2)}`);
  f.q.restores = restores4c;
  await checkPayment(f.q, "運営2人の同時の復旧");
  assert.deepEqual([(await stateOf(f.q)).fs!.get("status"), (await stateOf(f.q)).co.status], ["PAID", "SUCCEEDED"]);
  await checkStoreMonth(storeO.id, Mo, "復旧と Webhook の競合の後");
  step("運営の復旧と Webhook の競合：新しい返金・敗訴の通知と同時なら戻さない（注文は REFUNDED のまま・敗訴は chargeback）。運営2人の復旧と同じ状態の通知が同時でも成功1回・監査ログ1件");

  // ================= 5. API の一時的な失敗からの再試行（同じイベント ID の再送で回復・二重にしない） =================
  // 5a. 決済確定：異議申し立ての一覧の取得の失敗で 500（記録しない）→ 同じイベントの再送で確定
  p = await paidOnly(live, liveStripe, storeO.storeCode, Mo, "確定の一時的な失敗");
  const conf5 = completedEv(p);
  liveStripe.fake.failPaths = [/^\/v1\/disputes$/];
  assert.equal((await deliver(live, conf5)).status, 500);
  await checkPayment(p, "確定の失敗");
  assert.equal((await txsOf(p.checkoutId)).length, 0);
  liveStripe.fake.failPaths = [];
  assert.equal(outcomeOf(await deliver(live, conf5)), "confirmed");
  assert.deepEqual((await deliver(live, conf5)).body, { received: true, duplicate: true });
  await checkPayment(p, "確定の再試行");
  // 5b. 返金の反映：返金の一覧の取得の失敗で 500（反映しない・処理済みにしない）→ 同じイベントの再送で反映
  await liveStripe.ctl(`refund/${p.charge}`);
  const ref5 = refundEv(p);
  liveStripe.fake.failPaths = [/^\/v1\/refunds$/];
  assert.equal((await deliver(live, ref5)).status, 500);
  await checkPayment(p, "返金の反映の失敗");
  assert.equal((await stateOf(p)).fs!.get("status"), "PAID"); // まだ反映されていない（再送で反映される）
  liveStripe.fake.failPaths = [];
  const [w5a, w5b] = await Promise.all([deliver(live, ref5), deliver(live, ref5)]); // 再送と、その重複が同時
  assert.deepEqual([outcomeOf(w5a), outcomeOf(w5b)].filter(Boolean).sort().slice(0, 1), ["refunded"]);
  await checkPayment(p, "返金の反映の再試行");
  assert.deepEqual([(await stateOf(p)).t.get("paymentStatus"), (await stateOf(p)).co.status], ["REFUNDED", "REFUNDED"]);
  // 5c. 異議申し立ての反映：Charge の取得の失敗で 500 → 再送で反映
  p = await paidOnly(live, liveStripe, storeO.storeCode, Mo, "異議申し立ての反映の一時的な失敗");
  await deliver(live, completedEv(p));
  const d5 = (await liveStripe.ctl(`dispute/${p.charge}`, { status: "lost" })).dispute!;
  const dev5 = disputeEv(d5);
  liveStripe.fake.failPaths = [/^\/v1\/charges\//];
  assert.equal((await deliver(live, dev5)).status, 500);
  liveStripe.fake.failPaths = [];
  assert.equal(outcomeOf(await deliver(live, dev5)), "dispute_lost");
  await checkPayment(p, "異議申し立ての反映の再試行");
  // 5d. 運営の復旧：Stripe の取得の失敗では戻さない → 回復後に戻す（監査ログ1件）
  f = await failedRefund("復旧の一時的な失敗");
  liveStripe.fake.failPaths = [/^\/v1\/payment_intents\//];
  assert.equal(await restoreStripeEntitlement(f.txId, OP1, "障害中", live), "stripe_unavailable");
  await checkPayment(f.q, "復旧の失敗");
  liveStripe.fake.failPaths = [];
  assert.equal(await restoreStripeEntitlement(f.txId, OP1, "回復の後", live), "restored");
  f.q.restores++;
  await checkPayment(f.q, "復旧の再試行");
  const after5 = await checkStoreMonth(storeO.id, Mo, "API の一時的な失敗の後");
  step("API の一時的な失敗：確定・返金の反映・異議申し立ての反映は 500 で処理済みにせず、同じイベントの再送で1回だけ反映。復旧は Stripe を確認できなければ戻さず、回復後に1回だけ戻す。手数料・精算額は決済記録から計算した値と一致");

  // ================= 6. Sandbox（テスト決済）を同じ店舗・同じ月に混ぜても、本番の集計・精算は変わらない =================
  const sb = await paidOnly(test, testStripe, storeO.storeCode, Mo, "Sandbox");
  await deliver(test, completedEv(sb));
  await testStripe.ctl(`refund/${sb.charge}`);
  await deliver(test, refundEv(sb));
  await checkPayment(sb, "Sandbox の返金");
  const after6 = await checkStoreMonth(storeO.id, Mo, "Sandbox の後");
  assert.deepEqual([after6.totals.count, after6.totals.fee, after6.settlement.storeShare], [after5.totals.count, after5.totals.fee, after5.settlement.storeShare], "Sandbox の決済が本番の集計・精算に入りました");
  step("Sandbox の決済・返金を同じ店舗・同じ月に混ぜても、本番の売上・手数料・精算額は変わらない");

  // 次の実行に残さない（管理画面の「返金の確認が必要な決済」）
  for (const id of toDismiss) await dismissStripeRefundReview(id, OP1);
  console.log("\nSTRIPE ORDERING E2E PASSED");
}

main()
  .then(async () => {
    await liveStripe.stop();
    await testStripe.stop();
    process.exit(0);
  })
  .catch(async (e) => {
    console.error("\nSTRIPE ORDERING E2E FAILED:", e);
    await liveStripe.stop().catch(() => {});
    await testStripe.stop().catch(() => {});
    process.exit(1);
  });
