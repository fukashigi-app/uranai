/**
 * 決済記録の再確認が終わっていない決済記録（recheckState=PENDING）の運営画面の、ブラウザ（Chromium・Playwright）での E2E 検証。
 *  - 一覧（Webhook の復旧の画面）：状態の区別（自動の回収の対象・上限で終了・拒否・途中で停止・作成の直後）、最後の自動の回収の結果、ページ送り
 *  - 決済監視の画面：PENDING の異常の区別と、一覧への案内
 *  - 手動の再確認：確認の画面 → 完了の表示・一覧から消える・監査ログ1件（再読み込みで再実行しない）。
 *    実行中の印がある・Stripe の例外のときは、画面に理由を出し、決済記録は PENDING のまま
 *  - 権限：ログインなしはログイン画面へ、店舗アカウントは 404
 * Firestore Emulator の demo- プロジェクトと、このスクリプトが起動する Stripe API の模擬サーバー（localhost・テストモード）だけを使う。
 * 本物の Stripe・本番の Firebase には一切接続しない。キーはすべて形だけの偽物。専用のプロジェクトで実行する。
 *
 *   firebase emulators:start --only firestore --project demo-uranai
 *   （別ターミナル）npm run build && FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 FIREBASE_PROJECT_ID=demo-uranai-recheck-browser DB_PROVIDER=firestore \
 *       SITE_STATUS=development PAYMENT_PROVIDER=stripe ENABLE_TEST_PAYMENT=false ALLOW_MOCK_PAYMENTS_IN_PRODUCTION=false \
 *       STRIPE_TEST_CHECKOUT=on STRIPE_SECRET_KEY=sk_test_e2e_dummy STRIPE_WEBHOOK_SECRET=whsec_e2e_dummy \
 *       STRIPE_API_BASE=http://127.0.0.1:12111 CRON_SECRET=<ローカルの任意の値> npx next start
 *   （別ターミナル）FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 FIREBASE_PROJECT_ID=demo-uranai-recheck-browser CRON_SECRET=<同じ値> npm run e2e:recheck-recovery-browser
 */
import "dotenv/config";
import assert from "node:assert/strict";
import Stripe from "stripe";
import { createRequire } from "node:module";
import path from "node:path";
import { createFakeStripe } from "./lib/fake-stripe";
import { C, fsdb } from "@/lib/firestore/admin";
import { dataProvider } from "@/lib/data-provider";
import { createOperator, createStore, createStoreUser } from "@/lib/services/stores";
import { randomToken, sha256Hex } from "@/lib/security/crypto";
import { runPaymentMonitor } from "@/lib/payments/payment-monitor";
import { PENDING_RECHECK_STATUS_LABEL } from "@/lib/payments/recheck-recovery-rules";

// 使う範囲の Playwright の型（プロジェクトの依存関係に入れないため、ここで最小限だけ定義する）
type PwLocator = {
  count(): Promise<number>;
  textContent(): Promise<string | null>;
  getAttribute(n: string): Promise<string | null>;
  click(): Promise<void>;
  waitFor(o?: { timeout?: number; state?: "attached" | "detached" | "visible" | "hidden" }): Promise<void>;
  getByRole(role: "button" | "link", o: { name: string }): PwLocator;
  getByText(t: string): PwLocator;
  locator(sel: string): PwLocator;
  first(): PwLocator;
};
type PwPage = {
  goto(url: string): Promise<{ status(): number } | null>;
  url(): string;
  on(ev: "dialog", fn: (d: { message(): string; accept(): Promise<void> }) => void): void;
  getByText(t: string): PwLocator;
  getByRole(role: "button" | "link", o: { name: string }): PwLocator;
  locator(sel: string, o?: { hasText?: string }): PwLocator;
  reload(): Promise<unknown>;
  waitForURL(re: RegExp): Promise<void>;
};
type PwContext = { newPage(): Promise<PwPage>; addCookies(c: { name: string; value: string; domain: string; path: string }[]): Promise<void>; close(): Promise<void> };
type PwChromium = { launch(): Promise<{ newContext(): Promise<PwContext>; close(): Promise<void> }> };

const BASE = process.env.E2E_BASE_URL ?? "http://localhost:3000";
const STRIPE_PORT = 12111;
const WEBHOOK_SECRET = "whsec_e2e_dummy";
const SYSTEM = { userId: null, role: "SYSTEM" as const };
const HOUR = 60 * 60 * 1000;
const step = (msg: string) => console.log(`  ✓ ${msg}`);
const fakeStripe = createFakeStripe({ port: STRIPE_PORT, mode: "test", apiKey: "sk_test_e2e_dummy" });
const { ctl, fake } = fakeStripe;

class Client {
  jar = new Map<string, string>();
  ip = `198.51.100.${Math.floor(Math.random() * 250) + 1}`;
  async req(p: string, init: RequestInit & { json?: unknown } = {}) {
    const headers = new Headers(init.headers);
    headers.set("cookie", [...this.jar].map(([k, v]) => `${k}=${v}`).join("; "));
    headers.set("x-real-ip", this.ip);
    if (init.method === "POST" && !headers.has("origin")) headers.set("origin", BASE);
    if (init.json !== undefined) {
      headers.set("content-type", "application/json");
      init.body = JSON.stringify(init.json);
    }
    const res = await fetch(BASE + p, { ...init, headers, redirect: "manual" });
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
async function webhookStatus(type: string, object: Record<string, unknown>) {
  const payload = JSON.stringify({ id: `evt_test_rrb_${++evN}_${Date.now()}`, object: "event", type, livemode: false, data: { object } });
  const header = signer.webhooks.generateTestHeaderString({ payload, secret: WEBHOOK_SECRET });
  const r = await fetch(`${BASE}/api/webhooks/stripe`, { method: "POST", headers: { "stripe-signature": header, "content-type": "application/json" }, body: payload });
  return r.status;
}

/** 運営のテスト決済：注文 → 決済画面 → 支払い → 確定（作成の後の再確認だけが失敗して PENDING） */
async function pendingPayment(op: Client, storeCode: string) {
  op.jar.delete("fx_access");
  op.ip = `198.51.100.${Math.floor(Math.random() * 250) + 1}`;
  await op.req(`/s/${storeCode}`);
  let r = await op.req("/api/checkout", { method: "POST", json: { fortuneType: "ZODIAC" } });
  assert.equal(r.status, 201, await r.clone().text());
  const { checkoutId } = (await r.json()) as { checkoutId: string };
  r = await op.req("/api/checkout/stripe-session", { method: "POST", json: {} });
  assert.equal(r.status, 200, await r.clone().text());
  const sessionId = ((await r.json()) as { url: string }).url.split("/").pop()!;
  await ctl(`pay/${sessionId}`);
  fake.failCalls.push({ path: /^\/v1\/refunds$/, method: "GET", skip: 1, count: 1 });
  assert.equal(await webhookStatus("checkout.session.completed", { id: sessionId, object: "checkout.session" }), 500, "（前提）再確認の失敗で 500 になりません");
  const [t] = (await fsdb().collection(C.transactions).where("checkoutId", "==", checkoutId).get()).docs;
  assert.equal(t.get("recheckState"), "PENDING");
  return { txId: t.id, sessionId };
}
const txOf = async (id: string) => (await fsdb().collection(C.transactions).doc(id).get()).data()!;
const audits = async (txId: string) => (await fsdb().collection(C.auditLogs).where("targetId", "==", txId).get()).docs.map((d) => d.data()).filter((d) => d.action === "transaction.recheck");

async function main() {
  const host = process.env.FIRESTORE_EMULATOR_HOST ?? "";
  assert.match(host, /^(127\.0\.0\.1|localhost|\[::1\]):\d+$/, "FIRESTORE_EMULATOR_HOST（localhost の Emulator）が必要です");
  assert.match(process.env.FIREBASE_PROJECT_ID ?? "", /^demo-/, "FIREBASE_PROJECT_ID は demo- で始まる Emulator 用の ID にしてください");
  assert.equal(dataProvider(), "firestore");
  assert.match(BASE, /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/);
  const cronSecret = process.env.CRON_SECRET ?? "";
  assert.ok(cronSecret.length >= 16, "CRON_SECRET（サーバーと同じローカルの値）が必要です");
  let chromium: PwChromium;
  try {
    ({ chromium } = createRequire(path.join(process.cwd(), "package.json"))("playwright") as { chromium: PwChromium });
  } catch {
    throw new Error("Playwright が見つかりません（このスクリプトは Playwright と Chromium が入った環境で実行してください）");
  }
  await fakeStripe.start();
  console.log(`Recheck recovery browser E2E against ${BASE} (emulator ${host} / ${process.env.FIREBASE_PROJECT_ID}, fake Stripe :${STRIPE_PORT})`);
  const stamp = Date.now();
  const store = await createStore({ name: `再確認ブラウザ店舗 ${stamp}`, contactName: "", postalCode: "", address: "", phone: "", email: "" }, SYSTEM);
  const opId = await createOperator({ name: "再確認ブラウザ運営", email: `recheck-op-${stamp}@example.com`, password: "RecheckOperator123" });
  const staffId = await createStoreUser(store.id, { name: "店舗スタッフ", email: `recheck-staff-${stamp}@example.com`, password: "RecheckStaff12345" }, SYSTEM);
  const op = new Client();
  op.jar.set("sid", await sessionFor(opId));

  // 状態の異なる PENDING の決済記録（作成の直後の E 以外は、作成から2時間たったことにする）
  const A = await pendingPayment(op, store.storeCode); // 自動の回収の対象（前回の試行はエラー・間隔待ち）
  const B = await pendingPayment(op, store.storeCode); // 自動の回収が上限の回数で終了
  const Cx = await pendingPayment(op, store.storeCode); // 確定の処理が拒否（運営の確認が必要）
  const D = await pendingPayment(op, store.storeCode); // 自動の回収の試行が途中で停止
  const E = await pendingPayment(op, store.storeCode); // 作成の直後
  const ago = (ms: number) => new Date(Date.now() - ms);
  const upd = (id: string, data: Record<string, unknown>) => fsdb().collection(C.transactions).doc(id).update(data);
  await upd(A.txId, { createdAt: ago(2 * HOUR), recheckRecoveryAttempts: 1, recheckRecoveryLastAt: ago(HOUR), recheckRecoveryLastResult: "error", recheckRecoveryLastError: "Error" });
  await upd(B.txId, { createdAt: ago(2 * HOUR), recheckRecoveryAttempts: 6, recheckRecoveryLastAt: ago(HOUR), recheckRecoveryLastResult: "error", recheckRecoveryLastError: "Error" });
  await upd(Cx.txId, { createdAt: ago(2 * HOUR), recheckRecoveryAttempts: 1, recheckRecoveryLastAt: ago(HOUR), recheckRecoveryLastResult: "rejected", recheckRecoveryLastError: "payment_intent_mismatch" });
  await upd(D.txId, { createdAt: ago(3 * HOUR), recheckRecoveryAttempts: 1, recheckRecoveryLastAt: ago(2 * HOUR), recheckRecoveryLastResult: "started", recheckRecoveryLastError: null });

  // 定期処理（サーバーの /api/cron/maintenance）：すべて対象外（間隔待ち・上限・作成の直後）なので試行は0件、実行の記録が残る
  const cr = await fetch(`${BASE}/api/cron/maintenance`, { headers: { authorization: `Bearer ${cronSecret}` } });
  assert.equal(cr.status, 200, await cr.clone().text());
  const rr = ((await cr.json()) as { recheckRecovery: { status: string; scanned: number; attempted: number } }).recheckRecovery;
  assert.deepEqual([rr.status, rr.scanned, rr.attempted], ["completed", 5, 0], JSON.stringify(rr));
  assert.equal((await fetch(`${BASE}/api/cron/maintenance`)).status, 401);
  // 決済監視の点検（このプロセスから。Stripe の点検は行わない）
  const mon = await runPaymentMonitor({ rt: null });
  assert.ok(mon.started);

  const browser = await chromium.launch();
  try {
    // ---- 1. 権限 ----
    const anonCtx = await browser.newContext();
    const anon = await anonCtx.newPage();
    await anon.goto(`${BASE}/admin/webhook-events`);
    assert.match(anon.url(), /\/admin\/login/, `ログインなしでログイン画面に移動しません: ${anon.url()}`);
    await anonCtx.close();
    const staffCtx = await browser.newContext();
    await staffCtx.addCookies([{ name: "sid", value: await sessionFor(staffId), domain: "localhost", path: "/" }]);
    assert.equal((await (await staffCtx.newPage()).goto(`${BASE}/admin/webhook-events`))?.status(), 404, "店舗アカウントで運営の画面が開けました");
    await staffCtx.close();
    step("権限：ログインなしはログイン画面へ、店舗アカウントは 404（PENDING の一覧・手動の再確認を開けない）");

    const ctx = await browser.newContext();
    await ctx.addCookies([{ name: "sid", value: await sessionFor(opId), domain: "localhost", path: "/" }]);
    const page = await ctx.newPage();
    const dialogs: string[] = [];
    page.on("dialog", (d) => {
      dialogs.push(d.message());
      void d.accept();
    });

    // ---- 2. 決済監視の画面：PENDING の異常の区別と一覧への案内 ----
    await page.goto(`${BASE}/admin/payment-monitor`);
    await page.getByText("決済監視").first().waitFor();
    for (const st of ["pending", "exhausted", "rejected", "stalled"] as const) {
      const el = page.locator(`[data-recheck-status="${st}"]`);
      assert.equal(await el.count(), 1, `決済監視に ${st} の PENDING が1件表示されていません`);
      assert.equal((await el.textContent())?.trim(), PENDING_RECHECK_STATUS_LABEL[st]);
    }
    assert.ok((await page.locator('a[href="/admin/webhook-events#pending-rechecks"]').count()) >= 4, "決済監視から PENDING の一覧への案内がありません");
    step("決済監視の画面：作成から60分を過ぎた PENDING を「自動の回収の対象・上限で終了・拒否・途中で停止」に区別して表示し、一覧へ案内（作成の直後は異常にしない）");

    // ---- 3. 一覧：状態の区別・最後の自動の回収の結果・操作の可否 ----
    await page.goto(`${BASE}/admin/webhook-events#pending-rechecks`);
    await page.getByText("決済の確定の後の再確認").first().waitFor();
    const row = (id: string) => page.locator(`[data-pending-recheck="${id}"]`);
    const expected: [string, string][] = [[A.txId, "pending"], [B.txId, "exhausted"], [Cx.txId, "rejected"], [D.txId, "stalled"], [E.txId, "recent"]];
    for (const [id, st] of expected) {
      assert.equal(await row(id).count(), 1, `${st} の決済記録が一覧にありません`);
      assert.equal(await row(id).getAttribute("data-recheck-status"), st);
    }
    assert.match((await row(A.txId).textContent()) ?? "", /自動の回収の間隔待ち/);
    assert.match((await row(B.txId).textContent()) ?? "", /6／6回/);
    assert.match((await row(Cx.txId).textContent()) ?? "", /理由：payment_intent_mismatch/);
    assert.match((await row(D.txId).textContent()) ?? "", /実行中（または途中で停止）/);
    assert.match((await row(E.txId).textContent()) ?? "", /作成の直後のため、まだ再確認しません/);
    assert.equal(await row(E.txId).getByRole("button", { name: "再確認" }).count(), 0, "作成の直後の決済記録に再確認のボタンがあります");
    for (const id of [A.txId, B.txId, Cx.txId, D.txId]) assert.equal(await row(id).getByRole("button", { name: "再確認" }).count(), 1);
    const last = page.locator("[data-recheck-recovery-last]");
    assert.equal(await last.getAttribute("data-recheck-recovery-last"), "completed");
    assert.match((await last.textContent()) ?? "", /最後の自動の回収：.*完了・読んだ 5件・試行 0件（完了 0・未完了 0・拒否 0・エラー 0）/);
    step("一覧：状態（対象・上限で終了・拒否・途中で停止・作成の直後）を区別し、最後の自動の回収（定期処理の結果）を表示。作成の直後は再確認のボタンを出さず理由を表示");

    // ---- 4. 手動の再確認：確認の画面 → 完了の表示・一覧から消える・監査ログ1件 ----
    await row(A.txId).getByRole("button", { name: "再確認" }).click();
    await page.waitForURL(/[?&]recheck=done/);
    await page.locator('[data-notice="recheck_done"]').waitFor();
    assert.ok(dialogs.some((m) => m.includes(A.txId) && m.includes("再確認しますか")), "確認の画面が出ていません");
    assert.equal(await row(A.txId).count(), 0, "完了した決済記録が一覧に残っています");
    let t = await txOf(A.txId);
    assert.deepEqual([t.recheckState, t.recheckManualLastBy, t.recheckManualLastResult, t.recheckManualToken, t.recheckManualUntil], ["DONE", opId, "done", null, null]);
    let au = await audits(A.txId);
    assert.equal(au.length, 1);
    assert.deepEqual([au[0].actorUserId, au[0].actorRole, au[0].targetType, au[0].before.recheckState, au[0].after.result, au[0].after.recheckState], [opId, "OPERATOR", "transaction", "PENDING", "done", "DONE"]);
    await page.reload();
    await page.locator('[data-notice="recheck_done"]').waitFor();
    assert.equal((await audits(A.txId)).length, 1, "再読み込みで再確認が再実行されました");
    step("手動の再確認：確認の画面で承認 → 上部に「再確認が完了しました」・一覧から消える・実行者と前後の状態の監査ログ1件（再読み込みで再実行しない）");

    // ---- 5. 実行中の印（ほかの運営が実行中）：画面に理由を出し、何もしない ----
    await page.goto(`${BASE}/admin/webhook-events#pending-rechecks`);
    await row(B.txId).waitFor();
    await upd(B.txId, { recheckManualUntil: new Date(Date.now() + 5 * 60_000), recheckManualToken: "other-operator" });
    await row(B.txId).getByRole("button", { name: "再確認" }).click();
    await row(B.txId).getByText("ほかの運営の再確認を実行中です（何もしていません）。").waitFor();
    t = await txOf(B.txId);
    assert.deepEqual([t.recheckState, t.recheckManualToken, t.recheckManualLastBy ?? null], ["PENDING", "other-operator", null]);
    assert.equal((await audits(B.txId)).length, 0, "開始しなかった再確認の監査ログがあります");
    // 印が外れれば、上限の回数に達した記録も運営は再確認できる
    await upd(B.txId, { recheckManualUntil: null, recheckManualToken: null });
    await page.reload();
    await row(B.txId).getByRole("button", { name: "再確認" }).click();
    await page.waitForURL(/[?&]recheck=done/);
    assert.equal((await txOf(B.txId)).recheckState, "DONE");
    assert.equal((await audits(B.txId)).length, 1);
    step("ほかの運営の実行中は画面に理由を出して何もしない（監査ログなし）。印が外れれば、自動の回収が上限で終了した記録も手動で再確認して完了");

    // ---- 6. Stripe の例外：画面に失敗を出し、PENDING のまま・監査ログに結果 ----
    await page.goto(`${BASE}/admin/webhook-events#pending-rechecks`);
    await row(Cx.txId).waitFor();
    fake.failCalls.push({ path: new RegExp(`^/v1/checkout/sessions/${Cx.sessionId}$`), method: "GET", skip: 0, count: 1 });
    await row(Cx.txId).getByRole("button", { name: "再確認" }).click();
    await row(Cx.txId).getByText("再確認に失敗しました（Stripe・データベースの一時的なエラーの可能性。PENDING のままです）。（Error）").waitFor();
    t = await txOf(Cx.txId);
    assert.deepEqual([t.recheckState, t.recheckManualLastResult, t.recheckManualLastError, t.recheckManualToken], ["PENDING", "error", "Error", null]);
    au = await audits(Cx.txId);
    assert.deepEqual([au.length, au[0]?.after.result, au[0]?.after.recheckState], [1, "error", "PENDING"]);
    step("Stripe の例外：画面に失敗の理由を出し、PENDING のまま（実行中の印は外れる）。監査ログに結果（error）を残す");

    // ---- 7. ページ送り（20件ずつ） ----
    for (let i = 0; i < 20; i++) {
      await fsdb()
        .collection(C.transactions)
        .doc(`stripe_pi_zz_page_${String(i).padStart(2, "0")}`)
        .set({ paymentProvider: "stripe", recheckState: "PENDING", livemode: false, createdAt: ago(2 * HOUR), stripeCheckoutSessionId: `cs_test_page${i}`, stripePaymentIntentId: `pi_test_page${i}`, paymentStatus: "SUCCEEDED" });
    }
    await page.goto(`${BASE}/admin/webhook-events?page=1#pending-rechecks`); // 同じ URL への移動は再読み込みにならないので、別の URL にする
    await page.locator("[data-pending-recheck]").first().waitFor();
    assert.equal(await page.locator("[data-pending-recheck]").count(), 20);
    await page.getByRole("link", { name: "次の20件" }).click();
    await page.waitForURL(/rcursor=/);
    await page.getByRole("link", { name: "最初から" }).waitFor();
    assert.equal(await page.locator("[data-pending-recheck]").count(), 3, "2ページ目の件数が違います（PENDING は C・D・E と20件の合計23件）");
    step("一覧のページ送り：20件ずつ（次の20件・最初から）");
    await ctx.close();
  } finally {
    await browser.close();
  }
  console.log("\nRECHECK RECOVERY BROWSER E2E PASSED");
}

main()
  .then(async () => {
    await fakeStripe.stop();
    process.exit(0);
  })
  .catch(async (e) => {
    console.error("\nRECHECK RECOVERY BROWSER E2E FAILED:", e);
    await fakeStripe.stop().catch(() => {});
    process.exit(1);
  });
