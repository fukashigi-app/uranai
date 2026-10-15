/**
 * 店舗まわりの公開前改善の回帰テスト（Firestore Emulator / ローカルの PostgreSQL の両方で実行できる）。
 *  ① 無料テストモードの利用件数（店舗別・全体・QR再発行前のコード分も合算・有料の件数/売上には入らない）
 *  ② 振込先の登録・変更（暗号化保存・新規と変更の区別・警告に機密情報を出さない・他店舗に影響しない）
 *  ③ パスワードの変更・再発行でログイン状態を無効化（本人の今の端末だけ残す・他のアカウントに影響しない）
 *
 *   Firestore: FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 FIREBASE_PROJECT_ID=demo-uranai-store DB_PROVIDER=firestore npm run e2e:store
 *   PostgreSQL: DATABASE_URL=postgres://…@localhost/… DB_PROVIDER=postgres npm run e2e:store
 * 本番のデータベースには接続しない（Emulator の demo- プロジェクト、または localhost の PostgreSQL だけ）。
 */
import "dotenv/config";
import assert from "node:assert/strict";
import { isFirestore } from "@/lib/data-provider";
import { authenticate } from "@/lib/auth/login";
import { findSessionUser, revokeUserSessions, saveSessionRecord } from "@/lib/auth/session-store";
import { randomToken, sha256Hex } from "@/lib/security/crypto";
import { listRecentBankChanges } from "@/lib/services/bank-changes";
import { monthTotals, totalsForRange } from "@/lib/services/reports";
import {
  createStore,
  createStoreUser,
  getStoreById,
  readBankInfo,
  readBankInfoMasked,
  reissueStoreCode,
  setUserPassword,
  updateBankInfo,
} from "@/lib/services/stores";
import { logTestFortune } from "@/lib/services/test-store";
import { testUsageForStore, testUsageOverall } from "@/lib/services/test-usage";
import { jstYearMonth } from "@/lib/time";
import type { BankInfo } from "@/lib/validation";

let n = 0;
const ok = (msg: string) => console.log(`✔ ${++n}. ${msg}`);
const SYSTEM = { userId: null, role: "SYSTEM" as const };
const OPERATOR = { userId: null, role: "OPERATOR" as const };

function guard() {
  if (isFirestore()) {
    const host = process.env.FIRESTORE_EMULATOR_HOST;
    const project = process.env.FIREBASE_PROJECT_ID;
    if (!host || !project?.startsWith("demo-")) throw new Error("Firestore Emulator（demo- プロジェクト）でのみ実行できます");
  } else {
    const url = process.env.DATABASE_URL ?? "";
    if (!/@(localhost|127\.0\.0\.1)[:/]/.test(url)) throw new Error("ローカルの PostgreSQL（localhost）でのみ実行できます");
  }
}

/** 保存されているデータの生の中身（平文の口座番号が含まれていないかの確認用） */
async function rawStore(storeId: string): Promise<string> {
  if (isFirestore()) {
    const { C, fsdb } = await import("@/lib/firestore/admin");
    return JSON.stringify((await fsdb().collection(C.stores).doc(storeId).get()).data());
  }
  const { db } = await import("@/lib/db");
  const { stores } = await import("@/lib/db/schema");
  const { eq } = await import("drizzle-orm");
  return JSON.stringify(await db().select().from(stores).where(eq(stores.id, storeId)));
}

async function main() {
  guard();
  const stamp = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
  const profile = (name: string) => ({ name, contactName: "", postalCode: "", address: "", phone: "", email: "" });
  const storeA = await createStore(profile(`安全テストA-${stamp}`), SYSTEM);
  const storeB = await createStore(profile(`安全テストB-${stamp}`), SYSTEM);
  const pw = `Init${randomToken(6)}9a`;
  const a1 = String(await createStoreUser(storeA.id, { name: "A1", email: `a1-${stamp}@example.test`, password: pw }, SYSTEM));
  const a2 = String(await createStoreUser(storeA.id, { name: "A2", email: `a2-${stamp}@example.test`, password: pw }, SYSTEM));
  const b1 = String(await createStoreUser(storeB.id, { name: "B1", email: `b1-${stamp}@example.test`, password: pw }, SYSTEM));

  // ===== ① 無料テストモードの利用件数 =====
  const overallBefore = await testUsageOverall();
  await logTestFortune(storeA.storeCode, "ZODIAC");
  await logTestFortune(storeA.storeCode, "BLOOD");
  const newCodeA = await reissueStoreCode(storeA.id, OPERATOR); // QR再発行：以前のコードの分も店舗Aとして数える
  await logTestFortune(newCodeA, "BIRTHDAY");
  await logTestFortune(storeB.storeCode, "ZODIAC");
  await logTestFortune("test", "ZODIAC"); // 店舗に紐づかないテスト店舗（/s/test）
  const storeANow = (await getStoreById(storeA.id))!;
  assert.equal(storeANow.storeCode, newCodeA);
  assert.deepEqual(await testUsageForStore(storeANow), { thisMonth: 3, total: 3 });
  assert.deepEqual(await testUsageForStore(storeB), { thisMonth: 1, total: 1 });
  const overallAfter = await testUsageOverall();
  assert.equal(overallAfter.total - overallBefore.total, 5);
  assert.equal(overallAfter.thisMonth - overallBefore.thisMonth, 5);
  assert.equal(overallAfter.testStore.total - overallBefore.testStore.total, 1);
  // 有料の利用件数・売上・取り分には入らない
  for (const st of [storeA, storeB]) {
    assert.deepEqual(await monthTotals(jstYearMonth(), st.id), { count: 0, gross: 0, storeShare: 0, operatorShare: 0, fee: 0 });
    assert.deepEqual(await totalsForRange(null, st.id), { count: 0, gross: 0, storeShare: 0, operatorShare: 0, fee: 0 });
  }
  ok("無料テストの利用件数：店舗A=3回（QR再発行前のコード分を含む）・店舗B=1回・全体+5回（うちテスト店舗1回）。有料の件数・売上・取り分は0のまま");

  // ===== ② 振込先の登録・変更 =====
  const bank1: BankInfo = { bankName: "テスト銀行", bankCode: "0001", branchName: "本店", branchCode: "001", accountType: "普通", accountNumber: "1234567", accountHolder: "テストタロウ" };
  const bank2: BankInfo = { ...bank1, bankName: "別の銀行", bankCode: "0005", accountNumber: "7654321" };
  await updateBankInfo(storeA.id, bank1, { userId: a1, role: "STORE" });
  let changes = (await listRecentBankChanges()).filter((c) => c.storeId === storeA.id);
  assert.deepEqual(changes.map((c) => [c.kind, c.actorRole]), [["new", "STORE"]]);
  await updateBankInfo(storeA.id, bank2, { userId: a1, role: "STORE" });
  changes = (await listRecentBankChanges()).filter((c) => c.storeId === storeA.id);
  assert.deepEqual(changes.map((c) => c.kind), ["change", "new"]); // 新しい順・新規と変更を区別
  assert.ok(changes[0].at instanceof Date && changes[0].at.getTime() >= changes[1].at.getTime());
  ok("振込先：1回目は「新規登録」、2回目は「変更」として、変更日時・店舗・操作者の区分つきで記録される");

  // 警告データに機密情報を含まない（店舗ID・種類・日時・操作者の区分だけ）
  const all = await listRecentBankChanges();
  for (const c of all) assert.deepEqual(Object.keys(c).sort(), ["actorRole", "at", "kind", "storeId"]);
  const allJson = JSON.stringify(all);
  for (const secret of ["1234567", "7654321", "4567", "4321", "テストタロウ", "テスト銀行", "別の銀行"]) assert.equal(allJson.includes(secret), false, `警告に ${secret} が含まれる`);
  ok("振込先の警告データには口座番号・名義・銀行名を含まない");

  // 暗号化して保存・表示は下4桁だけ・他店舗に影響しない
  const raw = await rawStore(storeA.id);
  assert.equal(raw.includes("7654321"), false, "口座番号が平文で保存されている");
  assert.deepEqual(readBankInfo((await getStoreById(storeA.id))!), bank2);
  assert.equal(readBankInfoMasked((await getStoreById(storeA.id))!)?.accountNumber, "***4321");
  assert.equal(readBankInfoMasked((await getStoreById(storeB.id))!), null);
  assert.equal((await listRecentBankChanges()).some((c) => c.storeId === storeB.id), false);
  ok("振込先は暗号化して保存（平文なし）・表示は下4桁だけ・店舗Bの振込先と警告には影響しない");

  // ===== ③ パスワード変更・再発行でログイン状態を無効化 =====
  const exp = new Date(Date.now() + 3_600_000);
  const h = { a1PC: sha256Hex(randomToken(32)), a1Phone: sha256Hex(randomToken(32)), a2: sha256Hex(randomToken(32)), b1: sha256Hex(randomToken(32)) };
  await saveSessionRecord(h.a1PC, a1, exp);
  await saveSessionRecord(h.a1Phone, a1, exp);
  await saveSessionRecord(h.a2, a2, exp);
  await saveSessionRecord(h.b1, b1, exp);
  for (const k of Object.values(h)) assert.ok(await findSessionUser(k));

  // 本人が PC でパスワードを変更 → PC は残る・スマホは再ログインが必要・同じ店舗の別アカウント・他店舗は影響なし
  const pw2 = `Next${randomToken(6)}9a`;
  await setUserPassword(a1, pw2, { userId: a1, role: "STORE" }, h.a1PC);
  assert.equal((await findSessionUser(h.a1PC))?.id, a1);
  assert.equal(await findSessionUser(h.a1Phone), null);
  assert.equal((await findSessionUser(h.a2))?.id, a2);
  assert.equal((await findSessionUser(h.b1))?.id, b1);
  assert.equal((await authenticate(`a1-${stamp}@example.test`, pw2, "STORE")).ok, true);
  assert.equal((await authenticate(`a1-${stamp}@example.test`, pw, "STORE")).ok, false);
  ok("本人がパスワードを変更：今の端末だけ残り、他の端末は無効。同じ店舗の別アカウント・他店舗のアカウントは影響なし");

  // 運営がパスワードを再発行 → そのアカウントの全端末が無効・他は影響なし
  await setUserPassword(a1, `Temp${randomToken(6)}9a`, OPERATOR);
  assert.equal(await findSessionUser(h.a1PC), null);
  assert.equal((await findSessionUser(h.a2))?.id, a2);
  assert.equal((await findSessionUser(h.b1))?.id, b1);
  // 無効化の対象は指定したユーザーだけ（存在しないユーザーを指定しても他に影響しない）
  assert.equal(await revokeUserSessions("00000000-0000-4000-8000-000000000000"), 0);
  assert.equal((await findSessionUser(h.b1))?.id, b1);
  ok("運営がパスワードを再発行：そのアカウントの全端末が無効（再ログインが必要）。他のアカウントは影響なし");
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error("STORE SECURITY E2E FAILED:", e);
    process.exit(1);
  },
);
