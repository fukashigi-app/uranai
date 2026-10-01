/**
 * E2E検証: QR → 100円決済 → Webhook → 占い権利 → 占い → 店舗売上30円計上
 * 起動中のアプリ（PAYMENT_PROVIDER=mock）に対して HTTP で実行し、DB を検証する。
 *   npm run dev  →  npm run e2e
 */
import "dotenv/config";
import assert from "node:assert/strict";
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { authSessions, checkouts, fortuneResults, fortuneSessions, stores, transactions } from "@/lib/db/schema";
import { randomToken, sha256Hex } from "@/lib/security/crypto";
import { signMockWebhook } from "@/lib/payments/mock";
import { createStore, createStoreUser, setStoreStatus } from "@/lib/services/stores";
import { generateSettlements } from "@/lib/services/settlements";
import { settlements } from "@/lib/db/schema";

const BASE = process.env.E2E_BASE_URL ?? process.env.APP_URL ?? "http://localhost:3000";
const SECRET = process.env.MOCK_WEBHOOK_SECRET!;

class Client {
  jar = new Map<string, string>();
  async req(path: string, init: RequestInit & { json?: unknown } = {}) {
    const headers = new Headers(init.headers);
    headers.set("cookie", [...this.jar].map(([k, v]) => `${k}=${v}`).join("; "));
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

const step = (msg: string) => console.log(`  ✓ ${msg}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  console.log(`E2E against ${BASE}`);
  const store = await createStore({ name: `E2E店舗 ${Date.now()}`, contactName: "", postalCode: "", address: "", phone: "", email: "" }, { userId: null, role: "SYSTEM" });

  // 1. QR アクセス
  const user = new Client();
  let res = await user.req(`/s/${store.storeCode}`);
  assert.equal(res.status, 200);
  assert.equal(user.jar.get("qr_store"), store.storeCode);
  assert.match(await res.text(), new RegExp(store.name));
  step("QRアクセスで店舗を識別（qr_store Cookie）");

  // 2. 未決済で占い・結果を見られない
  res = await user.req("/api/fortune", { method: "POST", json: { type: "BLOOD", bloodType: "A" } });
  assert.equal(res.status, 401);
  res = await user.req("/fortune/result");
  assert.match(await res.text(), /結果を表示できません/);
  step("未決済では占い実行・結果表示が拒否される");

  // 3. 金額・店舗の改ざんは受け付けない
  res = await user.req("/api/checkout", { method: "POST", json: { fortuneType: "BIRTHDAY", amount: 1, storeId: "x" } });
  assert.equal(res.status, 400);
  res = await user.req("/api/checkout", { method: "POST", json: { fortuneType: "BIRTHDAY" }, headers: { origin: "https://evil.example" } });
  assert.equal(res.status, 403);
  step("金額/storeId の送信・クロスオリジン要求を拒否");

  // 4. 決済セッション作成
  res = await user.req("/api/checkout", { method: "POST", json: { fortuneType: "BIRTHDAY" } });
  assert.equal(res.status, 201, await res.clone().text());
  const { checkoutId } = (await res.json()) as { checkoutId: string };
  const [co] = await db().select().from(checkouts).where(eq(checkouts.id, checkoutId));
  assert.equal(co.amount, 100);
  assert.equal(co.storeId, store.id);
  assert.ok(user.jar.get("fx_access"));
  step("決済セッション作成（金額100円・店舗はサーバーで決定）");

  // 5. 決済失敗カード
  res = await user.req("/api/checkout/pay", { method: "POST", json: { cardToken: "mock_tok_declined" } });
  assert.equal(res.status, 402);
  step("カード拒否時は日本語エラー・再試行可能");

  // 6. 決済（並列連打しても課金は1回）
  const results = await Promise.all([1, 2, 3].map(() => user.req("/api/checkout/pay", { method: "POST", json: { cardToken: "mock_tok_success" } })));
  assert.ok(results.every((r) => r.status === 200));
  const [afterPay] = await db().select().from(checkouts).where(eq(checkouts.id, checkoutId));
  assert.equal(afterPay.status, "PROCESSING");
  assert.ok(afterPay.providerPaymentId);
  assert.equal(afterPay.attemptCount, 2); // 失敗1回 + 成功1回（連打分はロックで弾かれる）
  assert.equal((await db().select().from(transactions).where(eq(transactions.storeId, store.id))).length, 0);
  step("決済実行（連打しても請求は1回）。この時点では売上未計上");

  // 7. Webhook → Transaction 作成を待つ
  let status = "";
  for (let i = 0; i < 20 && status !== "succeeded"; i++) {
    await sleep(500);
    res = await user.req("/api/checkout/status");
    status = ((await res.json()) as { status: string }).status;
  }
  assert.equal(status, "succeeded");
  const txs = await db().select().from(transactions).where(eq(transactions.storeId, store.id));
  assert.equal(txs.length, 1);
  const tx = txs[0];
  assert.equal(tx.amount, 100);
  assert.equal(tx.storeShare, 30);
  assert.equal(tx.operatorShare, 70);
  assert.equal(tx.paymentFee, 4);
  assert.equal(tx.paymentStatus, "SUCCEEDED");
  assert.equal(tx.fortuneStatus, "PENDING");
  step(`Webhook受信 → Transaction 計上（売上100円 / 店舗30円 / 運営70円 / 手数料${tx.paymentFee}円）`);

  // 8. Webhook の再送・偽造
  const body = JSON.stringify({ id: `evt_dup_${Date.now()}`, type: "charge.succeeded", data: { id: tx.providerPaymentId, object: "charge" } });
  for (let i = 0; i < 2; i++) {
    res = await fetch(`${BASE}/api/webhooks/mock`, { method: "POST", headers: { "content-type": "application/json", "x-mock-signature": signMockWebhook(SECRET, body) }, body });
    assert.equal(res.status, 200);
  }
  res = await fetch(`${BASE}/api/webhooks/mock`, { method: "POST", headers: { "content-type": "application/json", "x-mock-signature": signMockWebhook("wrong-secret-wrong-secret", body) }, body });
  assert.equal(res.status, 401);
  const forged = JSON.stringify({ id: "evt_forged", type: "charge.succeeded", data: { id: "mock_ch_eyJhIjoxMDB9.00000000000000000000000000000000", object: "charge" } });
  res = await fetch(`${BASE}/api/webhooks/mock`, { method: "POST", headers: { "content-type": "application/json", "x-mock-signature": signMockWebhook(SECRET, forged) }, body: forged });
  assert.equal(res.status, 200);
  assert.equal((await db().select().from(transactions).where(eq(transactions.storeId, store.id))).length, 1);
  step("同一Webhookの再送・不正署名・偽造Chargeで二重計上されない");

  // 9. 占い権利
  const [session] = await db().select().from(fortuneSessions).where(eq(fortuneSessions.transactionId, tx.id));
  assert.equal(session.status, "PAID");
  step("占い権利（fortuneSession: PAID）発行");
  res = await user.req("/api/checkout", { method: "POST", json: { fortuneType: "ZODIAC" } });
  assert.equal(res.status, 409);
  step("未使用の権利があるうちは新しい決済を開始させない（権利の消失防止）");

  // 10. 種類違いの入力は拒否、正しい入力で占い
  res = await user.req("/api/fortune", { method: "POST", json: { type: "BLOOD", bloodType: "A" } });
  assert.equal(res.status, 400);
  res = await user.req("/api/fortune", { method: "POST", json: { type: "BIRTHDAY", birthDate: "1992-11-09" } });
  assert.equal(res.status, 200);
  res = await user.req("/api/fortune", { method: "POST", json: { type: "BIRTHDAY", birthDate: "1992-11-09" } });
  assert.equal(res.status, 200); // 二重送信は同じ結果
  const results2 = await db().select().from(fortuneResults).where(eq(fortuneResults.fortuneSessionId, session.id));
  assert.equal(results2.length, 1);
  assert.ok(!JSON.stringify(results2[0].result).includes("1992-11-09"));
  const [used] = await db().select().from(fortuneSessions).where(eq(fortuneSessions.id, session.id));
  assert.equal(used.status, "USED");
  const [txAfter] = await db().select().from(transactions).where(eq(transactions.id, tx.id));
  assert.equal(txAfter.fortuneStatus, "COMPLETED");
  step("占い実行（1回のみ・生年月日は保存しない）→ USED");

  // 11. 結果表示・再表示、他人は見られない
  res = await user.req("/fortune/result");
  const html = await res.text();
  assert.match(html, /今日の総合運/);
  res = await user.req("/fortune/result");
  assert.match(await res.text(), /今日の総合運/);
  res = await new Client().req("/fortune/result");
  assert.match(await res.text(), /結果を表示できません/);
  res = await user.req("/fortune/input", {});
  assert.equal(res.status, 307);
  step("結果表示・再表示OK／別ブラウザからは閲覧不可／入力画面は結果へリダイレクト");

  // 11b. 課金結果が不明な通信エラーでは再課金させない
  const amb = new Client();
  await amb.req(`/s/${store.storeCode}`);
  res = await amb.req("/api/checkout", { method: "POST", json: { fortuneType: "BLOOD" } });
  const { checkoutId: ambId } = (await res.json()) as { checkoutId: string };
  res = await amb.req("/api/checkout/pay", { method: "POST", json: { cardToken: "mock_tok_network" } });
  assert.equal(res.status, 200);
  assert.equal(((await res.json()) as { status: string }).status, "processing");
  res = await amb.req("/api/checkout/pay", { method: "POST", json: { cardToken: "mock_tok_success" } });
  assert.equal(((await res.json()) as { status: string }).status, "processing");
  const [ambCo] = await db().select().from(checkouts).where(eq(checkouts.id, ambId));
  assert.equal(ambCo.status, "PROCESSING");
  assert.equal(ambCo.attemptCount, 1);
  step("課金結果が不明な通信エラー時は処理中のまま保留し、別キーでの再課金を許さない");

  // 12. 停止中店舗では決済を開始できない
  await setStoreStatus(store.id, "SUSPENDED", { userId: null, role: "SYSTEM" });
  const other = new Client();
  await other.req(`/s/${store.storeCode}`);
  res = await other.req("/api/checkout", { method: "POST", json: { fortuneType: "ZODIAC" } });
  assert.equal(res.status, 403);
  step("停止中店舗は決済開始不可");

  // 13. 店舗売上
  const [s] = await db().select().from(stores).where(eq(stores.id, store.id));
  const sum = await db().select().from(transactions).where(and(eq(transactions.storeId, s.id), eq(transactions.paymentStatus, "SUCCEEDED")));
  assert.equal(sum.reduce((a, t) => a + t.storeShare, 0), 30);
  step("店舗売上 30円 計上を確認");

  // 13b. 返金等で決済がなくなった店舗の未払い精算は0円に更新される
  await db().insert(settlements).values({ storeId: store.id, yearMonth: "2026-08", transactionCount: 5, grossSales: 500, storeShare: 150 });
  await generateSettlements("2026-08", { userId: null, role: "SYSTEM" });
  const [zeroed] = await db().select().from(settlements).where(and(eq(settlements.storeId, store.id), eq(settlements.yearMonth, "2026-08")));
  assert.equal(zeroed.storeShare, 0);
  assert.equal(zeroed.transactionCount, 0);
  step("決済がなくなった店舗の未払い精算は再集計で0円に更新");

  // 14. 認可: 店舗アカウントは自店舗のみ
  const otherStore = await createStore({ name: `E2E他店舗 ${Date.now()}`, contactName: "", postalCode: "", address: "", phone: "", email: "" }, { userId: null, role: "SYSTEM" });
  const staffId = await createStoreUser(store.id, { name: "e2e", email: `e2e-${Date.now()}@example.com`, password: "E2ePassword123" }, { userId: null, role: "SYSTEM" });
  const token = randomToken(32);
  await db().insert(authSessions).values({ id: sha256Hex(token), userId: staffId, expiresAt: new Date(Date.now() + 3600_000) });
  const staff = new Client();
  staff.jar.set("sid", token);
  res = await staff.req("/store/dashboard");
  assert.equal(res.status, 200);
  assert.match(await res.text(), new RegExp(store.name));
  res = await staff.req("/admin");
  assert.equal(res.status, 404);
  res = await staff.req(`/api/admin/settlements?ym=2026-09`);
  assert.equal(res.status, 404);
  res = await staff.req(`/api/store/qr?storeId=${otherStore.id}`);
  assert.equal(res.status, 200);
  assert.ok(res.headers.get("content-disposition")?.includes(store.storeCode), "他店舗のQRは取得できず自店舗のQRが返る");
  res = await new Client().req("/store/dashboard");
  assert.equal(res.status, 307);
  step("店舗アカウントは自店舗のみ閲覧可（運営画面404・他店舗QR不可・未ログインはリダイレクト）");

  console.log("\nE2E PASSED");
  process.exit(0);
}

main().catch((e) => {
  console.error("\nE2E FAILED:", e);
  process.exit(1);
});
