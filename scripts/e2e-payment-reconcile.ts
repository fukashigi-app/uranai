/**
 * Stripe 起点の決済照合（F2 第1段階）の E2E 検証。
 * 本物の Stripe・本番の Firebase には一切接続しない（localhost の模擬 Stripe（本番モード）と Firestore Emulator の demo- プロジェクトだけ。キーは形だけの偽物）。
 *
 *  1. 正常な決済・返金済み・異議申し立て中：記録と一致（返金・異議申し立ての詳しい照合は第2段階）
 *  2. 注文が消えた決済（Webhook なし・F1 の決済要確認あり・確定の後に消えた）：stripe_paid_no_checkout
 *  3. 取引が無い決済：stripe_paid_no_transaction
 *  4. 金額の不一致：amount_or_mode_mismatch
 *  5. 同じ注文への2回目の支払い：duplicate_or_bad_link
 *  6. 支払いの直後：処理待ち（異常にしない）。支払いが完了していない：照合しない
 *  7. 本番とテストの混在・別の環境・環境を表す値が無い・形が違う：対象外・要確認（値が無いものを正常にしない）
 *  8. 期間の外の決済は数えない
 *  9. ページ送り（230件・1回1ページで区切って再開）・取得の失敗（未完了 → 再開で完了。二重に数えない）
 * 10. 再開用の値の書き換え・別の環境での再開は拒否
 * 11. 読み取り専用：照合の前後で Firestore のすべての文書が変わらない・Stripe への要求は GET だけ。結果に個人情報・秘密情報が無い
 *
 *   firebase emulators:start --only firestore --project demo-uranai
 *   （別ターミナル）FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 FIREBASE_PROJECT_ID=demo-uranai-reconcile DB_PROVIDER=firestore SESSION_SECRET=<32文字以上> \
 *     npx tsx --conditions=react-server scripts/e2e-payment-reconcile.ts
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
import { decodeReconcileToken, encodeReconcileToken, resumeReconcile, startReconcile, type ReconcileRun } from "@/lib/payments/stripe-reconcile";

const SYSTEM = { userId: null, role: "SYSTEM" as const };
const step = (msg: string) => console.log(`  ✓ ${msg}`);
const ORIGIN = "http://localhost:3000";
const PORT = 12191;
const KEY = "sk_live_e2e_reconcile_dummy";
const WHSEC = "whsec_e2e_reconcile_dummy";
const OTHER_TAG = "fp_fedcba9876543210";
const stripe = createFakeStripe({ port: PORT, mode: "live", apiKey: KEY });
const signer = new Stripe("sk_test_signer");
const USER = "operator-e2e";
let evN = 0;

const nowSec = () => Math.floor(Date.now() / 1000);
const OLD = () => nowSec() - 2 * 3600; // 処理待ちの時間（60分）を過ぎた支払い

async function deliver(rt: StripeRuntime, type: string, object: Record<string, unknown>) {
  const id = `evt_rc_${++evN}_${Date.now()}`;
  const payload = JSON.stringify({ id, object: "event", type, livemode: true, data: { object } });
  const sig = signer.webhooks.generateTestHeaderString({ payload, secret: rt.webhookSecret });
  return handleStripeWebhook(payload, sig, rt);
}
const outcomeOf = (r: { body: unknown }) => (r.body as { outcome?: string }).outcome;

type Pay = { checkoutId: string; sessionId: string; charge: string; pi: string; txId: string };
async function pay(rt: StripeRuntime, storeCode: string, ctl: Record<string, unknown> = {}): Promise<Pay> {
  const { checkoutId, accessToken } = await createCheckout(storeCode, "ZODIAC", { provider: "stripe", ttlMs: STRIPE_SESSION_TTL_MS });
  const r = await startStripeCheckout(accessToken, ORIGIN, rt);
  const sessionId = (r as { url: string }).url.split("/").pop()!;
  const p = await stripe.ctl(`pay/${sessionId}`, { fee: 4, created: OLD(), ...ctl });
  return { checkoutId, sessionId, charge: p.charge!, pi: p.paymentIntent!, txId: `stripe_${p.paymentIntent!}` };
}
async function confirmed(rt: StripeRuntime, code: string): Promise<Pay> {
  const p = await pay(rt, code);
  assert.equal(outcomeOf(await deliver(rt, "checkout.session.completed", { id: p.sessionId, object: "checkout.session" })), "confirmed");
  return p;
}
const raw = (o: Record<string, unknown>) => stripe.ctl("raw-pi", o).then((x) => x.paymentIntent!);

/** Firestore のすべての文書の更新時刻（書き込みがあれば変わる） */
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

/** 最後まで（未完了なら再開をくり返して）照合する */
async function runAll(rt: StripeRuntime, from: number, to: number, limits: Parameters<typeof startReconcile>[0]["limits"] = {}) {
  let run = await startReconcile({ rt, userId: USER, fromSec: from, toSec: to, limits });
  const segments = [run];
  while (run.token) {
    run = await resumeReconcile({ rt, userId: USER, token: run.token, limits });
    segments.push(run);
    assert.ok(segments.length < 50, "再開が終わりません");
  }
  return { run, segments };
}
const byKindOf = (run: ReconcileRun, pi: string) => run.state.anomalies.filter((a) => a.paymentIntentId === pi).map((a) => a.kind);

async function main() {
  const host = process.env.FIRESTORE_EMULATOR_HOST ?? "";
  assert.match(host, /^(127\.0\.0\.1|localhost|\[::1\]):\d+$/, "FIRESTORE_EMULATOR_HOST（localhost の Emulator）が必要です");
  assert.match(process.env.FIREBASE_PROJECT_ID ?? "", /^demo-/, "FIREBASE_PROJECT_ID は demo- で始まる Emulator 用の ID にしてください");
  assert.equal(dataProvider(), "firestore");
  assert.ok((process.env.SESSION_SECRET ?? "").length >= 32, "SESSION_SECRET（32文字以上）が必要です");
  for (const k of ["STRIPE_SECRET_KEY", "STRIPE_LIVE_CHECKOUT", "STRIPE_LIVE_OPERATOR_TEST", "VERCEL_ENV"]) delete process.env[k];
  await stripe.start();
  const rt = createSimulatedStripeRuntime("live", { apiBase: `http://127.0.0.1:${PORT}`, secretKey: KEY, webhookSecret: WHSEC, accountId: "acct_fakeliveaccount" });
  console.log(`Payment reconcile E2E (emulator ${host} / ${process.env.FIREBASE_PROJECT_ID}, fake Stripe live :${PORT})`);
  const store = await createStore({ name: `照合の検証店舗 ${Date.now()}`, contactName: "", postalCode: "", address: "", phone: "", email: "" }, SYSTEM);
  const code = store.storeCode;
  const tag = rt.envTag;

  // ===== データ（Stripe と Firestore） =====
  const A = await confirmed(rt, code); // 正常
  const H = await confirmed(rt, code); // 返金済み
  await stripe.ctl(`refund/${H.charge}`);
  assert.equal(outcomeOf(await deliver(rt, "charge.refunded", { id: H.charge, object: "charge" })), "refunded");
  const I = await confirmed(rt, code); // 異議申し立て中
  const dp = await stripe.ctl(`dispute/${I.charge}`, { status: "needs_response" });
  assert.equal(outcomeOf(await deliver(rt, "charge.dispute.created", { id: dp.dispute, object: "dispute" })), "dispute_open");
  const B = await pay(rt, code); // 注文が消えた（Webhook は届いていない）
  await fsdb().collection(C.checkouts).doc(B.checkoutId).delete();
  const Cc = await pay(rt, code); // 注文が消えた（Webhook は届き、F1 で決済要確認に記録済み）
  await fsdb().collection(C.checkouts).doc(Cc.checkoutId).delete();
  assert.equal((await deliver(rt, "checkout.session.completed", { id: Cc.sessionId, object: "checkout.session" })).status, 500);
  const D = await confirmed(rt, code); // 確定の後に注文が消えた
  await fsdb().collection(C.checkouts).doc(D.checkoutId).delete();
  const E = await pay(rt, code); // 取引が無い（Webhook が届いていない）
  const F = await confirmed(rt, code); // 金額の不一致
  await fsdb().collection(C.transactions).doc(F.txId).update({ amount: 200 });
  const G = await raw({ created: OLD(), metadata: { checkoutId: A.checkoutId, storeId: store.id, fortuneType: "ZODIAC", uranaiEnv: tag } }); // 同じ注文への2回目の支払い
  const J = await pay(rt, code, { created: nowSec() - 120 }); // 支払いの直後
  const O = await pay(rt, code, { async: true }); // 支払いが完了していない（PayPay の確定待ちなど）
  const K = await raw({ created: OLD(), livemode: false, metadata: { checkoutId: "co_test", uranaiEnv: tag } }); // テストの決済
  const L = await raw({ created: OLD(), metadata: { checkoutId: "co_other", uranaiEnv: OTHER_TAG } }); // 別の環境
  const M = await raw({ created: OLD(), metadata: { checkoutId: "co_untagged" } }); // 環境を表す値が無い
  const N = await raw({ created: OLD(), metadata: { checkoutId: "co_bad", uranaiEnv: "production" } }); // 値の形が違う
  const P = await raw({ created: nowSec() - 3 * 86_400, metadata: {} }); // 期間の外
  step("データ：正常・返金・異議申し立て・注文の消失×3・取引なし・金額違い・重複・処理待ち・未払い・テスト・別の環境・値なし・形違い・期間外");

  const from = nowSec() - 86_400;
  const to = nowSec() + 3600; // 今より後は今の時刻に切り詰める

  // ===== 照合（読み取り専用であることも確かめる） =====
  // 期間の終わり（to）は照合の開始の時刻（秒）で、その秒に作られたものは含まない。データを作った秒が過ぎてから照合する
  await new Promise((ok) => setTimeout(ok, 1100));
  const before = await snapshotAll();
  const callsBefore = stripe.fake.callLog.length;
  const { run, segments } = await runAll(rt, from, to);
  assert.equal(await snapshotAll(), before, "照合で Firestore の文書が変わりました");
  const calls = stripe.fake.callLog.slice(callsBefore);
  assert.ok(calls.length > 0 && calls.every((c) => c.startsWith("GET ")), `GET 以外の要求があります：${calls.filter((c) => !c.startsWith("GET ")).join(",")}`);
  assert.ok(calls.every((c) => /^GET \/v1\/(payment_intents(\/pi_[A-Za-z0-9_]+)?|account|refunds|disputes)$/.test(c)), `一覧・個別の確認・アカウント以外の要求：${calls.join(",")}`);
  step(`読み取り専用：Firestore の全文書が不変・Stripe への要求は GET だけ（${[...new Set(calls)].join("・")}）`);

  const s = run.state;
  assert.equal(segments.length, 1);
  assert.deepEqual([run.verdict, run.stoppedBy, run.token, s.done], ["issues", null, null, true]);
  assert.equal(s.to <= nowSec(), true, "期間の終わりが今の時刻に切り詰められていません");
  assert.deepEqual(s.counts, {
    scanned: 15, inScope: 11, matched: 3, notPaid: 1, pending: 1, anomalyPayments: 6, anomalies: 6, otherMode: 1, otherEnv: 1, untagged: 1, badTag: 1, needsReview: 3,
    // 第2段階a：返金済み（H）・異議申し立て中（I）の Charge を確かめ、一致（返金・異議申し立ての一覧の同じ Charge は二重に数えない）
    adjustmentChecks: 2, adjustmentIssues: 0, refundsSeen: 1, disputesSeen: 1, refundInProgress: 0, disputeOpen: 1, settlementChecked: 0,
  });
  assert.deepEqual(s.byKind, { stripe_paid_no_checkout: 3, stripe_paid_no_transaction: 1, amount_or_mode_mismatch: 1, duplicate_or_bad_link: 1, refund_mismatch: 0, dispute_mismatch: 0, settlement_adjustment_mismatch: 0 });
  step("件数：読んだ15件（期間外は数えない）・この環境11件・一致3件（正常・返金済み・異議申し立て中）・異常6件・処理待ち1件・未払い1件");

  assert.deepEqual(byKindOf(run, B.pi), ["stripe_paid_no_checkout"]);
  assert.deepEqual(byKindOf(run, Cc.pi), ["stripe_paid_no_checkout"]);
  assert.deepEqual(byKindOf(run, D.pi), ["stripe_paid_no_checkout"]);
  assert.deepEqual(s.anomalies.find((a) => a.paymentIntentId === D.pi)!.details, ["transaction_exists"]);
  assert.equal(s.anomalies.find((a) => a.paymentIntentId === Cc.pi)!.existingReview, true, "F1 の決済要確認の記録が表示されていません");
  assert.equal(s.anomalies.find((a) => a.paymentIntentId === B.pi)!.existingReview, false);
  step("注文が消えた決済：3件とも検出（F1 で決済要確認に記録済みのものは「記録済み」と表示。確定の後に消えたものは「取引はある」）");
  assert.deepEqual(byKindOf(run, E.pi), ["stripe_paid_no_transaction"]);
  step("取引が無い決済：検出");
  assert.deepEqual(byKindOf(run, F.pi), ["amount_or_mode_mismatch"]);
  assert.deepEqual(s.anomalies.find((a) => a.paymentIntentId === F.pi)!.details, ["amount"]);
  step("金額の不一致：検出（項目＝金額）");
  assert.deepEqual(byKindOf(run, G), ["duplicate_or_bad_link"]);
  assert.deepEqual(s.anomalies.find((a) => a.paymentIntentId === G)!.details, ["checkout_linked_to_other_payment"]); // 確定済みの1件目は重複の索引に入れない（二重に数えない）
  assert.deepEqual([byKindOf(run, A.pi), byKindOf(run, H.pi), byKindOf(run, I.pi)], [[], [], []]);
  step("同じ注文への2回目の支払い：重複として検出（1回目の決済は一致のまま）");
  assert.deepEqual(s.pendingItems.map((x) => x.paymentIntentId), [J.pi]);
  assert.deepEqual([byKindOf(run, J.pi), byKindOf(run, O.pi)], [[], []]);
  step("支払いの直後は処理待ち（異常にしない）・支払いが完了していないものは照合しない");
  assert.deepEqual(s.reviewItems.map((x) => [x.paymentIntentId, x.scope]).sort(), [[L, "other_env"], [M, "untagged"], [N, "bad_tag"]].sort());
  assert.ok(![K, P].some((id) => JSON.stringify(s).includes(id)), "テストの決済・期間外の決済が結果に入っています");
  step("対象の判定：テストの決済は対象外・本番での別の環境／値なし／形違いは「要確認」（正常にしない）・期間外は読まない");

  const text = JSON.stringify(run);
  for (const bad of ["buyer@example.com", "client_secret", "_secret_", KEY, WHSEC, "receipt_email"]) assert.equal(text.includes(bad), false, `結果に ${bad} が含まれています`);
  step("結果に個人情報（メール）・client_secret・キーが含まれない");

  // ===== 再開用の値の書き換え・別の環境 =====
  {
    const first = await startReconcile({ rt, userId: USER, fromSec: from, toSec: to, limits: { maxPagesPerSegment: 0 } });
    assert.deepEqual([first.verdict, first.stoppedBy, first.state.pages], ["incomplete", "page_limit", 0]);
    const tok = first.token!;
    const decoded = decodeReconcileToken(tok);
    const [, sig] = tok.split(".");
    const forged = `${Buffer.from(JSON.stringify({ ...decoded, from: from - 20 * 86_400 })).toString("base64url")}.${sig}`;
    await assert.rejects(resumeReconcile({ rt, userId: USER, token: forged }), /invalid_token/);
    await assert.rejects(resumeReconcile({ rt, userId: "someone-else", token: tok }), /token_user_mismatch/);
    const other = createSimulatedStripeRuntime("live", { apiBase: `http://127.0.0.1:${PORT}`, secretKey: KEY, webhookSecret: WHSEC, accountId: "acct_fakeliveaccount", envTag: OTHER_TAG });
    await assert.rejects(resumeReconcile({ rt: other, userId: USER, token: tok }), /token_environment_mismatch/);
    // 別の鍵で署名し直した値も拒否
    await assert.rejects(resumeReconcile({ rt, userId: USER, token: encodeReconcileToken({ ...decoded, from: 1 }, "another-strong-secret-for-e2e-0123456789") }), /invalid_token/);
    const done = await resumeReconcile({ rt, userId: USER, token: tok });
    assert.deepEqual([done.verdict, done.state.counts], ["issues", s.counts]);
    await assert.rejects(resumeReconcile({ rt, userId: USER, token: tok, now: new Date(Date.now() + 3 * 3600_000) }), /expired_token/);
    step("再開用の値：期間の書き換え・別の運営者・別の環境・別の鍵・期限切れは拒否。正しい値なら同じ結果で完了");
  }

  // ===== ページ送り・取得の失敗 =====
  {
    const base = nowSec() - 3600;
    for (let i = 0; i < 230; i++) await raw({ created: base - i, status: "canceled", metadata: { checkoutId: `co_bulk_${i}`, uranaiEnv: tag } });
    const full = await runAll(rt, from, to);
    assert.equal(full.segments.length, 1);
    assert.deepEqual([full.run.state.counts.scanned, full.run.state.pages, full.run.state.counts.notPaid], [245, 5, 231]); // 決済3ページ＋返金1＋異議申し立て1
    const paged = await runAll(rt, from, to, { maxPagesPerSegment: 1 });
    assert.equal(paged.segments.length, 5);
    assert.deepEqual(paged.segments.map((x) => [x.verdict, x.stoppedBy]), [...Array(4).fill(["incomplete", "page_limit"]), ["issues", null]]);
    assert.deepEqual(paged.run.state.counts, full.run.state.counts);
    step("ページ送り：245件を3ページ（＋返金・異議申し立ての一覧1ページずつ）で読む。1回1ページで区切って再開しても、同じ件数（二重に数えない）");

    stripe.fake.failCalls.push({ path: /^\/v1\/payment_intents$/, method: "GET", skip: 1, count: 1 });
    const failed = await startReconcile({ rt, userId: USER, fromSec: from, toSec: to });
    assert.deepEqual([failed.verdict, failed.stoppedBy, failed.state.pages, failed.state.done], ["incomplete", "stripe_error", 1, false]);
    assert.ok(failed.token);
    const resumed = await resumeReconcile({ rt, userId: USER, token: failed.token });
    assert.deepEqual([resumed.verdict, resumed.state.pages], ["issues", 5]);
    assert.deepEqual(resumed.state.counts, full.run.state.counts);
    step("Stripe の取得の失敗：未完了（「異常なし」にしない・続きの位置は進めない）→ 再開で完了し、件数は失敗しなかったときと同じ");

    stripe.fake.failPaths.push(/^\/v1\/payment_intents$/);
    const down = await startReconcile({ rt, userId: USER, fromSec: from, toSec: to });
    assert.deepEqual([down.verdict, down.stoppedBy, down.state.pages, down.state.counts.scanned], ["incomplete", "stripe_error", 0, 0]);
    stripe.fake.failPaths.length = 0;
    step("Stripe に接続できない：1件も読めず未完了（異常なしと表示しない）");
  }

  // ===== 同じ注文への重複（ページをまたぐ・処理待ちの時間・確定済み・再開・上限） =====
  {
    // ここからは別の環境を表す値で作る（上のデータは「別の環境」になり、この検証の判定に影響しない）
    const rt2 = createSimulatedStripeRuntime("live", { apiBase: `http://127.0.0.1:${PORT}`, secretKey: KEY, webhookSecret: WHSEC, accountId: "acct_fakeliveaccount", envTag: "fp_2222222222222222" });
    const tag2 = rt2.envTag;
    const fill = async (start: number, n: number, label: string) => {
      for (let i = 1; i <= n; i++) await raw({ created: start + i, status: "canceled", metadata: { checkoutId: `co_${label}_${i}`, uranaiEnv: tag2 } });
    };
    const dupOf = (co: string, created: number) => raw({ created, metadata: { checkoutId: co, storeId: store.id, fortuneType: "ZODIAC", uranaiEnv: tag2 } });
    // 1・3. 2件とも未確定・60分超過（間に25件を挟み、1ページ20件で別のページ）
    const b1 = nowSec() - 5 * 3600;
    const X1 = await pay(rt2, code, { created: b1 });
    await fill(b1, 25, "x");
    const X2 = await dupOf(X1.checkoutId, b1 + 30);
    // 2. 2件とも未確定・60分以内（別のページ）
    const b2 = nowSec() - 40 * 60;
    const Y1 = await pay(rt2, code, { created: b2 });
    await fill(b2, 25, "y");
    const Y2 = await dupOf(Y1.checkoutId, b2 + 30);
    // 4. 片方だけ確定済み（別のページ）
    const b3 = nowSec() - 6 * 3600;
    const W1 = await confirmed(rt2, code);
    await fill(b3, 25, "w");
    const W2 = await dupOf(W1.checkoutId, b3 + 30);
    const lim = { pageSize: 20 };
    const d1 = await runAll(rt2, nowSec() - 7 * 3600, nowSec() + 60, { ...lim, maxPagesPerSegment: 100 });
    const r = d1.run;
    const kinds = (pi: string) => r.state.anomalies.filter((a) => a.paymentIntentId === pi).map((a) => `${a.kind}:${a.details.join("+")}`).sort();
    assert.ok(r.state.pages >= 10, `ページ数が少なすぎます（${r.state.pages}）`);
    assert.deepEqual(kinds(X1.pi), ["duplicate_or_bad_link:duplicate_in_run", "stripe_paid_no_transaction:"]);
    assert.deepEqual(kinds(X2), ["duplicate_or_bad_link:duplicate_in_run", "stripe_paid_no_transaction:"]);
    step("重複（60分超過・別のページ）：2件とも「取引が無い」＋「重複」");
    assert.deepEqual([kinds(Y1.pi), kinds(Y2)], [["duplicate_or_bad_link:duplicate_in_run"], ["duplicate_or_bad_link:duplicate_in_run"]]);
    assert.equal(r.state.pendingItems.some((x) => x.paymentIntentId === Y1.pi || x.paymentIntentId === Y2), false, "重複が処理待ちに残っています");
    assert.equal(r.state.counts.pending, 0);
    step("重複（60分以内・別のページ）：2件とも「重複」の異常（処理待ちにしない。同じページのときと同じ）");
    assert.deepEqual([kinds(W1.pi), kinds(W2)], [[], ["duplicate_or_bad_link:checkout_linked_to_other_payment"]]);
    step("片方だけ確定済み：確定済みの1件目は一致・2件目は「注文は別の決済と紐付いている」（重複として二重に数えない）");
    assert.deepEqual(r.state.byKind, { stripe_paid_no_checkout: 0, stripe_paid_no_transaction: 2, amount_or_mode_mismatch: 0, duplicate_or_bad_link: 5, refund_mismatch: 0, dispute_mismatch: 0, settlement_adjustment_mismatch: 0 });
    assert.deepEqual([r.state.counts.anomalyPayments, r.state.counts.anomalies, r.state.counts.matched], [5, 7, 1]);
    assert.equal(r.state.truncated.dupIndex, false);

    // 5. 同じ期間を、1回1ページで区切って再開・途中で取得に失敗して再開しても同じ結果
    const sorted = (x: ReconcileRun) => ({ counts: x.state.counts, byKind: x.state.byKind, anomalies: x.state.anomalies.map((a) => JSON.stringify(a)).sort(), pending: x.state.pendingItems.map((a) => JSON.stringify(a)).sort(), review: x.state.reviewItems.map((a) => JSON.stringify(a)).sort(), truncated: x.state.truncated });
    const from2 = r.state.from;
    const to2 = r.state.to;
    const once = await runAll(rt2, from2, to2, { ...lim, maxPagesPerSegment: 100 });
    const paged = await runAll(rt2, from2, to2, { ...lim, maxPagesPerSegment: 1 });
    assert.ok(paged.segments.length >= 10);
    assert.deepEqual(sorted(paged.run), sorted(once.run));
    stripe.fake.failCalls.push({ path: /^\/v1\/payment_intents$/, method: "GET", skip: 4, count: 1 });
    let fr = await startReconcile({ rt: rt2, userId: USER, fromSec: from2, toSec: to2, limits: lim });
    assert.deepEqual([fr.stoppedBy, fr.state.pages], ["stripe_error", 4]);
    while (fr.token) fr = await resumeReconcile({ rt: rt2, userId: USER, token: fr.token, limits: lim });
    assert.deepEqual(sorted(fr), sorted(once.run));
    assert.deepEqual(sorted(once.run).byKind, r.state.byKind);
    step(`重複の判定と再開：1回1ページで区切って再開（${paged.segments.length}回）・途中で取得に失敗して再開しても、件数・一覧の詳細まで同じ`);
    // ページの分かれ方によらない：1ページ100件（重複の2件が同じページ）でも、20件（別のページ）と件数・詳細まで同じ
    const big = await runAll(rt2, from2, to2, { pageSize: 100, maxPagesPerSegment: 100 });
    const pageOf = (x: ReconcileRun, pi: string) => x.state.anomalies.some((a) => a.paymentIntentId === pi);
    assert.ok(pageOf(big.run, Y1.pi) && pageOf(big.run, Y2));
    assert.deepEqual(sorted(big.run), sorted(once.run));
    step("ページの分かれ方によらない：重複の2件が同じページ（100件）でも別のページ（20件）でも、件数・詳細まで同じ（60分以内も超過も）");

    // 6. 上限：一覧の表示の上限（1件）では重複の判定は変わらない。重複の判定の索引の上限（1件）では「判定していない」を明示
    const listCap = await runAll(rt2, from2, to2, { ...lim, maxPagesPerSegment: 100, maxListed: 1 });
    assert.deepEqual([listCap.run.state.byKind, listCap.run.state.counts], [r.state.byKind, r.state.counts]);
    assert.deepEqual([listCap.run.state.truncated.anomalies, listCap.run.state.anomalies.length, listCap.run.state.truncated.dupIndex], [true, 1, false]);
    const idxCap = await runAll(rt2, from2, to2, { ...lim, maxPagesPerSegment: 100, maxDupIndex: 1 });
    assert.equal(idxCap.run.state.truncated.dupIndex, true);
    assert.ok(idxCap.run.state.byKind.duplicate_or_bad_link < r.state.byKind.duplicate_or_bad_link, "索引の上限で、判定できなかった重複があるはずです");
    assert.notEqual(idxCap.run.verdict, "ok");
    step("上限：表示の上限（一覧）に達しても重複の件数は同じ（判定は一覧と別）。重複の判定の索引の上限に達したら truncated.dupIndex で「判定していない」を示し、「異常なし」にしない");
  }

  await stripe.stop();
  console.log("\nPAYMENT RECONCILE E2E PASSED");
}

main().catch((e) => {
  console.error("PAYMENT RECONCILE E2E FAILED:", e);
  process.exit(1);
});
