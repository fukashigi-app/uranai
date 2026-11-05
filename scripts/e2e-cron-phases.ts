/**
 * 定期処理（/api/cron/maintenance）の段階の実行・全体のロック・実行の記録・メンテナンスの件数と時間の上限の E2E 検証。
 * Firestore Emulator の demo- プロジェクトだけを使う（本物の Stripe・本番の Firebase には一切接続しない）。
 * Stripe の設定は無いので、Webhook の復旧・再確認の回収は「Stripe を使えない」で何もしない（段階としては実行される）。
 * 検証の途中でこのプロジェクトのデータを消すので、専用の demo- プロジェクトで実行する。
 *
 *   firebase emulators:start --only firestore --project demo-uranai
 *   （別ターミナル）FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 FIREBASE_PROJECT_ID=demo-uranai-cron-phases DB_PROVIDER=firestore \
 *       SESSION_SECRET=... npm run e2e:cron-phases
 */
import "dotenv/config";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { C, fsdb } from "@/lib/firestore/admin";
import { dataProvider } from "@/lib/data-provider";
import { acquireCronLock, CRON_LOCK_TTL_MS, isCronLockOwner, recordCronRun, releaseCronLock } from "@/lib/firestore/cron-run";
import { runMaintenance } from "@/lib/firestore/misc";

const step = (msg: string) => console.log(`  ✓ ${msg}`);
const DAY = 86_400_000;

async function resetProject() {
  const host = process.env.FIRESTORE_EMULATOR_HOST!;
  const project = process.env.FIREBASE_PROJECT_ID!;
  assert.match(project, /^demo-/);
  let status = 0;
  for (let i = 0; i < 20 && status !== 200; i++) {
    if (i) await new Promise((ok) => setTimeout(ok, 500));
    status = (await fetch(`http://${host}/emulator/v1/projects/${project}/databases/(default)/documents`, { method: "DELETE" })).status;
  }
  assert.equal(status, 200, "Emulator のデータを消せませんでした");
}

const lockDoc = () => fsdb().collection(C.system).doc("cronLock");
const runDoc = () => fsdb().collection(C.system).doc("cronRun");

async function main() {
  const host = process.env.FIRESTORE_EMULATOR_HOST ?? "";
  assert.match(host, /^(127\.0\.0\.1|localhost|\[::1\]):\d+$/, "FIRESTORE_EMULATOR_HOST（localhost の Emulator）が必要です");
  assert.match(process.env.FIREBASE_PROJECT_ID ?? "", /^demo-/, "FIREBASE_PROJECT_ID は demo- で始まる Emulator 用の ID にしてください");
  assert.ok(!process.env.VERCEL_ENV, "Vercel 上では実行しません");
  assert.equal(dataProvider(), "firestore");
  // Stripe は使わない（復旧・回収は「Stripe を使えない」で何もしない）
  for (const k of ["STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET", "STRIPE_TEST_CHECKOUT", "STRIPE_LIVE_CHECKOUT", "STRIPE_LIVE_OPERATOR_TEST", "STRIPE_API_BASE"]) delete process.env[k];
  if (!process.env.SESSION_SECRET) process.env.SESSION_SECRET = randomBytes(24).toString("hex");
  process.env.CRON_SECRET = randomBytes(24).toString("hex");
  console.log(`Cron phases E2E (emulator ${host} / ${process.env.FIREBASE_PROJECT_ID})`);
  await resetProject();

  // ---- 1. ロック：同時に取得しても1つだけ。所有者の ID が違えば解除・記録できない ----
  const now = new Date();
  const results = await Promise.all(Array.from({ length: 6 }, () => acquireCronLock(now)));
  const won = results.filter((r) => r.ok);
  assert.equal(won.length, 1, `同時の取得で ${won.length} 件が取得しました`);
  const owner = (won[0] as { ownerId: string }).ownerId;
  assert.ok(await isCronLockOwner(owner));
  assert.equal(await isCronLockOwner("someone-else"), false);
  assert.equal(await releaseCronLock("someone-else"), false, "別の所有者がロックを外しました");
  assert.ok((await lockDoc().get()).exists);
  assert.equal(await recordCronRun("someone-else", { status: "completed", startedAt: now, finishedAt: now, phases: [] }), false, "別の所有者が実行の記録を上書きしました");
  assert.equal(await releaseCronLock(owner), true);
  assert.equal((await lockDoc().get()).exists, false);
  step("ロック：同時に6回取得しても1つだけ。所有者の ID が違えば解除・終了の記録はできない。所有者は解除できる");

  // ---- 2. 期限切れのロック（強制終了された定期処理）は次の定期処理が取得できる。期限内なら取得できない ----
  await lockDoc().set({ ownerId: "killed-run", acquiredAt: new Date(now.getTime() - CRON_LOCK_TTL_MS - 1000), expiresAt: new Date(now.getTime() - 1000) });
  const taken = await acquireCronLock(now);
  assert.ok(taken.ok && taken.tookOverExpired, "期限切れのロックを取得できませんでした");
  assert.equal(await isCronLockOwner("killed-run"), false);
  assert.equal(await releaseCronLock("killed-run"), false, "古い所有者が新しいロックを外しました");
  await releaseCronLock((taken as { ownerId: string }).ownerId);
  await lockDoc().set({ ownerId: "running-run", acquiredAt: now, expiresAt: new Date(now.getTime() + 60_000) });
  const busy = await acquireCronLock(now);
  assert.equal(busy.ok, false, "期限内のロックを取得しました");
  await lockDoc().delete();
  step("期限切れのロック（強制終了）は次の定期処理が取得し、古い所有者は外せない。期限内のロックは取得できない");

  // ---- 3. 定期処理のルート：段階の記録・ロックの解除・二重実行 ----
  const { GET } = await import("@/app/api/cron/maintenance/route");
  const call = () => GET(new Request("http://localhost/api/cron/maintenance", { headers: { authorization: `Bearer ${process.env.CRON_SECRET}` } }));
  assert.equal((await GET(new Request("http://localhost/api/cron/maintenance"))).status, 401);
  let res = await call();
  assert.equal(res.status, 200, await res.clone().text());
  const body = (await res.json()) as Record<string, unknown>;
  assert.deepEqual([(body.webhookRecovery as { status: string }).status, (body.recheckRecovery as { status: string }).status], ["skipped", "skipped"]); // Stripe を使えない（段階としては成功）
  assert.equal(body.truncatedTasks, 0);
  const run = (await runDoc().get()).data()!;
  assert.equal(run.lastStatus, "completed");
  assert.deepEqual(
    (run.lastPhases as { name: string; status: string }[]).map((p) => [p.name, p.status]),
    [
      ["maintenance", "ok"],
      ["webhookRecovery", "ok"],
      ["recheckRecovery", "ok"],
    ],
  );
  assert.equal(run.currentStatus, "finished");
  assert.ok(typeof run.lastDurationMs === "number" && run.lastDurationMs >= 0);
  for (const p of run.lastPhases as { durationMs: number; startedAtMs: number }[]) assert.ok(p.durationMs >= 0 && p.startedAtMs >= 0);
  assert.equal((await lockDoc().get()).exists, false, "終了の後にロックが残っています");
  const maint = (await fsdb().collection(C.system).doc("maintenance").get()).data()!;
  assert.equal(maint.lastStatus, "success");
  const { webhookRecovery: _w, recheckRecovery: _r, ...maintResult } = body;
  assert.deepEqual(maintResult, maint.lastResult, "応答のメンテナンスの結果が記録と一致しません");
  const saved = JSON.stringify(run);
  assert.ok(!saved.includes(process.env.CRON_SECRET!) && !saved.includes(process.env.SESSION_SECRET!), "秘密の値が記録されました");
  step("定期処理：メンテナンス → Webhook の復旧 → 再確認の回収を段階として実行し、段階ごとの結果・時間を system/cronRun に記録。終了の後にロックを外す");

  // 同時に呼ばれても、実行は1つだけ（ほかは cron_busy）。メンテナンスに数秒かかるよう、対象外の古い記録を入れて実行を重ねる
  for (let b = 0; b < 4; b++) {
    const batch = fsdb().batch();
    for (let i = 0; i < 400; i++) batch.set(fsdb().collection(C.fortuneSessions).doc(`slow_${b}_${i}`), { status: "USED", expiresAt: new Date(Date.now() - DAY - i) });
    await batch.commit();
  }
  const both = await Promise.all([call(), call(), call()]);
  const bodies = await Promise.all(both.map((r) => r.json() as Promise<Record<string, unknown>>));
  const ran = bodies.filter((b) => "webhookRecovery" in b);
  const skipped = bodies.filter((b) => b.skipped === "cron_busy");
  assert.equal(ran.length, 1, `同時の呼び出しで ${ran.length} 件が実行されました: ${JSON.stringify(bodies)}`);
  assert.equal(skipped.length, 2);
  for (const r of both) assert.equal(r.status, 200);
  step("同時に3回呼ばれても、実行は1つだけ（ほかは何もせず 200・cron_busy）");

  // 実行中のロック（強制終了された定期処理の、期限内のロック）がある間は実行しない。期限が過ぎれば実行する
  await lockDoc().set({ ownerId: "stuck-run", acquiredAt: new Date(), expiresAt: new Date(Date.now() + 60_000) });
  res = await call();
  assert.deepEqual(await res.json(), { ok: true, skipped: "cron_busy" });
  await lockDoc().set({ ownerId: "stuck-run", acquiredAt: new Date(Date.now() - CRON_LOCK_TTL_MS), expiresAt: new Date(Date.now() - 1) });
  res = await call();
  assert.equal(res.status, 200);
  assert.ok("webhookRecovery" in ((await res.json()) as object));
  assert.equal((await lockDoc().get()).exists, false);
  step("期限内のロックがある間は実行せず、期限が過ぎたら次の定期処理が実行する（強制終了からの回復）");

  // ---- 4. メンテナンスの件数・時間の上限（対象の条件は変えない） ----
  await resetProject();
  const db = fsdb();
  const t = Date.now();
  // 期限切れの占い権利：PAID 12件（新しいものほど期限が最近）と、対象外（USED）20件（古い）
  for (let i = 0; i < 12; i++) {
    await db.collection(C.fortuneSessions).doc(`paid_${String(i).padStart(2, "0")}`).set({ status: "PAID", expiresAt: new Date(t - (i + 1) * 60_000), transactionId: `tx_${i}` });
    await db.collection(C.transactions).doc(`tx_${i}`).set({ fortuneStatus: "PAID" });
  }
  for (let i = 0; i < 20; i++) await db.collection(C.fortuneSessions).doc(`used_${i}`).set({ status: "USED", expiresAt: new Date(t - 10 * DAY - i * 60_000), transactionId: `txu_${i}` });
  // 期限内の PAID（対象外）
  await db.collection(C.fortuneSessions).doc("paid_future").set({ status: "PAID", expiresAt: new Date(t + DAY), transactionId: "tx_future" });
  // 30日を過ぎた占い結果 7件・過ぎていない 2件
  for (let i = 0; i < 7; i++) await db.collection(C.fortuneResults).doc(`old_${i}`).set({ createdAt: new Date(t - 31 * DAY - i * 1000) });
  for (let i = 0; i < 2; i++) await db.collection(C.fortuneResults).doc(`new_${i}`).set({ createdAt: new Date(t - DAY) });
  // 7日を過ぎた注文：未決済（削除対象）4件、決済済み（providerPaymentId あり・残す）3件、処理中の古い注文（FAILED に）1件
  for (let i = 0; i < 4; i++) await db.collection(C.checkouts).doc(`co_old_${i}`).set({ status: "EXPIRED", createdAt: new Date(t - 8 * DAY), expiresAt: new Date(t - 8 * DAY) });
  for (let i = 0; i < 3; i++) await db.collection(C.checkouts).doc(`co_paid_${i}`).set({ status: "SUCCEEDED", providerPaymentId: `cs_test_${i}`, createdAt: new Date(t - 8 * DAY), expiresAt: new Date(t - 8 * DAY) });
  await db.collection(C.checkouts).doc("co_stale").set({ status: "PROCESSING", processingStartedAt: new Date(t - 20 * 60_000), createdAt: new Date(t - 20 * 60_000), expiresAt: new Date(t + 60_000) });

  // 時間の上限0：何も処理せず、すべての処理を打ち切りとして数える
  let m = await runMaintenance({ deadlineMs: 0 });
  assert.deepEqual(m, { expiredSessions: 0, expiredCheckouts: 0, purgedResults: 0, purgedCheckouts: 0, truncatedTasks: 8 }); // 8つの処理すべて
  assert.equal((await db.collection(C.fortuneSessions).doc("paid_00").get()).get("status"), "PAID");
  // 件数の上限（1ページ5件・1処理10件）：期限が最近の PAID から処理し、打ち切りを数える
  m = await runMaintenance({ pageSize: 5, maxScanPerTask: 10 });
  assert.equal(m.expiredSessions, 10, JSON.stringify(m));
  assert.ok(m.truncatedTasks >= 1);
  assert.equal((await db.collection(C.fortuneSessions).doc("paid_00").get()).get("status"), "EXPIRED", "期限が最近の権利が処理されていません");
  assert.equal((await db.collection(C.fortuneSessions).doc("paid_11").get()).get("status"), "PAID", "上限を超えた分まで処理されました");
  assert.equal((await db.collection(C.transactions).doc("tx_0").get()).get("fortuneStatus"), "EXPIRED");
  // 2回目：残りを処理する（処理済みは EXPIRED なので対象外）
  m = await runMaintenance({ pageSize: 5, maxScanPerTask: 40 });
  assert.equal(m.expiredSessions, 2, JSON.stringify(m));
  for (let i = 0; i < 12; i++) assert.equal((await db.collection(C.fortuneSessions).doc(`paid_${String(i).padStart(2, "0")}`).get()).get("status"), "EXPIRED");
  for (let i = 0; i < 20; i++) assert.equal((await db.collection(C.fortuneSessions).doc(`used_${i}`).get()).get("status"), "USED", "対象外の権利を変更しました");
  assert.equal((await db.collection(C.fortuneSessions).doc("paid_future").get()).get("status"), "PAID", "期限内の権利を変更しました");
  // 削除・処理中の対象の条件は今までどおり
  assert.equal((await db.collection(C.fortuneResults).get()).size, 2, "30日以内の占い結果を消した、または古い結果が残っています");
  const left = (await db.collection(C.checkouts).get()).docs.map((d) => d.id).sort();
  assert.deepEqual(left, ["co_paid_0", "co_paid_1", "co_paid_2", "co_stale"], "決済済みの注文を消した、または未決済の古い注文が残っています");
  assert.deepEqual([(await db.collection(C.checkouts).doc("co_stale").get()).get("status"), (await db.collection(C.checkouts).doc("co_stale").get()).get("failureCode")], ["FAILED", "stale_processing"]);
  // 既定の上限では、すべてを1回で処理する（打ち切り0）
  m = await runMaintenance();
  assert.equal(m.truncatedTasks, 0);
  step("メンテナンス：時間の上限0では何も変えずに打ち切りを数える。件数の上限では期限が最近のものから処理して残りは次回。対象の条件（PAID だけ・期限内は対象外・決済済みの注文は残す・30日・7日・15分）は今までどおり");

  await resetProject();
  console.log("\nCRON PHASES E2E PASSED");
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("\nCRON PHASES E2E FAILED:", e);
    process.exit(1);
  });
