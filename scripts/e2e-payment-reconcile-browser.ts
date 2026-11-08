/**
 * 決済照合（F2 第1段階）の運営画面のブラウザ E2E（Playwright）。
 * 本物の Stripe・本番の Firebase には接続しない（localhost の模擬 Stripe（テストモード）と Firestore Emulator の demo- プロジェクトだけ）。
 *
 *  1. 権限：ログインなしはログイン画面へ・店舗アカウントは 404・API はログインなしで 404
 *  2. 運営：「照合する」で結果を表示（異常あり・注文が無い決済の ID・要確認の決済）。個人情報（メール）・client_secret を表示しない
 *  3. 監査ログが実行ごとに1件。照合で決済・注文・取引は変わらない
 *
 *   サーバー：STRIPE_API_BASE=http://127.0.0.1:12111 などテストの接続の設定で npx next start（scripts/e2e-stripe.ts と同じ）
 *   E2E_BASE_URL=http://localhost:3000 FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 FIREBASE_PROJECT_ID=<サーバーと同じ demo- の ID> \
 *     npx tsx --conditions=react-server scripts/e2e-payment-reconcile-browser.ts
 */
import "dotenv/config";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import { createFakeStripe } from "./lib/fake-stripe";
import { C, fsdb } from "@/lib/firestore/admin";
import { dataProvider } from "@/lib/data-provider";
import { createOperator, createStore, createStoreUser } from "@/lib/services/stores";
import { randomToken, sha256Hex } from "@/lib/security/crypto";
import { stripeEnvTag } from "@/lib/payments/stripe-checkout";

type PwLocator = { count(): Promise<number>; click(): Promise<void>; waitFor(o?: { timeout?: number; state?: string }): Promise<void>; getAttribute(n: string): Promise<string | null> };
type PwPage = { goto(url: string): Promise<{ status(): number } | null>; url(): string; getByRole(role: "button", o: { name: string }): PwLocator; locator(sel: string): PwLocator; content(): Promise<string> };
type PwContext = { newPage(): Promise<PwPage>; addCookies(c: { name: string; value: string; domain: string; path: string }[]): Promise<void>; close(): Promise<void> };
type PwChromium = { launch(): Promise<{ newContext(): Promise<PwContext>; close(): Promise<void> }> };

const BASE = process.env.E2E_BASE_URL ?? "http://localhost:3000";
const STRIPE_PORT = 12111;
const SYSTEM = { userId: null, role: "SYSTEM" as const };
const step = (msg: string) => console.log(`  ✓ ${msg}`);
const fakeStripe = createFakeStripe({ port: STRIPE_PORT, mode: "test", apiKey: "sk_test_e2e_dummy" });

async function sessionFor(userId: string) {
  const token = randomToken(32);
  await fsdb().collection(C.authSessions).doc(sha256Hex(token)).set({ userId, expiresAt: new Date(Date.now() + 3600_000) });
  return token;
}

async function main() {
  const host = process.env.FIRESTORE_EMULATOR_HOST ?? "";
  assert.match(host, /^(127\.0\.0\.1|localhost|\[::1\]):\d+$/);
  const project = process.env.FIREBASE_PROJECT_ID ?? "";
  assert.match(project, /^demo-/);
  assert.equal(dataProvider(), "firestore");
  assert.match(BASE, /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/);
  let chromium: PwChromium;
  try {
    ({ chromium } = createRequire(path.join(process.cwd(), "package.json"))("playwright") as { chromium: PwChromium });
  } catch {
    throw new Error("Playwright が見つかりません");
  }
  await fakeStripe.start();
  console.log(`Payment reconcile browser E2E against ${BASE} (emulator ${host} / ${project}, fake Stripe test :${STRIPE_PORT})`);
  const stamp = Date.now();
  const store = await createStore({ name: `照合ブラウザ店舗 ${stamp}`, contactName: "", postalCode: "", address: "", phone: "", email: "" }, SYSTEM);
  const opId = await createOperator({ name: "照合運営", email: `rc-op-${stamp}@example.com`, password: "ReconcileOperator123" });
  const staffId = await createStoreUser(store.id, { name: "店舗", email: `rc-staff-${stamp}@example.com`, password: "ReconcileStaff12345" }, SYSTEM);
  const tag = stripeEnvTag(project);
  const old = Math.floor(Date.now() / 1000) - 2 * 3600;
  const lost = (await fakeStripe.ctl("raw-pi", { livemode: false, created: old, metadata: { checkoutId: `co_missing_${stamp}`, storeId: store.id, fortuneType: "ZODIAC", uranaiEnv: tag } })).paymentIntent!;
  const untagged = (await fakeStripe.ctl("raw-pi", { livemode: false, created: old, metadata: { checkoutId: `co_untagged_${stamp}` } })).paymentIntent!;
  const auditsBefore = (await fsdb().collection(C.auditLogs).where("action", "==", "payment_reconcile.run").get()).size;
  const checkoutsBefore = (await fsdb().collection(C.checkouts).get()).size;
  const txBefore = (await fsdb().collection(C.transactions).get()).size;

  assert.equal((await fetch(`${BASE}/api/admin/payment-reconcile`, { method: "POST", body: JSON.stringify({ action: "start", from: "2026-01-01", to: "2026-01-02" }) })).status, 404);
  const browser = await chromium.launch();
  try {
    const anonCtx = await browser.newContext();
    const anon = await anonCtx.newPage();
    await anon.goto(`${BASE}/admin/payment-reconcile`);
    assert.match(anon.url(), /\/admin\/login/);
    await anonCtx.close();
    const staffCtx = await browser.newContext();
    await staffCtx.addCookies([{ name: "sid", value: await sessionFor(staffId), domain: "localhost", path: "/" }]);
    assert.equal((await (await staffCtx.newPage()).goto(`${BASE}/admin/payment-reconcile`))?.status(), 404);
    await staffCtx.close();
    step("権限：ログインなしはログイン画面へ・店舗アカウントは 404・API はログインなしで 404");

    const ctx = await browser.newContext();
    await ctx.addCookies([{ name: "sid", value: await sessionFor(opId), domain: "localhost", path: "/" }]);
    const page = await ctx.newPage();
    assert.equal((await page.goto(`${BASE}/admin/payment-reconcile`))?.status(), 200);
    await page.getByRole("button", { name: "照合する（読み取りのみ）" }).click();
    const verdict = page.locator("[data-reconcile-verdict]");
    await verdict.waitFor({ timeout: 60_000 });
    assert.equal(await verdict.getAttribute("data-reconcile-verdict"), "issues");
    assert.ok((await page.locator('[data-reconcile-kind="stripe_paid_no_checkout"]').count()) >= 1);
    assert.equal(await page.locator('[data-reconcile-review="untagged"]').count(), 1);
    const html = await page.content();
    assert.ok(html.includes(lost) && html.includes(untagged), "異常・要確認の PaymentIntent の ID が表示されていません");
    for (const bad of ["buyer@example.com", "_secret_", "sk_test_e2e_dummy"]) assert.equal(html.includes(bad), false, `画面に ${bad} が表示されています`);
    step("運営：照合の結果（異常あり・注文が無い決済・要確認の決済の ID）を表示。メール・client_secret・キーは表示しない");

    const audits = await fsdb().collection(C.auditLogs).where("action", "==", "payment_reconcile.run").get();
    assert.equal(audits.size, auditsBefore + 1, "監査ログが実行ごとに1件ではありません");
    assert.equal((await fsdb().collection(C.checkouts).get()).size, checkoutsBefore);
    assert.equal((await fsdb().collection(C.transactions).get()).size, txBefore);
    const calls = fakeStripe.fake.callLog;
    assert.ok(calls.every((c) => c.startsWith("GET ")), `GET 以外の要求：${calls.join(",")}`);
    step("監査ログは1件・注文と取引の件数は不変・Stripe への要求は GET だけ");
    await ctx.close();
  } finally {
    await browser.close();
    await fakeStripe.stop();
  }
  console.log("\nPAYMENT RECONCILE BROWSER E2E PASSED");
}

main().catch((e) => {
  console.error("PAYMENT RECONCILE BROWSER E2E FAILED:", e);
  process.exit(1);
});
