/**
 * 決済確定の後の再確認（決済記録の recheckState）の E2E 検証。
 *  - 決済記録の作成と同じトランザクションで PENDING を保存し、作成の後の再確認がすべて成功したときだけ DONE にする
 *  - 再確認の失敗・作成の直後の停止では PENDING のまま。Webhook は 500 を返し、同じ通知の再送で再確認して回復する
 *  - 同時実行・再送でも、決済記録・占い権利・返金の反映・売上・手数料・精算の調整は二重にならない
 *  - recheckState の無い以前の決済記録は再確認しない（再確認が済んだことは意味しない）
 *  - DONE の後に返金の通知を取りこぼすと、この仕組みだけでは反映されない（定期照合など別の仕組みが必要）
 * 本物の Stripe・本番の Firebase には一切接続しない（localhost の模擬 Stripe と Firestore Emulator の demo- プロジェクトだけ。キーは形だけの偽物）。
 *
 *   firebase emulators:start --only firestore --project demo-uranai
 *   （別ターミナル）FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 FIREBASE_PROJECT_ID=demo-uranai-recheck DB_PROVIDER=firestore npm run e2e:stripe-recheck
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
import { createCheckout } from "@/lib/firestore/payments";
import { jstYearMonth } from "@/lib/time";
import { createSimulatedStripeRuntime, STRIPE_SESSION_TTL_MS, type StripeRuntime } from "@/lib/payments/stripe-checkout";
import { confirmStripeCheckout, startStripeCheckout } from "@/lib/payments/stripe-confirm";
import { handleStripeWebhook } from "@/lib/payments/stripe-webhook";

const SYSTEM = { userId: null, role: "SYSTEM" as const };
const step = (msg: string) => console.log(`  ✓ ${msg}`);
const ORIGIN = "http://localhost:3000";
const PORT = 12131;
const KEY = "sk_live_e2e_recheck_dummy";
const stripe = createFakeStripe({ port: PORT, mode: "live", apiKey: KEY });
const fake = stripe.fake;

/** 決済確定のトランザクションの直後に呼ばれる（テスト専用のフック）。crashNext なら例外を投げて処理を止める */
const hook = { crashNext: false, onCommit: null as null | ((txId: string) => Promise<void> | void) };

const signer = new Stripe("sk_test_signer");
let evN = 0;
type Ev = { type: string; object: Record<string, unknown>; id: string };
const ev = (type: string, object: Record<string, unknown>): Ev => ({ type, object, id: `evt_rck_${++evN}_${Date.now()}` });
async function deliver(rt: StripeRuntime, e: Ev) {
  const payload = JSON.stringify({ id: e.id, object: "event", type: e.type, livemode: rt.mode === "live", data: { object: e.object } });
  const sig = signer.webhooks.generateTestHeaderString({ payload, secret: rt.webhookSecret });
  return handleStripeWebhook(payload, sig, rt);
}
const outcomeOf = (r: { body: unknown }) => (r.body as { outcome?: string }).outcome;

type Pay = { checkoutId: string; sessionId: string; charge: string; pi: string; txId: string };
async function paidOnly(rt: StripeRuntime, storeCode: string): Promise<Pay> {
  const { checkoutId, accessToken } = await createCheckout(storeCode, "ZODIAC", { provider: "stripe", ttlMs: STRIPE_SESSION_TTL_MS });
  const r = await startStripeCheckout(accessToken, ORIGIN, rt);
  assert.equal(r.status, "redirect");
  const sessionId = (r as { url: string }).url.split("/").pop()!;
  const p = await stripe.ctl(`pay/${sessionId}`, { fee: 4 });
  return { checkoutId, sessionId, charge: p.charge!, pi: p.paymentIntent!, txId: `stripe_${p.paymentIntent!}` };
}
const completedEv = (p: Pay) => ev("checkout.session.completed", { id: p.sessionId, object: "checkout.session" });
const refundEv = (p: Pay) => ev("charge.refunded", { id: p.charge, object: "charge" });
const disputeEv = (dpId: string) => ev("charge.dispute.created", { id: dpId, object: "dispute" });

async function stateOf(p: Pay) {
  const txs = (await fsdb().collection(C.transactions).where("checkoutId", "==", p.checkoutId).get()).docs;
  const sessions = (await fsdb().collection(C.fortuneSessions).where("transactionId", "==", p.txId).get()).docs;
  const adjustments = (await fsdb().collection(C.settlementAdjustments).where("transactionId", "==", p.txId).get()).docs;
  const co = (await fsdb().collection(C.checkouts).doc(p.checkoutId).get()).data()!;
  assert.ok(txs.length <= 1, `決済記録が${txs.length}件`);
  assert.ok(sessions.length <= 1, `占い権利が${sessions.length}件`);
  return { t: txs[0], fs: sessions[0], co, adjustments: adjustments.length };
}
const refundsListCalls = () => fake.callLog.filter((c) => c === "GET /v1/refunds").length;
async function alertFor(txId: string) {
  const docs = (await fsdb().collection(C.paymentAlerts).where("transactionId", "==", txId).get()).docs;
  return docs.find((d) => d.get("kind") === "refund_sync_failed") ?? null;
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
    webhookSecret: "whsec_e2e_recheck_dummy",
    testHooks: {
      afterConfirmCommit: async (txId) => {
        if (hook.onCommit) await hook.onCommit(txId);
        if (hook.crashNext) {
          hook.crashNext = false;
          throw Object.assign(new Error("simulated stop right after the confirmation transaction"), { name: "SimulatedStop" });
        }
      },
    },
  });
  console.log(`Stripe recheck E2E (emulator ${host} / ${process.env.FIREBASE_PROJECT_ID}, fake Stripe live :${PORT})`);
  const stamp = Date.now();
  const store = await createStore({ name: `再確認検証店舗 ${stamp}`, contactName: "", postalCode: "", address: "", phone: "", email: "" }, SYSTEM);
  const code = store.storeCode;

  // ================= 1. 新規の決済：作成のトランザクションで PENDING → 再確認の成功で DONE =================
  {
    const p = await paidOnly(rt, code);
    let atCommit: unknown = "not called";
    hook.onCommit = async (txId) => {
      atCommit = (await fsdb().collection(C.transactions).doc(txId).get()).get("recheckState");
    };
    const before = refundsListCalls();
    const r = await deliver(rt, completedEv(p));
    hook.onCommit = null;
    assert.equal(r.status, 200);
    assert.equal(outcomeOf(r), "confirmed");
    assert.equal(atCommit, "PENDING", "作成のトランザクションの直後に PENDING が保存されていません");
    const s = await stateOf(p);
    assert.equal(s.t.get("recheckState"), "DONE");
    assert.equal(s.t.get("recheckAttempts"), 1);
    assert.equal(s.t.get("recheckLastError"), null);
    assert.ok(s.t.get("recheckDoneAt"), "recheckDoneAt がありません");
    assert.equal(refundsListCalls() - before, 2, "事前の読み取りと再確認で、返金の一覧を2回読むはず");
    assert.equal(s.fs.get("status"), "PAID");
    step("新規の決済：作成と同じトランザクションで PENDING を保存し、作成の後の再確認が成功して DONE");
  }

  // ================= 2. 再確認の失敗：PENDING のまま・Webhook は 500 → 同じ通知の再送で DONE =================
  {
    const p = await paidOnly(rt, code);
    fake.failCalls.push({ path: /^\/v1\/refunds$/, method: "GET", skip: 1, count: 1 }); // 事前の読み取りは通し、再確認の読み取りだけ失敗
    const e = completedEv(p);
    const r1 = await deliver(rt, e);
    assert.equal(r1.status, 500, "再確認が失敗したのに Webhook が成功を返しました");
    let s = await stateOf(p);
    assert.equal(s.t.get("recheckState"), "PENDING");
    assert.equal(s.t.get("recheckAttempts"), 1);
    assert.ok(s.t.get("recheckLastError"), "失敗の名前が記録されていません");
    assert.equal(s.fs.get("status"), "PAID", "決済確定は取り消さない（権利はそのまま）");
    assert.ok(await alertFor(p.txId), "決済監視に再確認の失敗が記録されていません");
    const r2 = await deliver(rt, e); // 同じイベント ID の再送（処理済みになっていない）
    assert.equal(r2.status, 200);
    assert.equal(outcomeOf(r2), "duplicate");
    s = await stateOf(p);
    assert.equal(s.t.get("recheckState"), "DONE");
    assert.equal(s.t.get("recheckAttempts"), 2);
    assert.equal(s.t.get("recheckLastError"), null);
    step("再確認の失敗：PENDING のまま（DONE にしない）・Webhook は 500・決済監視に記録 → 同じ通知の再送で再確認して DONE");

    // 戻り先（お客さんの画面）からの決済確定では、再確認の失敗で画面を止めない（PENDING のまま返す）
    const q = await paidOnly(rt, code);
    fake.failCalls.push({ path: /^\/v1\/disputes$/, method: "GET", skip: 1, count: 1 });
    const c = await confirmStripeCheckout(q.sessionId, rt);
    assert.equal(c.status, "confirmed");
    assert.equal(c.recheck, "pending");
    assert.equal((await stateOf(q)).t.get("recheckState"), "PENDING");
    const c2 = await confirmStripeCheckout(q.sessionId, rt); // 戻り先の再読み込み
    assert.deepEqual([c2.status, c2.recheck], ["duplicate", "done"]);
    step("戻り先からの決済確定：再確認が失敗しても画面は進み PENDING のまま。再読み込みで再確認して DONE");
  }

  // ================= 3. 作成の直後に停止（その間に返金・異議申し立て）→ 同じ通知の再送で回復 =================
  {
    const p = await paidOnly(rt, code);
    let dpId = "";
    // 事前の読み取りの直後（作成の前）に返金・異議申し立てが発生。その通知は記録が無い時点で届いて消費された（または届かなかった）ものとして送らない
    fake.afterRefundListOnce.set(p.charge, () => void stripe.addRefund(p.charge));
    fake.afterDisputeListOnce.set(p.charge, () => {
      dpId = stripe.addDispute(p.charge);
    });
    hook.crashNext = true;
    const e = completedEv(p);
    const r1 = await deliver(rt, e);
    assert.equal(r1.status, 500, "作成の直後の停止で Webhook が成功を返しました");
    let s = await stateOf(p);
    assert.equal(s.t.get("recheckState"), "PENDING", "作成の直後に止まったのに PENDING が残っていません");
    assert.equal(s.t.get("recheckAttempts"), 0, "再確認は実行されていないはず");
    assert.equal(s.t.get("refundStatus"), null, "（前提）事前の読み取りの後の返金はまだ反映されていない");
    assert.equal(s.co.status, "SUCCEEDED");
    const r2 = await deliver(rt, e);
    assert.equal(r2.status, 200);
    s = await stateOf(p);
    assert.equal(s.t.get("recheckState"), "DONE");
    assert.equal(s.t.get("refundStatus"), "succeeded");
    assert.equal(s.t.get("paymentStatus"), "REFUNDED");
    assert.equal(s.t.get("amountRefunded"), 100);
    assert.equal(s.t.get("disputeStatus"), "open");
    assert.equal(s.fs.get("status"), "EXPIRED");
    assert.equal(s.fs.get("suspendedByRefund"), true);
    assert.equal(s.co.status, "REFUNDED");
    // その後に返金・異議申し立ての通知が届いても二重に反映しない
    assert.equal(outcomeOf(await deliver(rt, refundEv(p))), "unchanged");
    assert.equal(outcomeOf(await deliver(rt, disputeEv(dpId))), "unchanged");
    assert.equal((await stateOf(p)).t.get("amountRefunded"), 100);
    step("作成の直後に停止：PENDING が残り、同じ通知の再送で再確認して、間に起きた返金・異議申し立てを反映（その後の通知は二重にしない）");
  }

  // ================= 4. 同時実行：再送・戻り先・返金の通知が同時でも二重にならない =================
  {
    const solo = await createStore({ name: `再確認同時店舗 ${stamp}`, contactName: "", postalCode: "", address: "", phone: "", email: "" }, SYSTEM);
    const p = await paidOnly(rt, solo.storeCode);
    fake.afterRefundListOnce.set(p.charge, () => void stripe.addRefund(p.charge));
    hook.crashNext = true;
    const e = completedEv(p);
    assert.equal((await deliver(rt, e)).status, 500);
    const results = await Promise.all([
      deliver(rt, e),
      deliver(rt, e),
      deliver(rt, completedEv(p)),
      confirmStripeCheckout(p.sessionId, rt),
      confirmStripeCheckout(p.sessionId, rt),
      deliver(rt, refundEv(p)),
      deliver(rt, refundEv(p)),
    ]);
    // 同じ通知が処理中なら 409（処理権を取れない。処理済みにしない）→ Stripe と同じく後で再送する
    for (const r of results) if ("body" in r) assert.ok(r.status === 200 || r.status === 409, `同時実行の Webhook が失敗：${r.status} ${JSON.stringify(r.body)}`);
    if (results.some((r) => "body" in r && r.status === 409)) assert.equal((await deliver(rt, e)).status, 200);
    const s = await stateOf(p);
    assert.equal(s.t.get("recheckState"), "DONE");
    assert.equal(s.t.get("amountRefunded"), 100, "返金が二重に反映されました");
    assert.equal(String(s.t.get("refundKey")).split(":")[4].split(",").length, 1, "返金の記録が1件ではありません");
    assert.equal(s.t.get("paymentStatus"), "REFUNDED");
    assert.equal(s.adjustments, 0, "未払いの月なのに精算の調整が作られました");
    const ym = jstYearMonth(new Date());
    const t = await monthTotals(ym, solo.id);
    assert.equal(t.count, 0, "返金済みの決済が売上に数えられました");
    assert.equal(t.fee, 4, "手数料が決済記録ごとに1回ではありません");
    step("同時実行（同じ通知の再送×2・別の通知・戻り先×2・返金の通知×2）：決済記録・権利は1件、返金は1回、売上・手数料・精算は二重にならない");
  }

  // ================= 5. 再確認の読み取りの後に返金・異議申し立て：それぞれの通知で反映 =================
  {
    const p = await paidOnly(rt, code);
    let dpId = "";
    hook.onCommit = () => {
      // 作成の後（再確認の読み取りの直後）に発生させる
      fake.afterRefundListOnce.set(p.charge, () => void stripe.addRefund(p.charge, { amount: 30 }));
      fake.afterDisputeListOnce.set(p.charge, () => {
        dpId = stripe.addDispute(p.charge, { amount: 70 });
      });
    };
    const r = await deliver(rt, completedEv(p));
    hook.onCommit = null;
    assert.equal(r.status, 200);
    let s = await stateOf(p);
    assert.equal(s.t.get("recheckState"), "DONE", "再確認の読み取りの後の変化で DONE にならないのは誤り（それぞれの通知で反映する）");
    assert.equal(s.t.get("refundStatus"), null);
    await Promise.all([deliver(rt, refundEv(p)), deliver(rt, disputeEv(dpId))]);
    s = await stateOf(p);
    assert.equal(s.t.get("refundStatus"), "partial");
    assert.equal(s.t.get("amountRefunded"), 30);
    assert.equal(s.t.get("disputeStatus"), "open");
    assert.equal(s.fs.get("status"), "EXPIRED");
    assert.equal(s.co.status, "REFUNDED");
    assert.equal(s.t.get("recheckState"), "DONE");
    step("再確認の読み取りの後の返金・異議申し立て：DONE のまま、決済記録がある状態で届く通知で反映（同時に届いても正しい状態）");
  }

  // ================= 6. 以前の決済記録（recheckState が無い）との互換性 =================
  {
    const p = await paidOnly(rt, code);
    assert.equal((await deliver(rt, completedEv(p))).status, 200);
    const ref = fsdb().collection(C.transactions).doc(p.txId);
    await ref.update({ recheckState: FieldValue.delete(), recheckAttempts: FieldValue.delete(), recheckLastAttemptAt: FieldValue.delete(), recheckLastError: FieldValue.delete(), recheckDoneAt: FieldValue.delete() });
    let before = refundsListCalls();
    const r = await deliver(rt, completedEv(p));
    assert.equal(outcomeOf(r), "duplicate");
    assert.equal(refundsListCalls() - before, 1, "以前の決済記録で再確認が実行されました（事前の読み取りの1回だけのはず）");
    assert.equal((await ref.get()).get("recheckState"), undefined, "以前の決済記録に recheckState を書き込みました（再確認が済んだことにしてしまう）");
    // 想定外の値は安全側で PENDING として扱う（再確認をやり直して DONE）
    await ref.update({ recheckState: "BROKEN" });
    before = refundsListCalls();
    await deliver(rt, completedEv(p));
    assert.equal(refundsListCalls() - before, 2);
    assert.equal((await ref.get()).get("recheckState"), "DONE");
    step("以前の決済記録（recheckState なし）：再確認しない・項目を書き込まない。想定外の値は PENDING として再確認");
  }

  // ================= 7. DONE の後の返金の通知の取りこぼしは、この仕組みでは防げない =================
  {
    const p = await paidOnly(rt, code);
    assert.equal((await deliver(rt, completedEv(p))).status, 200);
    assert.equal((await stateOf(p)).t.get("recheckState"), "DONE");
    stripe.addRefund(p.charge); // 返金の通知は届かない（取りこぼし）
    assert.equal(outcomeOf(await deliver(rt, completedEv(p))), "duplicate");
    const s = await stateOf(p);
    assert.equal(s.t.get("refundStatus"), null, "（仕様の確認）DONE の後の返金は、返金の通知が無ければ反映されない");
    assert.equal(s.fs.get("status"), "PAID");
    assert.equal(s.co.status, "SUCCEEDED");
    // 返金の通知が届けば反映される
    assert.equal(outcomeOf(await deliver(rt, refundEv(p))), "refunded");
    step("DONE の後に返金の通知を取りこぼすと反映されない（この仕組みの範囲外。定期照合などが必要）。通知が届けば反映");
  }

  console.log("\nSTRIPE RECHECK E2E PASSED");
}

main()
  .then(async () => {
    await stripe.stop();
    process.exit(0);
  })
  .catch(async (e) => {
    console.error("\nSTRIPE RECHECK E2E FAILED:", e);
    await stripe.stop().catch(() => {});
    process.exit(1);
  });
