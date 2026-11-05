/**
 * 運営画面から理由を入力して占い権利を戻す操作の、ブラウザ（Chromium・Playwright）での E2E 検証。
 * Firestore Emulator の demo- プロジェクトと、このスクリプトが起動する「Stripe API の模擬サーバー」（localhost）だけを使う。
 * 本物の Stripe・本番の Firebase には一切接続しない。キーはすべて形だけの偽物。
 * 返金の確認の一覧が、このスクリプトの決済だけになるよう、専用のプロジェクト（demo-uranai-browser）で動かす。
 *
 *   firebase emulators:start --only firestore --project demo-uranai
 *   （別ターミナル）npm run build && FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 FIREBASE_PROJECT_ID=demo-uranai-browser DB_PROVIDER=firestore \
 *       SITE_STATUS=development PAYMENT_PROVIDER=stripe ENABLE_TEST_PAYMENT=false ALLOW_MOCK_PAYMENTS_IN_PRODUCTION=false \
 *       STRIPE_TEST_CHECKOUT=on STRIPE_NEW_CHECKOUT=on STRIPE_SECRET_KEY=sk_test_e2e_dummy STRIPE_WEBHOOK_SECRET=whsec_e2e_dummy \
 *       STRIPE_API_BASE=http://127.0.0.1:12111 npx next start
 *   （別ターミナル）FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 FIREBASE_PROJECT_ID=demo-uranai-browser npm run e2e:admin-restore-browser
 */
import "dotenv/config";
import assert from "node:assert/strict";
import Stripe from "stripe";
import { createFakeStripe } from "./lib/fake-stripe";
import { C, fsdb } from "@/lib/firestore/admin";
import { dataProvider } from "@/lib/data-provider";
import { createOperator, createStore, createStoreUser } from "@/lib/services/stores";
import { randomToken, sha256Hex } from "@/lib/security/crypto";
import { dismissStripeDisputeReview, dismissStripeRefundReview } from "@/lib/payments/stripe-confirm";
import { createRequire } from "node:module";
import { recordPaymentReview } from "@/lib/firestore/payment-reviews";
import { recordPaymentAlert } from "@/lib/firestore/payment-alerts";
import { acquireWebhookEventLease, recordWebhookEventFailure } from "@/lib/firestore/payments";
import path from "node:path";

// 使う範囲の Playwright の型（プロジェクトの依存関係に入れないため、ここで最小限だけ定義する）
type PwLocator = {
  count(): Promise<number>;
  textContent(): Promise<string | null>;
  getAttribute(n: string): Promise<string | null>;
  evaluate(fn: (el: Element) => void): Promise<void>;
  fill(v: string): Promise<void>;
  click(): Promise<void>;
  waitFor(o?: { timeout?: number }): Promise<void>;
  getByRole(role: "button", o: { name: string }): PwLocator;
  getByText(t: string): PwLocator;
};
type PwPage = {
  goto(url: string): Promise<{ status(): number } | null>;
  url(): string;
  on(ev: "dialog", fn: (d: { message(): string; accept(): Promise<void> }) => void): void;
  getByText(t: string): PwLocator;
  getByRole(role: "button", o: { name: string }): PwLocator;
  locator(sel: string, o?: { hasText?: string }): PwLocator;
  reload(): Promise<unknown>;
  goBack(): Promise<unknown>;
  waitForURL(re: RegExp): Promise<void>;
  content(): Promise<string>;
};
type PwContext = { newPage(): Promise<PwPage>; addCookies(c: { name: string; value: string; domain: string; path: string }[]): Promise<void>; close(): Promise<void> };
type PwChromium = { launch(): Promise<{ newContext(): Promise<PwContext>; close(): Promise<void> }> };

const BASE = process.env.E2E_BASE_URL ?? "http://localhost:3000";
const STRIPE_PORT = 12111;
const WEBHOOK_SECRET = "whsec_e2e_dummy";
const SYSTEM = { userId: null, role: "SYSTEM" as const };
const step = (msg: string) => console.log(`  ✓ ${msg}`);
const fakeStripe = createFakeStripe({ port: STRIPE_PORT, mode: "test", apiKey: "sk_test_e2e_dummy" });
const { ctl } = fakeStripe;

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
async function sessionFor(userId: string) {
  const token = randomToken(32);
  await fsdb().collection(C.authSessions).doc(sha256Hex(token)).set({ userId, expiresAt: new Date(Date.now() + 3600_000) });
  return token;
}
const signer = new Stripe("sk_test_e2e_dummy");
let evN = 0;
async function webhook(type: string, object: Record<string, unknown>) {
  const payload = JSON.stringify({ id: `evt_test_browser_${++evN}_${Date.now()}`, object: "event", type, livemode: false, data: { object } });
  const header = signer.webhooks.generateTestHeaderString({ payload, secret: WEBHOOK_SECRET });
  const r = await fetch(`${BASE}/api/webhooks/stripe`, { method: "POST", headers: { "stripe-signature": header, "content-type": "application/json" }, body: payload });
  assert.equal(r.status, 200, await r.clone().text());
  return ((await r.json()) as { outcome?: string }).outcome;
}

/** 運営のテスト決済：注文 → 決済画面 → 支払い → 確定 →（refundFailed なら）返金の処理中 → 失敗（返金で止めた権利が「戻せる」状態） */
async function refundFailedPayment(op: Client, storeCode: string, opts: { refundFailed?: boolean } = {}) {
  op.jar.delete("fx_access");
  op.ip = `198.51.100.${Math.floor(Math.random() * 250) + 1}`;
  await op.req(`/s/${storeCode}`);
  let r = await op.req("/api/checkout", { method: "POST", json: { fortuneType: "ZODIAC" } });
  assert.equal(r.status, 201, await r.clone().text());
  const { checkoutId } = (await r.json()) as { checkoutId: string };
  r = await op.req("/api/checkout/stripe-session", { method: "POST", json: {} });
  assert.equal(r.status, 200, await r.clone().text());
  const sessionId = ((await r.json()) as { url: string }).url.split("/").pop()!;
  const pay = await ctl(`pay/${sessionId}`);
  assert.equal(await webhook("checkout.session.completed", { id: sessionId, object: "checkout.session" }), "confirmed");
  if (opts.refundFailed === false) {
    const [t0] = (await fsdb().collection(C.transactions).where("checkoutId", "==", checkoutId).get()).docs;
    return { txId: t0.id, checkoutId, charge: pay.charge! };
  }
  const rf = await ctl(`refund/${pay.charge}`, { status: "pending" });
  assert.equal(await webhook("refund.created", { id: rf.refund, object: "refund", charge: pay.charge }), "refund_pending");
  await ctl(`refund-status/${rf.refund}`, { status: "failed" });
  assert.equal(await webhook("refund.failed", { id: rf.refund, object: "refund", charge: pay.charge }), "refund_failed");
  const [t] = (await fsdb().collection(C.transactions).where("checkoutId", "==", checkoutId).get()).docs;
  return { txId: t.id, checkoutId, charge: pay.charge! };
}

async function main() {
  const host = process.env.FIRESTORE_EMULATOR_HOST ?? "";
  assert.match(host, /^(127\.0\.0\.1|localhost|\[::1\]):\d+$/, "FIRESTORE_EMULATOR_HOST（localhost の Emulator）が必要です");
  assert.match(process.env.FIREBASE_PROJECT_ID ?? "", /^demo-/, "FIREBASE_PROJECT_ID は demo- で始まる Emulator 用の ID にしてください");
  assert.equal(dataProvider(), "firestore");
  assert.match(BASE, /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/);
  // Playwright はこの環境に事前に入っているもの（NODE_PATH）を使う（プロジェクトの依存関係には追加しない）
  let chromium: PwChromium;
  try {
    ({ chromium } = createRequire(path.join(process.cwd(), "package.json"))("playwright") as { chromium: PwChromium });
  } catch {
    throw new Error("Playwright が見つかりません（このスクリプトは Playwright と Chromium が入った環境で実行してください）");
  }
  await fakeStripe.start();
  console.log(`Admin restore browser E2E against ${BASE} (emulator ${host} / ${process.env.FIREBASE_PROJECT_ID}, fake Stripe :${STRIPE_PORT})`);

  const stamp = Date.now();
  const store = await createStore({ name: `ブラウザ検証店舗 ${stamp}`, contactName: "", postalCode: "", address: "", phone: "", email: "" }, SYSTEM);
  const opId = await createOperator({ name: "ブラウザ運営", email: `browser-op-${stamp}@example.com`, password: "BrowserOperator123" });
  const staffId = await createStoreUser(store.id, { name: "店舗スタッフ", email: `browser-staff-${stamp}@example.com`, password: "BrowserStaff12345" }, SYSTEM);
  const op = new Client();
  op.jar.set("sid", await sessionFor(opId));
  const ok = await refundFailedPayment(op, store.storeCode); // 戻せる決済
  const blocked = await refundFailedPayment(op, store.storeCode); // 異議申し立ての対応中で戻せない決済
  const dp = await ctl(`dispute/${blocked.charge}`);
  assert.equal(await webhook("charge.dispute.created", { id: dp.dispute, object: "dispute" }), "dispute_open");
  // 異議申し立てで敗訴した決済（「異議申し立ての確認」の「確認済みにする」の確認用）
  const lost = await refundFailedPayment(op, store.storeCode, { refundFailed: false }); // 返金なし（返金の確認の一覧には出さない）
  const dpLost = await ctl(`dispute/${lost.charge}`, { status: "lost" });
  assert.equal(await webhook("charge.dispute.created", { id: dpLost.dispute, object: "dispute" }), "dispute_lost");

  const browser = await chromium.launch();
  try {
    // ---- 1. 権限：店舗アカウントは 404、ログインなしはログイン画面へ（サーバーで確認） ----
    const anonCtx = await browser.newContext();
    const anon = await anonCtx.newPage();
    await anon.goto(`${BASE}/admin/transactions`);
    assert.match(anon.url(), /\/admin\/login/, `ログインなしでログイン画面に移動しません: ${anon.url()}`);
    await anonCtx.close();
    const staffCtx = await browser.newContext();
    await staffCtx.addCookies([{ name: "sid", value: await sessionFor(staffId), domain: "localhost", path: "/" }]);
    const staffRes = await (await staffCtx.newPage()).goto(`${BASE}/admin/transactions`);
    assert.equal(staffRes?.status(), 404, "店舗アカウントで運営の決済履歴が開けました");
    await staffCtx.close();
    step("権限：ログインなしはログイン画面へ、店舗アカウントは 404（運営の決済履歴を開けない）");

    // ---- 2. 運営：戻せない決済には理由を表示（入力欄なし）、戻せる決済には理由の入力欄 ----
    const ctx = await browser.newContext();
    await ctx.addCookies([{ name: "sid", value: await sessionFor(opId), domain: "localhost", path: "/" }]);
    const page = await ctx.newPage();
    const dialogs: string[] = [];
    page.on("dialog", (d) => {
      dialogs.push(d.message());
      void d.accept();
    });
    await page.goto(`${BASE}/admin/transactions`);
    await page.getByText("返金の確認が必要な決済").waitFor();
    const blockedNote = page.locator('[data-restore-blocked="dispute_open"]');
    assert.equal(await blockedNote.count(), 1, "異議申し立ての対応中の決済に、戻せない理由が表示されていません");
    assert.match((await blockedNote.textContent()) ?? "", /異議申し立て（チャージバック）の対応中のため、戻せません/);
    const reason = page.locator('textarea[name="reason"]');
    assert.equal(await reason.count(), 1, "理由の入力欄が、戻せる決済の1件だけではありません");
    assert.equal(await reason.getAttribute("required"), "", "理由の入力欄が必須になっていません");
    assert.equal(await reason.getAttribute("maxlength"), "200");
    step("運営の決済履歴：異議申し立ての対応中の決済は戻せない理由を表示（入力欄なし）、戻せる決済には必須の理由の入力欄（200文字まで）");

    // ---- 3. 画面の制御を外して空の理由で送っても、サーバーで拒否する ----
    await reason.evaluate((el) => el.removeAttribute("required"));
    await page.getByRole("button", { name: "占い権利を戻す" }).click();
    await page.getByText("戻す理由を入力してください。").waitFor();
    assert.equal((await fsdb().collection(C.fortuneSessions).doc(ok.txId).get()).get("status"), "EXPIRED", "空の理由で権利が戻りました");
    step("画面の必須の制御を外して空の理由で送っても、サーバーで拒否（権利は止めたまま）");

    // ---- 4. 理由を入力して戻す（確認の画面で承認）→ 決済履歴の画面に移動し、上部に成功の通知。権利 PAID・注文 SUCCEEDED・監査ログ1件 ----
    const REASON = "返金が失敗したため、お客さまに確認して戻す（ブラウザ）";
    const NOTICE = "占い権利を復旧しました（有効期限は復旧時から24時間）";
    await reason.fill(REASON);
    await page.getByRole("button", { name: "占い権利を戻す" }).click();
    await page.waitForURL(/\/admin\/transactions\?notice=entitlement_restored$/);
    await page.getByText(NOTICE).waitFor();
    assert.ok(dialogs.some((m) => /占い権利を戻しますか/.test(m)), "確認の画面が出ませんでした");
    const auditsOf = async () => (await fsdb().collection(C.auditLogs).where("targetId", "==", ok.txId).where("action", "==", "stripe_test.entitlement_restored").get()).docs;
    const fs = await fsdb().collection(C.fortuneSessions).doc(ok.txId).get();
    const co = (await fsdb().collection(C.checkouts).doc(ok.checkoutId).get()).data()!;
    assert.deepEqual([fs.get("status"), fs.get("restoredBy"), co.status], ["PAID", opId, "SUCCEEDED"]);
    const audits = await auditsOf();
    assert.equal(audits.length, 1);
    assert.deepEqual([audits[0].get("actorUserId"), audits[0].get("after").reason], [opId, REASON]);
    // 戻した決済は一覧から消える（入力欄が無い）。通知・画面に決済ID・理由は出さない
    assert.equal(await page.locator('textarea[name="reason"]').count(), 0, "戻した決済が一覧に残っています");
    const html = await page.content();
    assert.ok(!html.includes(REASON), "理由が画面に表示されています");
    const noticeText = (await page.locator('[data-notice="entitlement_restored"]').textContent()) ?? "";
    assert.equal(noticeText.trim(), NOTICE);
    assert.ok(!noticeText.includes(ok.txId) && !/pi_|cs_|ch_/.test(noticeText), "通知に決済IDが含まれています");
    step("理由を入力し、確認の画面で承認して戻す：決済履歴の画面に移動して上部に成功の通知（決済ID・理由なし）。権利 PAID・注文 SUCCEEDED・監査ログ1件（運営・理由）。戻した決済は一覧から消える");

    // ---- 5. 再読み込み・戻る・同じ URL への再アクセスでは、復旧の処理は動かない（監査ログ1件のまま） ----
    await page.reload();
    await page.getByText(NOTICE).waitFor(); // 通知の表示だけ（固定の文言）
    await page.goBack();
    await page.goto(`${BASE}/admin/transactions?notice=entitlement_restored`);
    await page.getByText(NOTICE).waitFor();
    assert.equal((await auditsOf()).length, 1, "再読み込み・戻る・再アクセスで復旧が二重に実行されました");
    assert.equal((await fsdb().collection(C.fortuneSessions).doc(ok.txId).get()).get("restoredBy"), opId);
    // クエリだけでは何も起きない（別の決済の権利は止めたまま。通知は表示だけ）
    assert.equal((await fsdb().collection(C.fortuneSessions).doc(blocked.txId).get()).get("status"), "EXPIRED");
    step("再読み込み・戻る・同じ URL への再アクセスでは復旧の処理は動かない（監査ログ1件のまま）。クエリは通知の表示だけ");

    // ---- 6. 「確認済みにする」：対応中の異議申し立ては完了できない（ボタンの代わりに「結果待ち」） ----
    await page.goto(`${BASE}/admin/transactions`);
    const disputeSection = page.locator("section", { hasText: "異議申し立て（チャージバック）の確認が必要な決済" });
    // 対応中の決済（blocked）は完了の操作を出さない（完了できない理由は「結果待ち」）
    assert.ok((await disputeSection.getByText("結果待ち").count()) >= 1, "対応中の異議申し立てに「結果待ち」が表示されていません");
    assert.equal(await disputeSection.getByRole("button", { name: "確認済みにする" }).count(), 1, "完了できる異議申し立ての確認が、敗訴の1件だけではありません");
    step("異議申し立ての確認：対応中の決済は完了できない（「結果待ち」と表示・操作のボタンなし）。サーバーでも対応中なら完了せず理由を返す（単体テスト）");

    // ---- 7. 返金の確認を完了 → 決済履歴の画面に移動し、上部に通知。対象は一覧から消える。監査ログ1件 ----
    const auditCount = async (txId: string, action: string) => (await fsdb().collection(C.auditLogs).where("targetId", "==", txId).where("action", "==", action).get()).size;
    const refundSection = page.locator("section", { hasText: "返金の確認が必要な決済" });
    await refundSection.getByRole("button", { name: "確認済みにする" }).click();
    await page.waitForURL(/\/admin\/transactions\?notice=refund_reviewed$/);
    await page.getByText("返金の確認を完了しました").waitFor();
    assert.equal((await fsdb().collection(C.transactions).doc(blocked.txId).get()).get("refundNeedsReview"), false);
    assert.equal(await auditCount(blocked.txId, "stripe_test.refund_review_dismissed"), 1);
    assert.equal(await page.locator("section", { hasText: "返金の確認が必要な決済" }).count(), 0, "確認済みの決済が返金の確認の一覧に残っています");
    assert.equal(((await page.locator('[data-notice="refund_reviewed"]').textContent()) ?? "").trim(), "返金の確認を完了しました");
    step("返金の確認を完了：決済履歴の画面に移動して上部に「返金の確認を完了しました」。対象は一覧から消え、監査ログ1件");

    // ---- 8. 異議申し立て（敗訴）の確認を完了 → 通知・一覧から消える・監査ログ1件 ----
    await page.locator("section", { hasText: "異議申し立て（チャージバック）の確認が必要な決済" }).getByRole("button", { name: "確認済みにする" }).click();
    await page.waitForURL(/\/admin\/transactions\?notice=dispute_reviewed$/);
    await page.getByText("異議申し立ての確認を完了しました").waitFor();
    assert.equal((await fsdb().collection(C.transactions).doc(lost.txId).get()).get("disputeNeedsReview"), false);
    assert.equal(await auditCount(lost.txId, "stripe.dispute_review_dismissed"), 1);
    assert.equal(await page.locator("section", { hasText: "異議申し立て（チャージバック）の確認が必要な決済" }).getByRole("button", { name: "確認済みにする" }).count(), 0, "確認済みの異議申し立てが一覧に残っています");
    step("異議申し立て（敗訴）の確認を完了：上部に「異議申し立ての確認を完了しました」。対象は一覧から消え、監査ログ1件");

    // ---- 9. 再読み込み・戻る・同じ URL への再アクセスでは、確認の操作も復旧も再実行されない ----
    await page.reload();
    await page.getByText("異議申し立ての確認を完了しました").waitFor();
    await page.goBack();
    await page.goBack();
    for (const n of ["refund_reviewed", "dispute_reviewed", "entitlement_restored"]) await page.goto(`${BASE}/admin/transactions?notice=${n}`);
    await page.getByText("占い権利を復旧しました（有効期限は復旧時から24時間）").waitFor(); // 権利の復旧の通知も引き続き表示される
    assert.deepEqual(
      [await auditCount(blocked.txId, "stripe_test.refund_review_dismissed"), await auditCount(lost.txId, "stripe.dispute_review_dismissed"), (await auditsOf()).length],
      [1, 1, 1],
      "再読み込み・戻る・再アクセスで操作が再実行されました",
    );
    // 知らない値の通知は表示しない（クエリの値そのものも出さない）
    await page.goto(`${BASE}/admin/transactions?notice=%3Cb%3Ex%3C%2Fb%3E`);
    assert.equal(await page.locator("[data-notice]").count(), 0);
    step("再読み込み・戻る・同じ URL への再アクセスでは、確認の操作・復旧とも再実行されない（監査ログはそれぞれ1件のまま）。知らない通知の値は表示しない");

    // ---- 10. 決済要確認・決済監視の「確認済みにする」：未ログイン・店舗アカウントは画面を開けない ----
    const reviewA = `browser-review-a-${stamp}`;
    const reviewB = `browser-review-b-${stamp}`;
    const alertA = `browser-alert-a-${stamp}`;
    for (const o of [reviewA, reviewB]) await recordPaymentReview({ kind: "charge_mismatch", objectType: "charge", objectId: o, storeId: store.id, mismatches: ["amount"], livemode: false });
    await recordPaymentAlert({ kind: "refund_sync_failed", objectType: "event", objectId: alertA, eventType: "charge.refunded", mode: "test", errorName: "Error" });
    const docIdOf = async (col: string, objectId: string) => (await fsdb().collection(col).where("objectId", "==", objectId).get()).docs[0].id;
    const reviewAId = await docIdOf(C.paymentReviews, reviewA);
    const reviewBId = await docIdOf(C.paymentReviews, reviewB);
    const alertAId = await docIdOf(C.paymentAlerts, alertA);
    const audit = async (action: string, targetId: string) => (await fsdb().collection(C.auditLogs).where("targetId", "==", targetId).where("action", "==", action).get()).size;
    for (const path of ["/admin/payment-reviews", "/admin/payment-monitor", "/admin/webhook-events"]) {
      const a = await browser.newContext();
      const ap = await a.newPage();
      await ap.goto(`${BASE}${path}`);
      assert.match(ap.url(), /\/admin\/login/, `ログインなしで ${path} が開けました`);
      await a.close();
      const st = await browser.newContext();
      await st.addCookies([{ name: "sid", value: await sessionFor(staffId), domain: "localhost", path: "/" }]);
      assert.equal((await (await st.newPage()).goto(`${BASE}${path}`))?.status(), 404, `店舗アカウントで ${path} が開けました`);
      await st.close();
    }
    step("決済要確認・決済監視・Webhook の復旧：ログインなしはログイン画面へ、店舗アカウントは 404（確認済みにする操作もできない。サーバーの処理の権限は単体テストでも確認）");

    // ---- 11. 決済要確認：未確認の一覧（既定）と、すべての一覧（status=all）でそれぞれ確認済みにする ----
    await page.goto(`${BASE}/admin/payment-reviews`);
    await page.locator("tr", { hasText: reviewA }).getByRole("button", { name: "確認済みにする" }).click();
    await page.waitForURL(/\/admin\/payment-reviews\?notice=review_resolved$/);
    await page.getByText("決済要確認を確認済みにしました").waitFor();
    assert.equal(await page.locator("tr", { hasText: reviewA }).count(), 0, "確認済みの決済要確認が未確認の一覧に残っています");
    assert.equal(await audit("payment_review.resolved", reviewAId), 1);
    // すべての一覧：絞り込みはそのまま（status=all）。行は「確認済み」として残る
    await page.goto(`${BASE}/admin/payment-reviews?status=all`);
    await page.locator("tr", { hasText: reviewB }).getByRole("button", { name: "確認済みにする" }).click();
    await page.waitForURL(/\/admin\/payment-reviews\?status=all&notice=review_resolved$/);
    await page.getByText("決済要確認を確認済みにしました").waitFor();
    assert.match((await page.locator("tr", { hasText: reviewB }).textContent()) ?? "", /確認済み/);
    assert.equal(await audit("payment_review.resolved", reviewBId), 1);
    const reviewNotice = ((await page.locator('[data-notice="review_resolved"]').textContent()) ?? "").trim();
    assert.equal(reviewNotice, "決済要確認を確認済みにしました");
    step("決済要確認を確認済みにする：上部に「決済要確認を確認済みにしました」。未確認の一覧から消え、すべての一覧（status=all）では絞り込みを保って「確認済み」。監査ログは各1件");

    // ---- 12. 決済監視：絞り込み（status=OPEN・mode=test）のまま確認済みにする ----
    await page.goto(`${BASE}/admin/payment-monitor?status=OPEN&mode=test`);
    await page.locator("tr", { hasText: alertA }).getByRole("button", { name: "確認済みにする" }).click();
    await page.waitForURL(/\/admin\/payment-monitor\?status=OPEN&mode=test&notice=alert_resolved$/);
    await page.getByText("決済監視の異常を確認済みにしました").waitFor();
    assert.equal(await page.locator("tr", { hasText: alertA }).count(), 0, "確認済みの異常が未確認の一覧に残っています");
    assert.equal(await audit("payment_alert.resolved", alertAId), 1);
    assert.equal(((await page.locator('[data-notice="alert_resolved"]').textContent()) ?? "").trim(), "決済監視の異常を確認済みにしました");
    // 再読み込み・戻る・同じ URL への再アクセスでは再実行されない
    await page.reload();
    await page.getByText("決済監視の異常を確認済みにしました").waitFor();
    await page.goBack();
    await page.goto(`${BASE}/admin/payment-monitor?status=OPEN&mode=test&notice=alert_resolved`);
    await page.goto(`${BASE}/admin/payment-reviews?notice=review_resolved`);
    await page.getByText("決済要確認を確認済みにしました").waitFor();
    assert.deepEqual([await audit("payment_review.resolved", reviewAId), await audit("payment_review.resolved", reviewBId), await audit("payment_alert.resolved", alertAId)], [1, 1, 1], "再読み込み・戻る・再アクセスで確認の操作が再実行されました");
    // 知らない通知の値は表示しない
    await page.goto(`${BASE}/admin/payment-monitor?notice=%3Cb%3Ex%3C%2Fb%3E`);
    assert.equal(await page.locator("[data-notice]").count(), 0);
    step("決済監視の異常を確認済みにする：絞り込み（status=OPEN・mode=test）を保って上部に「決済監視の異常を確認済みにしました」。未確認の一覧から消え、監査ログ1件。再読み込み・戻る・再アクセスでは再実行されない");

    // ---- 13. Webhook の復旧：失敗した通知を一覧に表示し、運営が ID で再処理する（Stripe から取り直して処理。結果を表示・監査ログ） ----
    {
      const evId = `evt_browser_rcv_${stamp}`;
      fakeStripe.fake.events.set(evId, { id: evId, object: "event", type: "customer.created", livemode: false, created: Math.floor(Date.now() / 1000), data: { object: { id: "cus_browser", object: "customer" } } });
      const lease = await acquireWebhookEventLease("stripe", evId, "customer.created", { objectId: "cus_browser", chargeId: null, livemode: false, eventCreatedAt: new Date() });
      await recordWebhookEventFailure("stripe", evId, "SimulatedFailure", (lease as { token: string }).token);
      await page.goto(`${BASE}/admin/webhook-events`);
      const row = page.locator(`tr[data-webhook-event="${evId}"]`);
      assert.equal(await row.getAttribute("data-webhook-state"), "RETRYABLE");
      await row.getByRole("button", { name: "再処理" }).click();
      await page.waitForURL(/\/admin\/webhook-events\?notice=recovered$/);
      assert.equal(((await page.locator('[data-notice="webhook_recovered"]').textContent()) ?? "").trim(), "再処理して処理済みにしました");
      const d = (await fsdb().collection(C.webhookEvents).doc(`stripe_${evId}`).get()).data()!;
      assert.deepEqual([d.state, Boolean(d.processedAt), d.recoveryAttempts, d.lastRecoveryResult], ["PROCESSED", true, 1, "recovered"]);
      assert.equal(await audit("webhook_event.recover", evId), 1);
      assert.equal(await page.locator(`tr[data-webhook-event="${evId}"]`).count(), 0, "処理済みの通知が一覧に残っています");
      // 再読み込みでは再実行されない。知らない通知の値は表示しない
      await page.reload();
      assert.equal(await audit("webhook_event.recover", evId), 1, "再読み込みで再処理されました");
      await page.goto(`${BASE}/admin/webhook-events?notice=%3Cb%3Ex%3C%2Fb%3E`);
      assert.equal(await page.locator("[data-notice]").count(), 0);
      await fsdb().collection(C.webhookEvents).doc(`stripe_${evId}`).delete(); // 次の実行に残さない
      step("Webhook の復旧：失敗した通知が一覧に出て、運営の「再処理」で Stripe から取り直して処理済み（上部に結果・監査ログ1件）。処理済みは一覧から消え、再読み込みでは再実行されない");
    }
    await ctx.close();
  } finally {
    await browser.close();
    // 次の実行に残さない（失敗したときも）
    const OPR = { userId: opId, role: "OPERATOR" as const };
    for (const id of [ok.txId, blocked.txId]) await dismissStripeRefundReview(id, OPR).catch(() => false);
    await dismissStripeDisputeReview(lost.txId, OPR).catch(() => "not_found");
    // 対応中のままの異議申し立ては確認を終えられないので、Stripe（模擬）で勝訴にして反映する（勝訴は確認が不要）
    await ctl(`dispute-status/${dp.dispute}`, { status: "won" }).catch(() => null);
    await webhook("charge.dispute.closed", { id: dp.dispute, object: "dispute" }).catch(() => null);
  }
  console.log("\nADMIN RESTORE BROWSER E2E PASSED");
}

main()
  .then(async () => {
    await fakeStripe.stop();
    process.exit(0);
  })
  .catch(async (e) => {
    console.error("\nADMIN RESTORE BROWSER E2E FAILED:", e);
    await fakeStripe.stop().catch(() => {});
    process.exit(1);
  });
