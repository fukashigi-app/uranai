/**
 * 開発モード（SITE_STATUS=development）の E2E 検証。Firestore Emulator の demo- プロジェクトでだけ実行する（本番には接続しない）。
 *
 *   firebase emulators:start --only firestore --project demo-uranai
 *   （別ターミナル）npm run build && FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 FIREBASE_PROJECT_ID=demo-uranai-dev \
 *       SITE_STATUS=development ENABLE_TEST_PAYMENT=false PAYMENT_PROVIDER=stripe npx next start
 *   （別ターミナル）FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 FIREBASE_PROJECT_ID=demo-uranai-dev npm run e2e:dev-mode
 *
 * E2E_DEV_SCENARIO=halted のときは、危険な設定（ENABLE_TEST_PAYMENT=true など）が残っている本番を想定し、
 * 運営アカウントでも無料の占いが使えないことだけを確認する。
 */
import "dotenv/config";
import assert from "node:assert/strict";
import { FieldValue } from "firebase-admin/firestore";
import { C, fsdb } from "@/lib/firestore/admin";
import { salesKeys } from "@/lib/firestore/shared";
import { transactionDocId } from "@/lib/firestore/payments";
import { dataProvider } from "@/lib/data-provider";
import { createOperator, createStore, createStoreUser, setStoreStatus } from "@/lib/services/stores";
import { monthTotals } from "@/lib/services/reports";
import { testUsageForStore } from "@/lib/services/test-usage";
import { randomToken, sha256Hex } from "@/lib/security/crypto";
import { jstYearMonth } from "@/lib/time";

const BASE = process.env.E2E_BASE_URL ?? "http://localhost:3000";
const SCENARIO = process.env.E2E_DEV_SCENARIO ?? "dev";
const SYSTEM = { userId: null, role: "SYSTEM" as const };
const step = (msg: string) => console.log(`  ✓ ${msg}`);

class Client {
  jar = new Map<string, string>();
  constructor(public ip = `198.51.100.${Math.floor(Math.random() * 250) + 1}`) {}
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
  async text(path: string) {
    return (await this.req(path)).text();
  }
}

/** ログイン済みのクライアント（ログイン状態を Emulator に直接作成）。戻り値の hash でログアウトを再現する */
async function loggedIn(userId: string) {
  const token = randomToken(32);
  const hash = sha256Hex(token);
  await fsdb().collection(C.authSessions).doc(hash).set({ userId, expiresAt: new Date(Date.now() + 3600_000) });
  const c = new Client();
  c.jar.set("sid", token);
  return { c, hash };
}

const WATCHED = [C.checkouts, C.transactions, C.fortuneSessions, C.fortuneResults, C.settlements, C.stores];
async function counts() {
  const out: Record<string, number> = {};
  for (const name of WATCHED) out[name] = (await fsdb().collection(name).count().get()).data().count;
  return out;
}

async function main() {
  // ---- 接続先の確認（本番 Firestore では実行しない）----
  const host = process.env.FIRESTORE_EMULATOR_HOST ?? "";
  assert.match(host, /^(127\.0\.0\.1|localhost|\[::1\]):\d+$/, "FIRESTORE_EMULATOR_HOST（localhost の Emulator）が必要です");
  assert.match(process.env.FIREBASE_PROJECT_ID ?? "", /^demo-/, "FIREBASE_PROJECT_ID は demo- で始まる Emulator 用の ID にしてください");
  assert.equal(dataProvider(), "firestore");
  assert.match(BASE, /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/, "E2E はローカルのアプリにだけ実行します");
  console.log(`Dev mode E2E (${SCENARIO}) against ${BASE} (emulator ${host} / ${process.env.FIREBASE_PROJECT_ID})`);

  // ---- 既存データの代わり：実店舗・本番の決済1件・アカウント ----
  const stamp = Date.now();
  const store = await createStore({ name: `開発モード検証店舗 ${stamp}`, contactName: "", postalCode: "", address: "", phone: "", email: "" }, SYSTEM);
  // 誤加算の確認用の別店舗と、休止中の店舗
  const storeB = await createStore({ name: `開発モード検証店舗B ${stamp}`, contactName: "", postalCode: "", address: "", phone: "", email: "" }, SYSTEM);
  const paused = await createStore({ name: `開発モード休止店舗 ${stamp}`, contactName: "", postalCode: "", address: "", phone: "", email: "" }, SYSTEM);
  await setStoreStatus(paused.id, "SUSPENDED", SYSTEM);
  const paidAt = new Date();
  const chargeId = `ch_dev_${randomToken(6)}`;
  const txRef = fsdb().collection(C.transactions).doc(transactionDocId("payjp", chargeId));
  await txRef.create({
    checkoutId: "00000000-0000-4000-8000-000000000000",
    paymentProvider: "payjp",
    providerPaymentId: chargeId,
    storeId: store.id,
    fortuneType: "ZODIAC",
    amount: 100,
    storeShare: 30,
    operatorShare: 70,
    paymentFee: 3,
    storeShareBps: 3000,
    paymentStatus: "SUCCEEDED",
    fortuneStatus: "COMPLETED",
    livemode: true,
    paidAt,
    refundedAt: null,
    ...salesKeys(store.id, "payjp", "SUCCEEDED", paidAt, true),
    createdAt: FieldValue.serverTimestamp(),
  });
  const opId = await createOperator({ name: "開発モード運営", email: `dev-op-${stamp}@example.com`, password: "DevOperator123" });
  const op2Id = await createOperator({ name: "開発モード運営2", email: `dev-op2-${stamp}@example.com`, password: "DevOperator123" });
  const op3Id = await createOperator({ name: "開発モード運営3", email: `dev-op3-${stamp}@example.com`, password: "DevOperator123" });
  const staffId = await createStoreUser(store.id, { name: "店舗スタッフ", email: `dev-staff-${stamp}@example.com`, password: "DevStaffPass123" }, SYSTEM);

  const ym = jstYearMonth(new Date());
  const before = { counts: await counts(), month: await monthTotals(ym), storeMonth: await monthTotals(ym, store.id), usage: await testUsageForStore(store), usageB: await testUsageForStore(storeB), usagePaused: await testUsageForStore(paused), tx: (await txRef.get()).data(), storeDoc: (await fsdb().collection(C.stores).doc(store.id).get()).data() };
  const logsBefore = new Set((await fsdb().collection(C.testFortuneLogs).get()).docs.map((d) => d.id));

  if (SCENARIO === "halted") {
    const { c } = await loggedIn(opId);
    assert.match(await c.text("/s/test"), /data-service-paused="halted"/);
    assert.doesNotMatch(await c.text("/s/test"), /data-dev-mode-banner/);
    assert.equal((await c.req("/api/test-fortune", { method: "POST", json: { fortuneType: "zodiac" } })).status, 404);
    assert.equal((await c.req("/api/checkout", { method: "POST", json: { fortuneType: "ZODIAC" } })).status, 503);
    step("危険な設定が残っているときは、開発モードでも運営アカウントを含め無料の占い・決済とも停止");
    assert.deepEqual(await counts(), before.counts);
    console.log("\nDEV MODE E2E (halted) PASSED");
    return;
  }

  // ---- 1. ログインしていない人：準備中・無料の占いも決済も使えない ----
  const anon = new Client();
  for (const p of ["/", "/s/test", "/fortune", "/payment", `/s/${store.storeCode}`]) {
    const html = await anon.text(p);
    assert.match(html, /data-service-paused="development"/, `${p} が準備中になっていません`);
    assert.doesNotMatch(html, /data-dev-mode-banner/);
  }
  assert.equal((await anon.req("/api/test-fortune", { method: "POST", json: { fortuneType: "zodiac" } })).status, 404);
  assert.equal((await anon.req("/test")).status, 404);
  let r = await anon.req("/api/checkout", { method: "POST", json: { fortuneType: "ZODIAC" } });
  assert.equal(r.status, 503);
  assert.equal(((await r.json()) as { error: { code: string } }).error.code, "development_mode");
  // 疑似決済の支払い（/api/checkout/pay）は PAYMENT_PROVIDER=mock 以外では存在しない（PAY.JP のカード決済の受付は廃止）
  assert.equal((await anon.req("/api/checkout/pay", { method: "POST", json: { cardToken: "tok_x" } })).status, 404);
  step("ログインなし：どのページも「準備中」。無料の占いは 404、注文の API は 503（development_mode）、疑似決済の支払いの API は 404");

  // ---- 2. 店舗アカウント：使えない ----
  const { c: staff } = await loggedIn(staffId);
  assert.match(await staff.text("/s/test"), /data-service-paused="development"/);
  assert.equal((await staff.req("/api/test-fortune", { method: "POST", json: { fortuneType: "zodiac" } })).status, 404);
  assert.equal((await staff.req("/api/checkout", { method: "POST", json: { fortuneType: "ZODIAC" } })).status, 503);
  step("店舗アカウント：準備中のまま（無料の占い 404・決済 503）");

  // ---- 3. 運営アカウント：テスト店舗で無料の占い。決済は運営でも 503 ----
  const { c: op, hash: opHash } = await loggedIn(opId);
  let html = await op.text("/s/test");
  assert.match(html, /data-dev-mode-banner/);
  assert.match(html, /data-protection-state="unknown"/); // Vercel 以外では「未確認」（保護されているとは表示しない）
  assert.match(html, /未確認/);
  assert.match(html, /最終確認：/);
  r = await op.req("/api/test-fortune", { method: "POST", json: { fortuneType: "zodiac" } });
  assert.equal(r.status, 200, await r.clone().text());
  assert.ok(op.jar.has("fx_dev") && !op.jar.has("fx_test"), "開発モード用の Cookie で保存されていません");
  assert.match(await op.text("/fortune/input"), /テストモードのため決済をスキップしました/);
  r = await op.req("/api/fortune", { method: "POST", json: { type: "ZODIAC", sign: "leo" } });
  assert.equal(r.status, 200, await r.clone().text());
  assert.deepEqual(await r.json(), { ok: true, test: true });
  html = await op.text("/fortune/result");
  assert.match(html, /健康運/);
  assert.match(html, /別の占いも試す（無料）/);
  r = await op.req("/api/fortune", { method: "POST", json: { type: "ZODIAC", sign: "leo" } }); // 二重送信は同じ結果
  assert.equal(r.status, 200);
  for (const [p, b, code] of [
    ["/api/checkout", { fortuneType: "ZODIAC" }, 503],
    ["/api/checkout/pay", { cardToken: "tok_x" }, 404], // 疑似決済の支払い（mock 以外では存在しない）
  ] as const) {
    r = await op.req(p, { method: "POST", json: b });
    assert.equal(r.status, code, `${p} が運営アカウントで止まっていません`);
  }
  assert.match(await op.text("/payment"), /data-service-paused="development"/);
  // 生年月日占い（生年月日はどこにも保存しない）
  r = await op.req("/api/test-fortune", { method: "POST", json: { fortuneType: "birthday" } });
  assert.equal(r.status, 200);
  r = await op.req("/api/fortune", { method: "POST", json: { type: "BIRTHDAY", birthDate: "1991-03-21" } });
  assert.equal(r.status, 200, await r.clone().text());
  step("運営アカウント：/s/test で無料の占い（星座・生年月日）→ 結果を表示。決済の API とお支払い画面は運営でも停止");
  for (const p of ["/admin", "/admin/settings"]) {
    const page = await op.text(p);
    assert.match(page, /開発モード（SITE_STATUS=development）|開発モード（development）/, `${p} に開発モードの表示がありません`);
    assert.match(page, /Vercel Authentication/);
    assert.match(page, /未確認/); // ローカルでは保護状態を確認できない＝未確認（保護済みとは表示しない）
    assert.match(page, /最終確認：\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}/); // 最後に確認した日時（キャッシュの可能性）を表示
    assert.doesNotMatch(page, /認証を求める応答を確認|保護済み/);
  }
  step("運営の管理画面：開発モードの案内と Vercel Authentication「未確認」を表示");

  // ---- 4. 登録済み・稼働中の実店舗の QR（運営だけ）----
  html = await op.text(`/s/${store.storeCode}`); // qr_store Cookie が実店舗になる
  assert.match(html, /data-dev-mode-banner/);
  assert.ok(html.includes(store.name), "店舗名が表示されていません");
  assert.match(html, /テストモード：無料で占う/);
  r = await op.req("/api/test-fortune", { method: "POST", json: { fortuneType: "zodiac" } });
  assert.equal(r.status, 200, await r.clone().text());
  assert.match(await op.text("/fortune/input"), /テストモードのため決済をスキップしました/);
  r = await op.req("/api/fortune", { method: "POST", json: { type: "ZODIAC", sign: "aries" } });
  assert.equal(r.status, 200, await r.clone().text());
  html = await op.text("/fortune/result");
  assert.match(html, /健康運/);
  assert.ok(html.includes(store.name), "結果画面に店舗名が表示されていません");
  // 休止中の店舗・未登録の店舗コードは使えない
  assert.match(await op.text(`/s/${paused.storeCode}`), /現在ご利用いただけません/);
  r = await op.req("/api/test-fortune", { method: "POST", json: { fortuneType: "zodiac" } });
  assert.equal(r.status, 403);
  assert.equal(((await r.json()) as { error: { code: string } }).error.code, "store_unavailable");
  assert.match(await op.text("/s/zz99unknown"), /QRコードを確認できませんでした/);
  r = await op.req("/api/test-fortune", { method: "POST", json: { fortuneType: "zodiac" } });
  assert.equal(r.status, 403);
  // ログインなし・店舗アカウントは、実店舗の QR でも使えない
  const anon2 = new Client();
  assert.match(await anon2.text(`/s/${store.storeCode}`), /data-service-paused="development"/);
  assert.equal((await anon2.req("/api/test-fortune", { method: "POST", json: { fortuneType: "zodiac" } })).status, 404);
  assert.match(await staff.text(`/s/${store.storeCode}`), /data-service-paused="development"/);
  assert.equal((await staff.req("/api/test-fortune", { method: "POST", json: { fortuneType: "zodiac" } })).status, 404);
  // 最後にテスト店舗の Cookie に戻す（下の Cookie の確認用）
  await op.req("/s/test");
  r = await op.req("/api/test-fortune", { method: "POST", json: { fortuneType: "zodiac" } });
  assert.equal(r.status, 200);
  step("実店舗の QR：運営は稼働中の登録店舗で無料の占い → 結果まで表示。休止中・未登録の店舗は 403、ログインなし・店舗アカウントは 404");

  // ---- 5. Cookie の使い回し・偽造・ログアウト ----
  const devCookie = op.jar.get("fx_dev")!;
  const thief = new Client();
  thief.jar.set("fx_dev", devCookie);
  r = await thief.req("/api/fortune", { method: "POST", json: { type: "ZODIAC", sign: "leo" } });
  assert.notEqual(r.status, 200, "ログインしていない人が開発モードの Cookie で占えてしまいました");
  assert.doesNotMatch(await thief.text("/fortune/result"), /健康運/);
  const { c: op2 } = await loggedIn(op2Id);
  op2.jar.set("fx_dev", devCookie);
  r = await op2.req("/api/fortune", { method: "POST", json: { type: "ZODIAC", sign: "leo" } });
  assert.notEqual(r.status, 200, "別の運営アカウントで他人の Cookie を使えてしまいました");
  const tampered = new Client();
  tampered.jar = new Map(op.jar);
  const [body, sig] = devCookie.split(".");
  const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  tampered.jar.set("fx_dev", `${Buffer.from(JSON.stringify({ ...payload, storeCode: storeB.storeCode })).toString("base64url")}.${sig}`); // 別の店舗に書き換え
  r = await tampered.req("/api/fortune", { method: "POST", json: { type: "ZODIAC", sign: "leo" } });
  assert.notEqual(r.status, 200, "改ざんした Cookie が通ってしまいました");
  // 開発モード以外の Cookie 名（テストモード用）に入れても使えない
  const misplaced = new Client();
  misplaced.jar = new Map(op.jar);
  misplaced.jar.delete("fx_dev");
  misplaced.jar.set("fx_test", devCookie);
  r = await misplaced.req("/api/fortune", { method: "POST", json: { type: "ZODIAC", sign: "leo" } });
  assert.notEqual(r.status, 200);
  // ログアウト（ログイン状態を削除）すると、同じ端末の Cookie も使えない
  await fsdb().collection(C.authSessions).doc(opHash).delete();
  assert.doesNotMatch(await op.text("/fortune/result"), /健康運/);
  assert.match(await op.text("/s/test"), /data-service-paused="development"/);
  step("Cookie：ログインなし・別の運営・改ざん・取り違え・ログアウト後は使えない");

  // ---- 6. 回数制限（サーバー側。IP を変えても運営アカウントごとに数える）----
  const { c: op3 } = await loggedIn(op3Id);
  await op3.req("/s/test");
  const statuses: number[] = [];
  for (let i = 0; i < 11; i++) statuses.push((await op3.req("/api/test-fortune", { method: "POST", json: { fortuneType: "zodiac" } })).status);
  assert.deepEqual(statuses.slice(0, 10), Array(10).fill(200));
  assert.equal(statuses[10], 429);
  op3.ip = "203.0.113.77"; // 接続元を変えても、運営アカウントごとの制限で止まる
  assert.equal((await op3.req("/api/test-fortune", { method: "POST", json: { fortuneType: "zodiac" } })).status, 429);
  step("回数制限：/api/test-fortune は1分10回まで（11回目は 429）。接続元を変えても運営アカウントごとに 429");

  // ---- 7. データ：売上・取り分・精算は 0 円のまま。既存データは変わらない ----
  assert.deepEqual(await counts(), before.counts, "決済・売上・精算・店舗のデータが変わりました");
  assert.deepEqual(await monthTotals(ym), before.month);
  assert.deepEqual(await monthTotals(ym, store.id), before.storeMonth);
  assert.deepEqual(before.storeMonth, { count: 1, gross: 100, storeShare: 30, operatorShare: 70, fee: 3 }); // 既存の本番決済1件だけ
  assert.deepEqual((await txRef.get()).data(), before.tx);
  assert.deepEqual((await fsdb().collection(C.stores).doc(store.id).get()).data(), before.storeDoc);
  // 実店舗の無料テスト利用件数は、占った店舗だけ1回増える（他の店舗・休止中の店舗は変わらない）
  assert.deepEqual(await testUsageForStore(store), { thisMonth: before.usage.thisMonth + 1, total: before.usage.total + 1 });
  assert.deepEqual(await testUsageForStore(storeB), before.usageB);
  assert.deepEqual(await testUsageForStore(paused), before.usagePaused);
  const newLogs = (await fsdb().collection(C.testFortuneLogs).get()).docs.filter((d) => !logsBefore.has(d.id));
  assert.equal(newLogs.length, 3, "占った回数（テスト店舗で星座・生年月日、実店舗で星座）だけ記録されていません");
  assert.deepEqual(newLogs.map((d) => d.get("storeCode")).sort(), [store.storeCode, "test", "test"].sort());
  for (const d of newLogs) {
    assert.equal(d.get("mode"), "development");
    assert.deepEqual(Object.keys(d.data()).sort(), ["createdAt", "fortuneType", "mode", "storeCode"]); // 生年月日・アカウントなどは保存しない
  }
  step("データ：注文・決済・占い権利・占い結果・精算・店舗は件数も内容も変化なし（売上・店舗30%・運営70%・手数料は既存分のまま、開発モード分は0円）。記録は testFortuneLogs に mode=development で3件（実店舗の無料テスト利用件数は+1、他店舗は変化なし）");

  console.log("\nDEV MODE E2E PASSED");
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("\nDEV MODE E2E FAILED:", e);
    process.exit(1);
  });
