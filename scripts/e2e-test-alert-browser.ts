/**
 * Sandbox v2 専用の「Discord のテスト異常の通知」の、ブラウザ（Chromium・Playwright）での E2E 検証。
 * Firestore Emulator と、外向きの通信を止める scripts/lib/outbound-guard.cjs（Discord への HTTP は送らずに記録し、模擬の応答を返す）だけを使う。
 * 本物の Discord・Stripe・Firebase には一切接続しない。Webhook の URL・トークンは形だけの偽物。
 *
 * アプリは Sandbox v2 の Preview と同じ形の環境変数で起動する（判定を通すため。接続先は Emulator だけ）：
 *   firebase emulators:start --only firestore --project demo-uranai
 *   （別ターミナル）npm run build && NODE_OPTIONS="--require ./scripts/lib/outbound-guard.cjs" \
 *       OUTBOUND_GUARD_LOG=/tmp/guard.log OUTBOUND_GUARD_DISCORD_STATUS_FILE=/tmp/guard-status OUTBOUND_GUARD_DISCORD_DELAY_MS=1500 \
 *       FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 DB_PROVIDER=firestore VERCEL_ENV=preview VERCEL_GIT_COMMIT_REF=preview/stripe-sandbox-v2 \
 *       FIREBASE_PROJECT_ID=uranai-stripe-sandbox-v2 PRODUCTION_FIREBASE_PROJECT_ID=uranai-b6edf \
 *       FIREBASE_CLIENT_EMAIL=e2e@uranai-stripe-sandbox-v2.iam.gserviceaccount.com APP_URL=http://localhost:3100 \
 *       SITE_STATUS=development OPS_ALERT_WEBHOOK_URL=https://discord.com/api/webhooks/<数字>/<偽のトークン> npx next start -p 3100
 *   （別ターミナル）FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 FIREBASE_PROJECT_ID=uranai-stripe-sandbox-v2 E2E_BASE_URL=http://localhost:3100 \
 *       OUTBOUND_GUARD_LOG=/tmp/guard.log OUTBOUND_GUARD_DISCORD_STATUS_FILE=/tmp/guard-status E2E_FAKE_WEBHOOK_TOKEN=<偽のトークン> \
 *       npm run e2e:test-alert-browser
 */
import "dotenv/config";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { C, fsdb } from "@/lib/firestore/admin";
import { dataProvider } from "@/lib/data-provider";
import { createOperator, createStore, createStoreUser } from "@/lib/services/stores";
import { randomToken, sha256Hex } from "@/lib/security/crypto";

type PwLocator = {
  count(): Promise<number>;
  textContent(): Promise<string | null>;
  isDisabled(): Promise<boolean>;
  evaluate(fn: (el: HTMLElement) => void): Promise<void>;
  click(): Promise<void>;
  waitFor(o?: { timeout?: number }): Promise<void>;
};
type PwDialog = { message(): string; accept(): Promise<void>; dismiss(): Promise<void> };
type PwPage = {
  goto(url: string): Promise<{ status(): number } | null>;
  url(): string;
  on(ev: "dialog", fn: (d: PwDialog) => void): void;
  getByText(t: string): PwLocator;
  getByRole(role: "button", o: { name: string }): PwLocator;
  locator(sel: string, o?: { hasText?: string }): PwLocator;
  content(): Promise<string>;
};
type PwContext = { newPage(): Promise<PwPage>; addCookies(c: { name: string; value: string; domain: string; path: string }[]): Promise<void>; close(): Promise<void> };
type PwChromium = { launch(): Promise<{ newContext(): Promise<PwContext>; close(): Promise<void> }> };

const BASE = process.env.E2E_BASE_URL ?? "http://localhost:3100";
const GUARD_LOG = process.env.OUTBOUND_GUARD_LOG ?? "";
const STATUS_FILE = process.env.OUTBOUND_GUARD_DISCORD_STATUS_FILE ?? "";
const FAKE_TOKEN = process.env.E2E_FAKE_WEBHOOK_TOKEN ?? "";
const HEADLINE = "【テスト異常】100円占い・決済の運用（Sandbox v2・テスト）";
const NOTICE = "これは運営者が実施したテスト通知です。実際の障害ではありません。対応は不要です。";
const SYSTEM = { userId: null, role: "SYSTEM" as const };
const step = (msg: string) => console.log(`  ✓ ${msg}`);

type GuardEntry = { kind: string; host?: string; path?: string; method?: string; redirect?: string; body?: string | null; status?: number };
const guardEntries = (): GuardEntry[] =>
  fs.existsSync(GUARD_LOG)
    ? fs
        .readFileSync(GUARD_LOG, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l) as GuardEntry)
    : [];
const discordSends = () => guardEntries().filter((e) => e.kind === "discord");

async function sessionFor(userId: string) {
  const token = randomToken(32);
  await fsdb().collection(C.authSessions).doc(sha256Hex(token)).set({ userId, expiresAt: new Date(Date.now() + 3600_000) });
  return token;
}
async function api(mode: unknown, o: { sid?: string; origin?: string } = {}) {
  const headers: Record<string, string> = { "content-type": "application/json", origin: o.origin ?? BASE };
  if (o.sid) headers.cookie = `sid=${o.sid}`;
  return fetch(`${BASE}/api/admin/test-alert`, { method: "POST", headers, body: JSON.stringify({ mode }), redirect: "manual" });
}
/** Emulator の全コレクションの件数と、system の全ドキュメントの中身（書き込みが無いことの確認用） */
async function snapshot() {
  const out: Record<string, unknown> = {};
  for (const col of await fsdb().listCollections()) out[col.id] = (await col.count().get()).data().count;
  const sys = await fsdb().collection("system").get();
  out.__system = Object.fromEntries(sys.docs.map((d) => [d.id, JSON.stringify(d.data())]));
  return out;
}

async function main() {
  // ---- 接続先・安全の確認（Emulator と localhost だけ。秘密鍵・本物の送信先は使わない）----
  assert.match(process.env.FIRESTORE_EMULATOR_HOST ?? "", /^(127\.0\.0\.1|localhost|\[::1\]):\d+$/, "FIRESTORE_EMULATOR_HOST（localhost の Emulator）が必要です");
  assert.ok(!process.env.FIREBASE_PRIVATE_KEY && !process.env.GOOGLE_APPLICATION_CREDENTIALS, "認証情報が設定されています（Emulator だけで実行してください）");
  assert.equal(dataProvider(), "firestore");
  assert.match(BASE, /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/, "E2E はローカルのアプリにだけ実行します");
  assert.ok(GUARD_LOG && STATUS_FILE && FAKE_TOKEN.length >= 60, "OUTBOUND_GUARD_LOG・OUTBOUND_GUARD_DISCORD_STATUS_FILE・E2E_FAKE_WEBHOOK_TOKEN が必要です");
  fs.writeFileSync(STATUS_FILE, "204");
  console.log(`Test alert browser E2E against ${BASE} (emulator ${process.env.FIRESTORE_EMULATOR_HOST} / ${process.env.FIREBASE_PROJECT_ID})`);

  let chromium: PwChromium;
  try {
    ({ chromium } = createRequire(path.join(process.cwd(), "package.json"))("playwright") as { chromium: PwChromium });
  } catch {
    throw new Error("Playwright が見つかりません");
  }

  const stamp = Date.now();
  const store = await createStore({ name: `テスト通知検証店舗 ${stamp}`, contactName: "", postalCode: "", address: "", phone: "", email: "" }, SYSTEM);
  const opA = await createOperator({ name: "テスト通知の運営A", email: `ta-op-a-${stamp}@example.com`, password: "TestAlertOperatorA1" });
  const opB = await createOperator({ name: "テスト通知の運営B", email: `ta-op-b-${stamp}@example.com`, password: "TestAlertOperatorB1" });
  const staff = await createStoreUser(store.id, { name: "店舗スタッフ", email: `ta-staff-${stamp}@example.com`, password: "TestAlertStaff12345" }, SYSTEM);
  const [sidA, sidB, sidStaff] = [await sessionFor(opA), await sessionFor(opB), await sessionFor(staff)];
  const sendsAtStart = discordSends().length;

  // ---- 1. API の拒否（送信の処理まで進まない）----
  for (const mode of ["preview", "send"]) {
    assert.equal((await api(mode)).status, 404, "ログインしていない人を拒否していません");
    assert.equal((await api(mode, { sid: sidStaff })).status, 404, "店舗のアカウントを拒否していません");
    assert.equal((await api(mode, { sid: sidA, origin: "https://evil.example" })).status, 403, "他のサイトからの送信を拒否していません");
  }
  assert.equal((await api("other", { sid: sidA })).status, 400);
  assert.equal(discordSends().length, sendsAtStart, "拒否した要求で Discord に送られました");
  step("API：未ログイン・店舗のアカウントは 404、他サイトからの送信は 403、不正な mode は 400。Discord には送られない");

  const browser = await chromium.launch();
  try {
    // ---- 2. 店舗のアカウント・未ログインでは画面に出ない ----
    {
      const ctx = await browser.newContext();
      const page = await ctx.newPage();
      await page.goto(`${BASE}/admin/settings`);
      assert.doesNotMatch(await page.content(), /Discord のテスト異常の通知/);
      await ctx.addCookies([{ name: "sid", value: sidStaff, domain: "localhost", path: "/" }]);
      await page.goto(`${BASE}/admin/settings`);
      assert.doesNotMatch(await page.content(), /Discord のテスト異常の通知/);
      await ctx.close();
    }
    step("画面：未ログイン・店舗のアカウントには「Discord のテスト異常の通知」を表示しない");

    // ---- 3. 運営A：パネルの表示と「通知内容を確認」（送信しない）----
    const ctx = await browser.newContext();
    await ctx.addCookies([{ name: "sid", value: sidA, domain: "localhost", path: "/" }]);
    const page = await ctx.newPage();
    let dialogs: string[] = [];
    let acceptDialog = false;
    page.on("dialog", (d) => {
      dialogs.push(d.message());
      void (acceptDialog ? d.accept() : d.dismiss());
    });
    await page.goto(`${BASE}/admin/settings`);
    await page.getByText("Discord のテスト異常の通知（Sandbox v2 専用）").waitFor();
    const before = await snapshot();
    const html0 = await page.content();
    assert.ok(!html0.includes(FAKE_TOKEN) && !html0.includes("discord.com/api/webhooks"), "画面に送信先が出ています");

    await page.getByRole("button", { name: "通知内容を確認" }).click();
    await page.getByText("送信先は登録済みです（送信はまだしていません）。").waitFor();
    const pre = (await page.locator("pre").textContent()) ?? "";
    assert.ok(pre.startsWith(`${HEADLINE}\n${NOTICE}\n送信の時刻：`), `本文の先頭が違います：${pre}`);
    assert.match(pre, /・テスト用の段階（作り物）：失敗（TestAlert）/);
    assert.ok(!pre.includes(FAKE_TOKEN));
    assert.equal(discordSends().length, sendsAtStart, "「通知内容を確認」で Discord に送られました");
    step("運営A：パネルを表示。「通知内容を確認」で【テスト異常】の見出し・対応不要の文・作り物の段階の本文を表示し、送信はしない。送信先の URL・トークンは画面に出ない");

    // ---- 4. 確認の画面で「キャンセル」→ 送らない ----
    acceptDialog = false;
    await page.getByRole("button", { name: "テスト異常を送信" }).click();
    assert.equal(dialogs.length, 1);
    assert.match(dialogs[0], /「【テスト異常】」の通知を1通送ります/);
    assert.equal(discordSends().length, sendsAtStart, "キャンセルしたのに送られました");
    step("確認の画面で「キャンセル」すると送信しない");

    // ---- 5. 送信：送信中はボタンを無効にし、二重に押しても1回だけ ----
    acceptDialog = true;
    dialogs = [];
    const sendBtn = page.locator("button", { hasText: "テスト異常を送信" });
    await sendBtn.click();
    const busyBtn = page.locator("button", { hasText: "処理中…" });
    await busyBtn.waitFor({ timeout: 1000 });
    assert.equal(await busyBtn.isDisabled(), true, "送信中のボタンが無効になっていません");
    assert.equal(await page.getByRole("button", { name: "通知内容を確認" }).isDisabled(), true);
    await busyBtn.evaluate((el) => el.click()); // 無効のボタンを無理に押しても送らない
    await page.getByText("テスト異常を1通送りました。Discord の Sandbox v2 のチャンネルを確認してください。").waitFor({ timeout: 10_000 });
    assert.equal(dialogs.length, 1, "確認の画面が2回出ました");
    const sends = discordSends().slice(sendsAtStart);
    assert.equal(sends.length, 1, `Discord への送信が1回ではありません（${sends.length}回）`);
    const s = sends[0];
    assert.equal(s.host, "discord.com");
    assert.equal(s.method, "POST");
    assert.equal(s.redirect, "error");
    assert.equal(s.path, "/api/webhooks/123456789012345678/<token>");
    const body = JSON.parse(s.body ?? "{}") as { content: string; allowed_mentions: unknown };
    assert.deepEqual(body.allowed_mentions, { parse: [] }, "メンションが無効になっていません");
    assert.ok(body.content.startsWith(`${HEADLINE}\n${NOTICE}\n`));
    assert.equal(body.content, pre.replace(/送信の時刻：.*/, body.content.match(/送信の時刻：.*/)![0]), "確認した本文と送った本文が違います");
    step("送信：確認の後に1回だけ送り（模擬）、送信中は両方のボタンが無効。無効のボタンを押しても二重に送らない。本文は確認と同じ・メンション無効・リダイレクト不可");

    // ---- 6. 続けての送信は回数の制限で止める（送らない）----
    await sendBtn.click();
    await page.getByText("送信できませんでした：短い時間に続けて送ることはできません。10分ほどあけてください（自動では送り直しません）").waitFor();
    assert.equal(discordSends().length, sendsAtStart + 1, "制限中に送られました");
    step("続けて送ると「短い時間に続けて送ることはできません」と表示し、送らない");
    await ctx.close();

    // ---- 7. 運営B：Discord が失敗（500）→ 失敗の種類を表示し、自動では送り直さない ----
    fs.writeFileSync(STATUS_FILE, "500");
    const ctxB = await browser.newContext();
    await ctxB.addCookies([{ name: "sid", value: sidB, domain: "localhost", path: "/" }]);
    const pageB = await ctxB.newPage();
    pageB.on("dialog", (d) => void d.accept());
    await pageB.goto(`${BASE}/admin/settings`);
    await pageB.locator("button", { hasText: "テスト異常を送信" }).click();
    await pageB.getByText("送信できませんでした：http_500（自動では送り直しません）").waitFor({ timeout: 10_000 });
    await new Promise((r) => setTimeout(r, 1500)); // 送り直しが無いことを少し待って確かめる
    assert.equal(discordSends().length, sendsAtStart + 2, "失敗の後に送り直しました");
    await ctxB.close();
    step("運営B：Discord の失敗（模擬の 500）は「送信できませんでした：http_500（自動では送り直しません）」と表示し、送り直さない");

    // ---- 8. Firestore に書き込みが無い・外への通信が無い ----
    assert.deepEqual(await snapshot(), before, "テスト通知の操作で Firestore のデータが変わりました");
    // Emulator で demo- 以外のプロジェクト ID を使うと、Firebase Admin SDK が Google のメタデータサーバーを探しに行く（ガードで止めて失敗させる。Vercel では認証情報があるので起きない）。
    // それ以外の外向きの通信は、止めたものも含めて1件も無いこと
    const METADATA = new Set(["metadata.google.internal", "metadata.google.internal.", "169.254.169.254"]);
    const other = guardEntries().filter((e) => e.kind !== "discord" && !METADATA.has(e.host ?? ""));
    assert.deepEqual(other, [], `localhost 以外への通信がありました：${JSON.stringify(other)}`);
    assert.ok(!fs.readFileSync(GUARD_LOG, "utf8").includes(FAKE_TOKEN), "記録にトークンが出ています");
    step("Firestore：操作の前後で全コレクションの件数・system の中身が同じ（書き込みなし）。Discord（模擬）以外への外向きの通信なし（Firebase Admin SDK のメタデータの問い合わせはガードで止めた）");
  } finally {
    await browser.close();
    fs.writeFileSync(STATUS_FILE, "204");
  }
  console.log("\nTEST ALERT BROWSER E2E PASSED");
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("\nTEST ALERT BROWSER E2E FAILED:", e);
    process.exit(1);
  });
