/**
 * 初回の運営アカウント作成（/admin/setup）の検証。Firestore Emulator 上でのみ実行する（本番には接続しない）。
 *   FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 FIREBASE_PROJECT_ID=demo-uranai npm run e2e:setup
 */
import "dotenv/config";
import assert from "node:assert/strict";
import { C, fsdb } from "@/lib/firestore/admin";
import { authenticate } from "@/lib/auth/login";
import { createInitialOperator, isInitialSetupDone } from "@/lib/services/setup";
import { createStore, createStoreUser, DuplicateEmailError } from "@/lib/services/stores";

const host = process.env.FIRESTORE_EMULATOR_HOST;
const project = process.env.FIREBASE_PROJECT_ID;

async function clearEmulator() {
  // Emulator 専用のデータ全削除 API（本番 Firestore には存在しない）
  const res = await fetch(`http://${host}/emulator/v1/projects/${project}/databases/(default)/documents`, { method: "DELETE" });
  assert.equal(res.status, 200, "emulator clear failed");
}

let step = 0;
const ok = (msg: string) => console.log(`✔ ${++step}. ${msg}`);

async function main() {
  if (!host || !project?.startsWith("demo-")) throw new Error("Firestore Emulator（demo- プロジェクト）でのみ実行できます");
  await clearEmulator();

  assert.equal(await isInitialSetupDone(), false);
  ok("運営アカウントが無い状態では初期設定は未完了");

  // 店舗スタッフが居ても運営アカウントが無ければ作成できる。ただし同じメールは使えない
  const store = await createStore({ name: "既存店舗", contactName: "", postalCode: "", address: "", phone: "", email: "" }, { userId: null, role: "SYSTEM" });
  await createStoreUser(store.id, { name: "店舗", email: "staff@example.com", password: "StoreUser123" }, { userId: null, role: "SYSTEM" });
  assert.equal(await isInitialSetupDone(), false);
  await assert.rejects(createInitialOperator({ name: "x", email: "staff@example.com", password: "Operator1234" }), DuplicateEmailError);
  assert.equal(await isInitialSetupDone(), false);
  ok("店舗スタッフと同じメールでは作成できず、初期設定は未完了のまま");

  // 同時に10回送信しても作成されるのは1件だけ
  const results = await Promise.all(
    Array.from({ length: 10 }, (_, i) => createInitialOperator({ name: "運営", email: `owner${i}@example.com`, password: "Operator1234" })),
  );
  assert.equal(results.filter((r) => r === "created").length, 1, JSON.stringify(results));
  assert.equal(results.filter((r) => r === "done").length, 9);
  const ops = await fsdb().collection(C.users).where("role", "==", "OPERATOR").get();
  assert.equal(ops.size, 1);
  ok("同時10回の送信でも運営アカウントは1件だけ作成");

  const op = ops.docs[0];
  const email = String(op.get("email"));
  const hash = String(op.get("passwordHash"));
  assert.match(hash, /^scrypt\$/);
  assert.ok(!JSON.stringify(op.data()).includes("Operator1234"));
  ok("パスワードは scrypt ハッシュのみ保存（平文なし）");

  const login = await authenticate(email, "Operator1234", "OPERATOR");
  assert.equal(login.ok, true);
  ok("作成した運営アカウントで既存のログイン処理が通る");

  assert.equal(await isInitialSetupDone(), true);
  assert.equal(await createInitialOperator({ name: "後から", email: "late@example.com", password: "Operator1234" }), "done");
  ok("作成後は二度と作成できない");

  // 運営アカウントを消しても、作成済みの印があるので再び使えるようにはならない
  await op.ref.delete();
  await fsdb().collection(C.userEmails).doc(email).delete();
  assert.equal(await isInitialSetupDone(), true);
  assert.equal(await createInitialOperator({ name: "再作成", email: "again@example.com", password: "Operator1234" }), "done");
  ok("運営アカウントを削除しても初期設定画面は無効のまま（永久に無効化）");

  const audit = await fsdb().collection(C.auditLogs).where("action", "==", "admin.setup").get();
  assert.equal(audit.size, 1);
  ok("監査ログに1件だけ記録");

  console.log("\nALL PASSED");
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
