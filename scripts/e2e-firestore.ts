/**
 * Firestore 版の E2E 検証（Firestore Emulator 上で実行。本番 Firestore には一切接続しない）。
 *
 *   firebase emulators:start --only firestore --project demo-uranai
 *   （別ターミナルで）npm run build && FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 FIREBASE_PROJECT_ID=demo-uranai \
 *       PAYMENT_PROVIDER=mock ALLOW_MOCK_PAYMENTS_IN_PRODUCTION=true ENABLE_TEST_PAYMENT=true npx next start
 *   （別ターミナルで）npm run e2e:firestore
 */
import "dotenv/config";
import assert from "node:assert/strict";
import { FieldValue } from "firebase-admin/firestore";
import { C, fsdb } from "@/lib/firestore/admin";
import { salesKeys } from "@/lib/firestore/shared";
import { transactionDocId } from "@/lib/firestore/payments";
import { dataProvider } from "@/lib/data-provider";
import { authenticate } from "@/lib/auth/login";
import { createOperator, createStore, createStoreUser, setStoreStatus } from "@/lib/services/stores";
import { listStores, monthTotals, totalsForRange } from "@/lib/services/reports";
import { generateSettlements, listSettlements, updateSettlementStatus } from "@/lib/services/settlements";
import { confirmCharge, markRefunded } from "@/lib/payments/confirm";
import { getProvider } from "@/lib/payments";
import { signMockWebhook } from "@/lib/payments/mock";
import { resolvePeriod } from "@/lib/period";
import { formatYen } from "@/lib/money";
import { randomToken, sha256Hex } from "@/lib/security/crypto";
import { jstDateString, jstMonthRange, jstYearMonth, shiftYearMonth } from "@/lib/time";
import { personalDayNumber } from "@/lib/fortune/numerology";

const BASE = process.env.E2E_BASE_URL ?? "http://localhost:3000";
const SYSTEM = { userId: null, role: "SYSTEM" as const };

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

/** ログイン済みのクライアント（セッションを Firestore に直接作成） */
async function loggedIn(userId: string) {
  const token = randomToken(32);
  await fsdb().collection(C.authSessions).doc(sha256Hex(token)).set({ userId, expiresAt: new Date(Date.now() + 3600_000) });
  const c = new Client();
  c.jar.set("sid", token);
  return c;
}

/** 過去の決済を作成（集計の期間テスト用。confirmCharge と同じ形式のドキュメント） */
async function seedTransaction(storeId: string, paidAt: Date, provider = "payjp") {
  const id = `ch_seed_${randomToken(8)}`;
  await fsdb()
    .collection(C.transactions)
    .doc(transactionDocId(provider, id))
    .create({
      checkoutId: "00000000-0000-4000-8000-000000000000",
      paymentProvider: provider,
      providerPaymentId: id,
      storeId,
      fortuneType: "ZODIAC",
      amount: 100,
      storeShare: 30,
      operatorShare: 70,
      paymentFee: 3,
      storeShareBps: 3000,
      paymentStatus: "SUCCEEDED",
      fortuneStatus: "COMPLETED",
      livemode: false,
      paidAt,
      refundedAt: null,
      ...salesKeys(storeId, provider, "SUCCEEDED", paidAt),
      createdAt: FieldValue.serverTimestamp(),
    });
  return id;
}

async function main() {
  assert.ok(process.env.FIRESTORE_EMULATOR_HOST, "FIRESTORE_EMULATOR_HOST が必要です（本番 Firestore では実行しない）");
  assert.equal(dataProvider(), "firestore");
  console.log(`Firestore E2E against ${BASE} (emulator ${process.env.FIRESTORE_EMULATOR_HOST})`);
  const MOCK_SECRET = process.env.MOCK_WEBHOOK_SECRET && process.env.MOCK_WEBHOOK_SECRET.length >= 16 ? process.env.MOCK_WEBHOOK_SECRET : `mock:${process.env.SESSION_SECRET}`;

  // 1. 店舗作成・店舗ユーザー作成
  const stamp = Date.now();
  const storeA = await createStore({ name: `FS店舗A ${stamp}`, contactName: "", postalCode: "", address: "", phone: "", email: "" }, SYSTEM);
  const storeB = await createStore({ name: `FS店舗B ${stamp}`, contactName: "", postalCode: "", address: "", phone: "", email: "" }, SYSTEM);
  assert.ok((await fsdb().collection(C.storeCodes).doc(storeA.storeCode).get()).exists);
  const staffEmail = `fs-staff-${stamp}@example.com`;
  const staffId = await createStoreUser(storeA.id, { name: "FSスタッフ", email: staffEmail, password: "FsStaffPass123" }, SYSTEM);
  await assert.rejects(createStoreUser(storeB.id, { name: "重複", email: staffEmail.toUpperCase(), password: "FsStaffPass123" }, SYSTEM), /DuplicateEmail|Error/);
  const opEmail = `fs-op-${stamp}@example.com`;
  const opId = await createOperator({ name: "FS運営", email: opEmail, password: "FsOperator123" });
  step("店舗作成（店舗コードの重複防止 storeCodes）・店舗ユーザー作成（メール重複は拒否 userEmails）");

  // 2. ログイン（役割の確認・ロック）
  assert.equal((await authenticate(staffEmail, "FsStaffPass123", "STORE")).ok, true);
  assert.equal((await authenticate(staffEmail, "FsStaffPass123", "OPERATOR")).ok, false); // 店舗アカウントで運営ログイン不可
  assert.equal((await authenticate(opEmail, "FsOperator123", "OPERATOR")).ok, true);
  for (let i = 0; i < 5; i++) await authenticate(opEmail, "wrong-password-1", "OPERATOR");
  assert.deepEqual(await authenticate(opEmail, "FsOperator123", "OPERATOR"), { ok: false, reason: "locked" }); // 5回失敗でロック
  await fsdb().collection(C.users).doc(opId).update({ lockedUntil: null, failedLoginCount: 0 });
  step("ログイン（店舗/運営の区別・5回失敗で15分ロック）");

  // 3. 店舗QR
  const user = new Client();
  let res = await user.req(`/s/${storeA.storeCode}`);
  assert.equal(res.status, 200);
  assert.equal(user.jar.get("qr_store"), storeA.storeCode);
  assert.match(await res.text(), new RegExp(storeA.name));
  step("店舗QR（/s/店舗コード で店舗を識別）");

  // 4. 決済 → 決済履歴作成（100円 → 店舗30円 / 運営70円）
  res = await user.req("/api/checkout", { method: "POST", json: { fortuneType: "BIRTHDAY" } });
  assert.equal(res.status, 201, await res.clone().text());
  res = await user.req("/api/checkout/pay", { method: "POST", json: { cardToken: "mock_tok_success" } });
  assert.equal(res.status, 200);
  let status = "";
  for (let i = 0; i < 20 && status !== "succeeded"; i++) {
    res = await user.req("/api/checkout/status");
    status = ((await res.json()) as { status: string }).status;
    if (status !== "succeeded") await sleep(400);
  }
  assert.equal(status, "succeeded");
  const txs = await fsdb().collection(C.transactions).where("storeId", "==", storeA.id).get();
  assert.equal(txs.size, 1);
  const t = txs.docs[0];
  assert.deepEqual([t.get("amount"), t.get("storeShare"), t.get("operatorShare")], [100, 30, 70]);
  assert.equal(t.id, transactionDocId("mock", t.get("providerPaymentId")));
  assert.equal(t.get("yearMonth"), jstYearMonth(t.get("paidAt").toDate()));
  step(`決済履歴作成（金額100円・店舗30円・運営70円を保存、年月は日本時間 ${t.get("yearMonth")}）`);

  // 5. 二重計上防止（同じWebhookの再送・同時確定）
  const chargeId = String(t.get("providerPaymentId"));
  const body = JSON.stringify({ id: `evt_dup_${stamp}`, type: "charge.succeeded", data: { id: chargeId, object: "charge" } });
  for (let i = 0; i < 2; i++) {
    res = await fetch(`${BASE}/api/webhooks/mock`, { method: "POST", headers: { "content-type": "application/json", "x-mock-signature": signMockWebhook(MOCK_SECRET, body) }, body });
    assert.equal(res.status, 200, await res.clone().text());
  }
  const parallel = await Promise.all([1, 2, 3].map(() => confirmCharge("mock", chargeId)));
  assert.ok(parallel.every((o) => o.status === "duplicate"));
  assert.equal((await fsdb().collection(C.transactions).where("storeId", "==", storeA.id).get()).size, 1);
  step("二重計上防止（同じWebhook2回・同時確定3回でも決済履歴は1件）");

  // 6. 占い（1回のみ）→ 結果
  res = await user.req("/api/fortune", { method: "POST", json: { type: "BIRTHDAY", birthDate: "1990-05-12" } });
  assert.equal(res.status, 200);
  res = await user.req("/fortune/result");
  assert.match(await res.text(), /今日の総合運/);
  assert.equal((await fsdb().collection(C.transactions).doc(t.id).get()).get("fortuneStatus"), "COMPLETED");
  step("占い実行 → 結果表示（決済履歴の占い状態も更新）");

  // 7. 期間別のデータを用意（店舗A: 今月1件=上の決済、先月2件、3か月前1件 / 店舗B: 先月1件）
  const thisYm = jstYearMonth();
  const lastYm = shiftYearMonth(thisYm, -1);
  const oldYm = shiftYearMonth(thisYm, -3);
  const mid = (ym: string) => new Date(jstMonthRange(ym).start.getTime() + 10 * 86_400_000);
  await seedTransaction(storeA.id, mid(lastYm));
  await seedTransaction(storeA.id, mid(lastYm));
  await seedTransaction(storeA.id, mid(oldYm));
  await seedTransaction(storeB.id, mid(lastYm));
  // 月末ぎりぎり（日本時間 23:59 = UTC 14:59）は日本時間の月に入る
  const edge = new Date(jstMonthRange(lastYm).end.getTime() - 60_000);
  await seedTransaction(storeB.id, edge);
  assert.equal(jstYearMonth(edge), lastYm);

  // 8. 返金 → 売上から除外（決済代行から「返金済み」と返ってきた場合）
  const refundId = await seedTransaction(storeB.id, mid(lastYm), "mock");
  const beforeRefund = await monthTotals(lastYm, storeB.id);
  const provider = getProvider("mock");
  const orig = provider.retrieveCharge.bind(provider);
  provider.retrieveCharge = async (id: string) => ({ ...(await orig(chargeId))!, id, refunded: true });
  assert.equal(await markRefunded("mock", refundId), true);
  assert.equal(await markRefunded("mock", refundId), false); // 2回目は何もしない
  provider.retrieveCharge = orig;
  const afterRefund = await monthTotals(lastYm, storeB.id);
  assert.deepEqual([beforeRefund.count - afterRefund.count, beforeRefund.gross - afterRefund.gross], [1, 100]);
  const refunded = await fsdb().collection(C.transactions).doc(transactionDocId("mock", refundId)).get();
  assert.deepEqual([refunded.get("paymentStatus"), refunded.get("countable"), refunded.get("amount")], ["REFUNDED", false, 100]);
  step("返金処理（REFUNDED になり売上集計から除外・記録自体は残る）");

  // 9. 店舗別集計・全店舗合計・期間（今月/先月/月指定/全期間）
  const pick = async (key: "this" | "last" | "month" | "all", ym?: string) => {
    const p = resolvePeriod(key, ym);
    const all = await listStores({ range: p.range, sort: "gross", dir: "desc", page: 1, perPage: 100000 });
    const a = all.rows.find((r) => r.id === storeA.id)!;
    const b = all.rows.find((r) => r.id === storeB.id)!;
    const grand = await totalsForRange(p.range);
    const sum = all.rows.reduce((s, r) => ({ c: s.c + r.count, g: s.g + r.gross, s: s.s + r.storeShare, o: s.o + r.operatorShare }), { c: 0, g: 0, s: 0, o: 0 });
    assert.deepEqual(sum, { c: grand.count, g: grand.gross, s: grand.storeShare, o: grand.operatorShare }, `${key}: 店舗ごとの合計 = 全店舗合計`);
    assert.equal(grand.storeShare + grand.operatorShare, grand.gross);
    return { a: [a.count, a.gross, a.storeShare, a.operatorShare], b: [b.count, b.gross, b.storeShare, b.operatorShare], label: p.label };
  };
  assert.deepEqual((await pick("this")).a, [1, 100, 30, 70]);
  assert.deepEqual((await pick("last")).a, [2, 200, 60, 140]);
  assert.deepEqual((await pick("last")).b, [2, 200, 60, 140]); // 月末23:59分を含む・返金分は除外
  assert.deepEqual((await pick("month", oldYm)).a, [1, 100, 30, 70]);
  assert.deepEqual((await pick("all")).a, [4, 400, 120, 280]);
  assert.deepEqual((await pick("all")).b, [2, 200, 60, 140]);
  step("店舗別集計・全店舗合計（今月/先月/月指定/全期間すべて一致・日本時間の月末を正しく判定）");

  // 運営画面（HTTP）で全店舗合計と期間切り替えを確認
  const op = await loggedIn(opId);
  for (const qs of ["period=this", "period=last", "period=all", `period=month&ym=${oldYm}`]) {
    const p = new URLSearchParams(qs);
    const period = resolvePeriod(p.get("period") ?? undefined, p.get("ym") ?? undefined);
    const grand = await totalsForRange(period.range);
    res = await op.req(`/admin/stores?${qs}`);
    assert.equal(res.status, 200);
    const page = await res.text();
    const footer = page.slice(page.indexOf('data-testid="grand-total"'));
    for (const v of [`${grand.count.toLocaleString("ja-JP")}件`, formatYen(grand.gross), formatYen(grand.storeShare), formatYen(grand.operatorShare)]) assert.ok(footer.includes(v), `${qs}: ${v}`);
  }
  res = await op.req("/admin");
  assert.equal(res.status, 200);
  res = await op.req(`/admin/stores/${storeA.id}`);
  assert.equal(res.status, 200);
  assert.match(await res.text(), /店舗作成/); // 監査ログ
  step("運営管理画面（店舗一覧の全店舗合計・期間切り替え・ダッシュボード・店舗詳細と監査ログ）");

  // 10. 店舗ユーザーから他店舗が見えない
  const staff = await loggedIn(staffId);
  res = await staff.req("/store/dashboard");
  const dash = await res.text();
  assert.equal(res.status, 200);
  assert.ok(dash.includes(storeA.name) && !dash.includes(storeB.name));
  for (const w of ["今月の利用件数", "累計利用件数", "¥400", "¥120"]) assert.ok(dash.includes(w), `dashboard: ${w}`);
  res = await staff.req(`/store/sales?storeId=${storeB.id}`);
  const sales = await res.text();
  assert.ok(sales.includes(storeA.name) && !sales.includes(storeB.name));
  assert.equal((await staff.req("/admin/stores")).status, 404);
  res = await staff.req(`/api/store/qr?storeId=${storeB.id}`);
  assert.ok(res.headers.get("content-disposition")?.includes(storeA.storeCode));
  assert.equal((await new Client().req("/store/dashboard")).status, 307);
  step("店舗ユーザーは自店舗のみ（他店舗の売上・運営画面・他店舗QRは不可、今月と累計を表示）");

  // 11. 月次精算（未払い→処理中→支払済、支払済は再集計で変わらない）
  const gen = await generateSettlements(lastYm, SYSTEM);
  assert.ok(gen.upserted >= 2);
  const rows = await listSettlements({ yearMonth: lastYm });
  const sa = rows.find((r) => r.s.storeId === storeA.id)!;
  assert.deepEqual([sa.s.transactionCount, sa.s.grossSales, sa.s.storeShare, sa.s.status], [2, 200, 60, "UNPAID"]);
  await updateSettlementStatus(sa.s.id, "PROCESSING", "", SYSTEM);
  await updateSettlementStatus(sa.s.id, "PAID", "振込済 テスト", SYSTEM);
  await seedTransaction(storeA.id, mid(lastYm)); // 支払済の後に増えても
  await generateSettlements(lastYm, SYSTEM);
  const paid = (await listSettlements({ yearMonth: lastYm })).find((r) => r.s.storeId === storeA.id)!;
  assert.deepEqual([paid.s.status, paid.s.transactionCount, paid.s.storeShare], ["PAID", 2, 60]); // 変更されない
  assert.ok(paid.s.paidAt);
  res = await staff.req("/store/settlements");
  assert.match(await res.text(), /支払済/);
  await assert.rejects(generateSettlements(thisYm, SYSTEM)); // 当月は作成不可
  step("月次精算（作成・未払い→処理中→支払済・支払済は再集計で不変・店舗側に振込状況）");

  // 12. テストモード（無料）は本番売上に入らない
  const countTx = async () => (await fsdb().collection(C.transactions).count().get()).data().count;
  const before = await countTx();
  const logsBefore = (await fsdb().collection(C.testFortuneLogs).count().get()).data().count;
  const grandBefore = await totalsForRange(null);
  const guest = new Client();
  res = await guest.req("/s/test");
  assert.equal(res.status, 200);
  for (const [slug, input] of [
    ["birthday", { type: "BIRTHDAY", birthDate: "1998-06-11" }],
    ["zodiac", { type: "ZODIAC", sign: "leo" }],
    ["blood", { type: "BLOOD", bloodType: "AB", birthMonth: 9 }],
  ] as const) {
    res = await guest.req("/api/test-fortune", { method: "POST", json: { fortuneType: slug } });
    assert.equal(res.status, 200);
    res = await guest.req("/api/fortune", { method: "POST", json: input });
    assert.equal(res.status, 200);
    res = await guest.req("/fortune/result");
    assert.match(await res.text(), /健康運/);
  }
  assert.equal(await countTx(), before);
  assert.deepEqual(await totalsForRange(null), grandBefore);
  assert.equal((await fsdb().collection(C.testFortuneLogs).count().get()).data().count - logsBefore, 3);
  step("テストモード（3種類の無料占い）は決済履歴・売上に入らない（テスト記録のみ3件）");

  // 12b. 無料テストモードの血液型占い v2（48タイプ）：やり直すと文章だけ変化・再読み込みは不変・誕生月で固定部分が変わる
  const starsOf = (html: string) => [...html.matchAll(/aria-label="([^"]+?)(\d)つ星（5段階）"/g)].map((m) => `${m[1]}${m[2]}`).join(",");
  const rarityOf = (html: string) => /(NEW MOON|CRESCENT|HALF MOON|FULL MOON|MIRACLE)/.exec(html)?.[1];
  const goodBloodOf = (html: string) => /今日相性のいい血液型<\/p><p[^>]*><span[^>]*>(A|B|O|AB)<\/span>/.exec(html)?.[1];
  const afterOverall = (html: string) => html.slice(html.indexOf("今日の総合運"));
  const testBlood = async (birthMonth: number) => {
    const g = new Client();
    await g.req("/s/test");
    let r = await g.req("/api/test-fortune", { method: "POST", json: { fortuneType: "blood" } });
    assert.equal(r.status, 200);
    r = await g.req("/fortune/input");
    assert.match(await r.text(), /生まれた月/);
    r = await g.req("/api/fortune", { method: "POST", json: { type: "BLOOD", bloodType: "O", birthMonth } });
    assert.equal(r.status, 200, await r.clone().text());
    const h1 = await (await g.req("/fortune/result")).text();
    const h2 = await (await g.req("/fortune/result")).text();
    assert.equal(afterOverall(h1), afterOverall(h2)); // 再読み込みでは変わらない
    return h1;
  };
  const tA = await testBlood(8);
  const tB = await testBlood(8);
  assert.match(tA, /真夏の太陽リーダー/);
  assert.deepEqual([starsOf(tA), rarityOf(tA), goodBloodOf(tA)], [starsOf(tB), rarityOf(tB), goodBloodOf(tB)]);
  assert.ok(goodBloodOf(tA) && rarityOf(tA) && starsOf(tA).split(",").length >= 5);
  assert.notEqual(afterOverall(tA), afterOverall(tB)); // もう一度テストすると文章・ラッキー系は変わる
  const others = [await testBlood(7), await testBlood(9)];
  assert.match(others[0], /夏空の仲間づくり名人/);
  assert.ok(others.some((h) => `${starsOf(h)}|${rarityOf(h)}|${goodBloodOf(h)}` !== `${starsOf(tA)}|${rarityOf(tA)}|${goodBloodOf(tA)}`));
  assert.equal(await countTx(), before);
  step(`無料テストモードの血液型占い v2（O型×8月=真夏の太陽リーダー・${rarityOf(tA)}。やり直しで★・レア度は同じ・文章は変化、再読み込みは不変、別の月は別の運勢）`);

  // 12c. 無料テストモードの生年月日占い v2：星座・誕生数・今日のナンバー、やり直し・再読み込み
  const BD = "1995-08-10";
  const todayPd = personalDayNumber(8, 10, jstDateString());
  const testBirthday = async () => {
    const g = new Client();
    await g.req("/s/test");
    let r = await g.req("/api/test-fortune", { method: "POST", json: { fortuneType: "birthday" } });
    assert.equal(r.status, 200);
    r = await g.req("/api/fortune", { method: "POST", json: { type: "BIRTHDAY", birthDate: BD } });
    assert.equal(r.status, 200, await r.clone().text());
    const h1 = await (await g.req("/fortune/result")).text();
    const h2 = await (await g.req("/fortune/result")).text();
    assert.equal(afterOverall(h1), afterOverall(h2));
    return h1;
  };
  const bdA = await testBirthday();
  const bdB = await testBirthday();
  // 1995-08-10 → 獅子座・誕生数 1+9+9+5+8+1+0=33（マスターナンバー）
  for (const h of [bdA, bdB]) {
    assert.match(h, /あなたを表す3つのサイン/);
    assert.match(h, /獅子座(<!-- -->)? × 誕生数(<!-- -->)?33/);
    assert.match(h, new RegExp(`今日のナンバー <span[^>]*>${todayPd}</span>`));
    assert.equal(h.includes(BD), false);
  }
  const themeOf = (h: string) => /今日のテーマ<\/p>[\s\S]*?<p class="mt-2[^"]*">([\s\S]*?)<\/p>/.exec(h)?.[1];
  assert.deepEqual([starsOf(bdA), rarityOf(bdA), themeOf(bdA)], [starsOf(bdB), rarityOf(bdB), themeOf(bdB)]);
  assert.ok(themeOf(bdA));
  assert.notEqual(afterOverall(bdA), afterOverall(bdB));
  step(`無料テストモードの生年月日占い v2（獅子座×誕生数33・今日のナンバー${todayPd}・${rarityOf(bdA)}。やり直しで★・レア度・テーマは同じ・文章は変化、再読み込みは不変、生年月日は画面に出ない）`);

  // 13. 停止中店舗は決済不可
  await setStoreStatus(storeA.id, "SUSPENDED", SYSTEM);
  const u2 = new Client();
  await u2.req(`/s/${storeA.storeCode}`);
  res = await u2.req("/api/checkout", { method: "POST", json: { fortuneType: "ZODIAC" } });
  assert.equal(res.status, 403);
  step("停止中の店舗は決済を開始できない");

  // 13b. 12星座占い（v2）：結果の保存・再表示・再購入時の2層構造（他の集計に影響しないよう別店舗で実施）
  const storeC = await createStore({ name: `FS店舗C ${stamp}`, contactName: "", postalCode: "", address: "", phone: "", email: "" }, SYSTEM);
  const buyZodiac = async () => {
    const c = new Client();
    await c.req(`/s/${storeC.storeCode}`);
    let r = await c.req("/api/checkout", { method: "POST", json: { fortuneType: "ZODIAC" } });
    assert.equal(r.status, 201, await r.clone().text());
    r = await c.req("/api/checkout/pay", { method: "POST", json: { cardToken: "mock_tok_success" } });
    assert.equal(r.status, 200);
    for (let i = 0; i < 20; i++) {
      r = await c.req("/api/checkout/status");
      if (((await r.json()) as { status: string }).status === "succeeded") break;
      await sleep(400);
    }
    r = await c.req("/api/fortune", { method: "POST", json: { type: "ZODIAC", sign: "leo" } });
    assert.equal(r.status, 200, await r.clone().text());
    return c;
  };
  const z1 = await buyZodiac();
  const z2 = await buyZodiac();
  const zr = (await fsdb().collection(C.fortuneResults).where("storeId", "==", storeC.id).get()).docs;
  assert.equal(zr.length, 2);
  const [ra, rb] = zr.map((d) => d.get("result"));
  assert.equal(ra.v, 2);
  assert.equal(zr[0].get("engine"), "template-v2");
  assert.ok(["NEW_MOON", "CRESCENT", "HALF_MOON", "FULL_MOON", "MIRACLE"].includes(ra.rarity.key));
  // 同じ日・同じ星座：★・順位・レア度は同じ、文章・ラッキー系は購入ごとに変わる
  assert.deepEqual([ra.rank, ra.overall.stars, ra.love.stars, ra.rarity.key], [rb.rank, rb.overall.stars, rb.love.stars, rb.rarity.key]);
  assert.notDeepEqual(
    [ra.starMessage, ra.action, ra.luckyItem, ra.overall.comment, ra.point, ra.love.comment],
    [rb.starMessage, rb.action, rb.luckyItem, rb.overall.comment, rb.point, rb.love.comment],
  );
  // 再読み込み・別の入力での再送信でも、保存した結果（レア度含む）が変わらない
  const page1 = await (await z1.req("/fortune/result")).text();
  assert.match(page1, new RegExp(ra.rarity.en));
  assert.match(page1, /今日の12星座ランキング/);
  res = await z1.req("/api/fortune", { method: "POST", json: { type: "ZODIAC", sign: "aries" } });
  assert.equal(res.status, 200);
  const again = (await fsdb().collection(C.fortuneResults).where("storeId", "==", storeC.id).get()).docs.map((d) => d.get("result"));
  assert.deepEqual(again.map((r) => JSON.stringify(r)).sort(), [ra, rb].map((r) => JSON.stringify(r)).sort());
  assert.match(await (await z2.req("/fortune/result")).text(), new RegExp(rb.rarity.en));
  step(`12星座占い v2（${ra.rarity.en}・12星座中${ra.rank}位を保存。再購入で★とレア度は同じ・文章は変化。再表示・再送信でも結果は不変）`);

  // 13c. 血液型占い v2（有料）：結果の保存・再購入時の2層構造・別の誕生月
  const buyBlood = async (birthMonth: number) => {
    const c = new Client();
    await c.req(`/s/${storeC.storeCode}`);
    let r = await c.req("/api/checkout", { method: "POST", json: { fortuneType: "BLOOD" } });
    assert.equal(r.status, 201, await r.clone().text());
    r = await c.req("/api/checkout/pay", { method: "POST", json: { cardToken: "mock_tok_success" } });
    assert.equal(r.status, 200);
    for (let i = 0; i < 20; i++) {
      r = await c.req("/api/checkout/status");
      if (((await r.json()) as { status: string }).status === "succeeded") break;
      await sleep(400);
    }
    r = await c.req("/api/fortune", { method: "POST", json: { type: "BLOOD", bloodType: "A", birthMonth } });
    assert.equal(r.status, 200, await r.clone().text());
    return c;
  };
  const p1 = await buyBlood(8);
  await buyBlood(8);
  await buyBlood(7);
  const br = (await fsdb().collection(C.fortuneResults).where("storeId", "==", storeC.id).get()).docs.map((d) => d.get("result")).filter((r) => r.kind === "BLOOD");
  assert.equal(br.length, 3);
  const [x8, y8] = br.filter((r) => r.birthMonth === 8);
  const z7 = br.find((r) => r.birthMonth === 7);
  assert.deepEqual([x8.typeName, z7.typeName], ["陽だまりの実行家", "きらめく段取り上手"]);
  const fixedB = (r: typeof x8) => [r.overall.stars, r.love.stars, r.work.stars, r.money.stars, r.health.stars, r.rarity.key, r.goodBlood.type];
  assert.deepEqual(fixedB(x8), fixedB(y8));
  assert.notDeepEqual([x8.message, x8.goodAction, x8.luckyItem, x8.typeToday, x8.overall.comment], [y8.message, y8.goodAction, y8.luckyItem, y8.typeToday, y8.overall.comment]);
  assert.match(await (await p1.req("/fortune/result")).text(), /陽だまりの実行家/);
  step(`血液型占い v2（A型×8月=${x8.typeName}・${x8.rarity.en} を保存。再購入で★・レア度・相性は同じ・文章は変化、7月生まれは別タイプ）`);

  // 13e. 生年月日占い v2（有料）：同じ生年月日で2回購入、生年月日そのものは保存しない
  const buyBirthday = async (birthDate: string) => {
    const c = new Client();
    await c.req(`/s/${storeC.storeCode}`);
    let r = await c.req("/api/checkout", { method: "POST", json: { fortuneType: "BIRTHDAY" } });
    assert.equal(r.status, 201, await r.clone().text());
    r = await c.req("/api/checkout/pay", { method: "POST", json: { cardToken: "mock_tok_success" } });
    assert.equal(r.status, 200);
    for (let i = 0; i < 20; i++) {
      r = await c.req("/api/checkout/status");
      if (((await r.json()) as { status: string }).status === "succeeded") break;
      await sleep(400);
    }
    r = await c.req("/api/fortune", { method: "POST", json: { type: "BIRTHDAY", birthDate } });
    assert.equal(r.status, 200, await r.clone().text());
    return c;
  };
  const PAID_BD = "1983-02-06"; // 水瓶座・誕生数 29 → 11（マスターナンバー）
  const q1 = await buyBirthday(PAID_BD);
  await buyBirthday(PAID_BD);
  const dr = (await fsdb().collection(C.fortuneResults).where("storeId", "==", storeC.id).get()).docs.map((d) => d.get("result")).filter((r) => r.kind === "BIRTHDAY");
  assert.equal(dr.length, 2);
  const [ba, bb] = dr;
  assert.deepEqual([ba.sign.name, ba.lifePath, ba.isMaster, ba.birthMonth], ["水瓶座", 11, true, 2]);
  const fixedD = (r: typeof ba) => [r.overall.stars, r.love.stars, r.work.stars, r.money.stars, r.health.stars, r.rarity.key, r.personalDay, r.theme.text, r.events];
  assert.deepEqual(fixedD(ba), fixedD(bb));
  assert.notDeepEqual([ba.message, ba.action, ba.caution, ba.luckyItem, ba.luckyNumber, ba.overall.comment], [bb.message, bb.action, bb.caution, bb.luckyItem, bb.luckyNumber, bb.overall.comment]);
  const page = await (await q1.req("/fortune/result")).text();
  assert.match(page, /あなたを表す3つのサイン/);
  assert.equal(page.includes(PAID_BD), false);
  // 生年月日そのものは Firestore のどのコレクションにも保存されない
  for (const col of [C.fortuneResults, C.fortuneSessions, C.checkouts, C.transactions, C.auditLogs, C.testFortuneLogs]) {
    const docs = (await fsdb().collection(col).get()).docs;
    for (const d of docs) {
      const json = JSON.stringify(d.data());
      // この E2E で入力したすべての生年月日（有料・無料テスト）
      for (const form of [PAID_BD, "19830206", BD, "19950810", "1990-05-12", "19900512", "1998-06-11", "19980611"]) assert.equal(json.includes(form), false, `${col}/${d.id} に生年月日`);
    }
  }
  step(`生年月日占い v2（水瓶座×誕生数11・今日のナンバー${ba.personalDay}・${ba.rarity.en} を保存。再購入で★・レア度・テーマは同じ・文章は変化。生年月日はどのコレクションにも無し）`);

  // 13d. 開発用プレビューは本番相当の環境では使えない
  for (const q of ["?type=blood&rarity=MIRACLE", "?rarity=MIRACLE"]) assert.equal((await fetch(`${BASE}/dev/fortune-preview${q}`)).status, 404);
  step("開発用プレビュー（/dev/fortune-preview）は本番相当の環境では 404");

  // 14. 接続確認API
  res = await fetch(`${BASE}/api/health`);
  const health = (await res.json()) as { dataProvider: string; database: string };
  assert.equal(health.dataProvider, "firestore");
  assert.equal(health.database, "ok");
  step("接続確認API（/api/health）で firestore / ok");

  console.log("\nFIRESTORE E2E PASSED");
  process.exit(0);
}

main().catch((e) => {
  console.error("\nFIRESTORE E2E FAILED:", e);
  process.exit(1);
});
