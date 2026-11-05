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
  for (const k of ["STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET", "STRIPE_TEST_CHECKOUT", "STRIPE_LIVE_CHECKOUT", "STRIPE_LIVE_OPERATOR_TEST", "STRIPE_NEW_CHECKOUT", "STRIPE_API_BASE"]) delete process.env[k];
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
      ["paymentMonitor", "ok"],
    ],
  );
  // 決済監視の点検（Stripe の設定が無いので Firestore の点検だけ）：結果・件数・時刻を記録し、点検の記録（system/paymentMonitor）も更新
  const pm = run.lastPaymentMonitor as { status: string; found: number; uncheckedCount: number; finishedAt: { toDate(): Date } };
  assert.ok(["ok", "issues", "partial"].includes(pm.status), JSON.stringify(pm));
  assert.ok(typeof pm.found === "number" && typeof pm.uncheckedCount === "number" && pm.finishedAt);
  const mon = (await fsdb().collection(C.system).doc("paymentMonitor").get()).data()!;
  assert.equal(mon.currentSource, "cron");
  assert.equal(mon.lastResult, pm.status);
  assert.ok(mon.lastFinishedAt.toDate().getTime() <= pm.finishedAt.toDate().getTime() + 1000);
  assert.equal((await fsdb().collection(C.system).doc("paymentMonitorLock").get()).exists, false, "点検のロックが残っています");
  assert.deepEqual((body.paymentMonitor as { status: string }).status, pm.status);
  assert.equal(run.currentStatus, "finished");
  assert.equal(run.lastNotification.status, "not_configured", "送信先が未登録なのに通知しようとしました");
  assert.ok(typeof run.lastDurationMs === "number" && run.lastDurationMs >= 0);
  for (const p of run.lastPhases as { durationMs: number; startedAtMs: number }[]) assert.ok(p.durationMs >= 0 && p.startedAtMs >= 0);
  assert.equal((await lockDoc().get()).exists, false, "終了の後にロックが残っています");
  const maint = (await fsdb().collection(C.system).doc("maintenance").get()).data()!;
  assert.equal(maint.lastStatus, "success");
  const { webhookRecovery: _w, recheckRecovery: _r, paymentMonitor: _p, ...maintResult } = body;
  assert.deepEqual(maintResult, maint.lastResult, "応答のメンテナンスの結果が記録と一致しません");
  const saved = JSON.stringify(run);
  assert.ok(!saved.includes(process.env.CRON_SECRET!) && !saved.includes(process.env.SESSION_SECRET!), "秘密の値が記録されました");
  step("定期処理：メンテナンス → Webhook の復旧 → 再確認の回収 → 決済監視を段階として実行し、段階ごとの結果・時間と監視の要約（結果・件数・時刻）を system/cronRun に記録。終了の後にロックを外す");

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

  // 決済監視の点検が別の場所（運営画面の「今すぐ点検」）で実行中：点検は始めず busy と記録。ほかの段階はそのまま
  await fsdb().collection(C.system).doc("paymentMonitorLock").set({ runId: "admin-run", source: "admin", acquiredAt: new Date(), expiresAt: new Date(Date.now() + 60_000) });
  res = await call();
  assert.equal(res.status, 200);
  assert.equal(((await res.json()) as { paymentMonitor: { status: string } }).paymentMonitor.status, "busy");
  const runBusy = (await runDoc().get()).data()!;
  assert.deepEqual(
    (runBusy.lastPhases as { name: string; status: string; reason: string | null }[]).map((p) => [p.name, p.status, p.reason]),
    [
      ["maintenance", "ok", null],
      ["webhookRecovery", "ok", null],
      ["recheckRecovery", "ok", null],
      ["paymentMonitor", "skipped", "busy"],
    ],
  );
  assert.deepEqual([runBusy.lastStatus, runBusy.lastPaymentMonitor.status], ["partial", "busy"]);
  assert.equal((await fsdb().collection(C.system).doc("paymentMonitorLock").get()).get("runId"), "admin-run", "実行中の点検のロックを外しました");
  await fsdb().collection(C.system).doc("paymentMonitorLock").delete();
  step("決済監視の点検が実行中（運営画面など）：点検を始めず busy（正常の実行と区別）。実行中の点検のロックは外さない。ほかの段階は実行");

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
  assert.deepEqual(m, { expiredSessions: 0, expiredCheckouts: 0, purgedResults: 0, purgedCheckouts: 0, truncatedTasks: 8, tasksWithRemaining: 8, conflictsSkipped: 0 }); // 8つの処理すべて
  assert.equal((await db.collection(C.fortuneSessions).doc("paid_00").get()).get("status"), "PAID");
  const tasks0 = (await db.collection(C.system).doc("maintenanceTasks").get()).get("lastTasks") as { task: string; stoppedBy: string | null }[];
  assert.ok(tasks0.every((x) => x.stoppedBy === "time"), "時間の上限で止まった理由が記録されていません");
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
  const tasks = (await db.collection(C.system).doc("maintenanceTasks").get()).data()!;
  assert.deepEqual(
    (tasks.lastTasks as { task: string }[]).map((x) => x.task),
    ["purgeResults", "purgeCheckouts", "purgeAuthSessions", "failStaleProcessing", "expireSessions", "expireCheckouts", "purgeWebhookEvents", "purgeRateLimits"],
    "処理の順序（保存期間の削除が最初）が違います",
  );
  for (const x of tasks.lastTasks as Record<string, unknown>[]) for (const k of ["scanned", "processed", "conflicts", "truncated", "hasMore"]) assert.ok(k in x, `${String(x.task)} に ${k} がありません`);
  step("処理ごとの件数・競合・打ち切り・残りの有無を system/maintenanceTasks に記録。保存期間の削除（占い結果・未決済の注文・ログイン）を最初に実行");

  // ---- 5. 取り残しの防止：対象外の記録に埋もれた古い対象も、続きの位置から古い順に読んでいずれ処理する ----
  await resetProject();
  for (let i = 0; i < 15; i++) await db.collection(C.fortuneSessions).doc(`old_used_${String(i).padStart(2, "0")}`).set({ status: "USED", expiresAt: new Date(t - 30 * DAY + i * 60_000), transactionId: "x" });
  await db.collection(C.fortuneSessions).doc("buried_paid").set({ status: "PAID", expiresAt: new Date(t - 20 * DAY), transactionId: "tx_buried" });
  await db.collection(C.transactions).doc("tx_buried").set({ fortuneStatus: "PAID" });
  for (let i = 0; i < 15; i++) await db.collection(C.fortuneSessions).doc(`new_used_${String(i).padStart(2, "0")}`).set({ status: "USED", expiresAt: new Date(t - DAY + i * 60_000), transactionId: "x" });
  const LIM = { pageSize: 5, headScanPerTask: 10, maxScanPerTask: 20 };
  m = await runMaintenance(LIM);
  assert.equal((await db.collection(C.fortuneSessions).doc("buried_paid").get()).get("status"), "PAID", "1回目で届かないはずの記録が処理されました（検証の前提）");
  assert.ok(m.tasksWithRemaining >= 1);
  const t5 = ((await db.collection(C.system).doc("maintenanceTasks").get()).get("lastTasks") as { task: string; stoppedBy: string | null }[]).find((x) => x.task === "expireSessions")!;
  assert.equal(t5.stoppedBy, "cap", "続きの位置からの読み込み（通常の区切り）が、時間の上限として記録されました");
  const cur1 = (await db.collection(C.system).doc("maintenanceCursors").get()).get("expireSessions") as { id: string };
  assert.equal(cur1.id, "old_used_09", "続きの位置が古い順の10件目ではありません");
  m = await runMaintenance(LIM);
  assert.equal(m.expiredSessions, 1);
  assert.equal((await db.collection(C.fortuneSessions).doc("buried_paid").get()).get("status"), "EXPIRED", "埋もれた期限切れの権利が2回目でも処理されません");
  assert.equal((await db.collection(C.transactions).doc("tx_buried").get()).get("fortuneStatus"), "EXPIRED");
  // 3回目：最後まで読み、続きの位置は最初に戻る
  await runMaintenance(LIM);
  await runMaintenance(LIM);
  assert.equal((await db.collection(C.system).doc("maintenanceCursors").get()).get("expireSessions"), null, "一周した後に続きの位置が最初に戻りません");
  // すべてが対象の削除は古い順（30日を過ぎた占い結果：古いものから消える）
  for (let i = 0; i < 8; i++) await db.collection(C.fortuneResults).doc(`r_${i}`).set({ createdAt: new Date(t - 31 * DAY - i * DAY) }); // r_7 が最も古い
  m = await runMaintenance({ pageSize: 3, maxScanPerTask: 3 });
  const remain = (await db.collection(C.fortuneResults).get()).docs.map((d) => d.id).sort();
  assert.deepEqual(remain, ["r_0", "r_1", "r_2", "r_3", "r_4"], "古い順に削除されていません");
  step("取り残しの防止：対象外の記録に埋もれた期限切れの権利も、続きの位置から古い順に読んで2回目で処理。一周したら最初に戻る。すべてが対象の削除は古い順");

  // ---- 6. 保存期間の境界（30日・7日・15分）は今までどおり ----
  await resetProject();
  const H = 3_600_000;
  await db.collection(C.fortuneResults).doc("r_keep").set({ createdAt: new Date(t - 30 * DAY + H) });
  await db.collection(C.fortuneResults).doc("r_del").set({ createdAt: new Date(t - 30 * DAY - H) });
  await db.collection(C.checkouts).doc("c_keep").set({ status: "EXPIRED", createdAt: new Date(t - 7 * DAY + H), expiresAt: new Date(t - 7 * DAY + H) });
  await db.collection(C.checkouts).doc("c_del").set({ status: "FAILED", createdAt: new Date(t - 7 * DAY - H), expiresAt: new Date(t - 7 * DAY - H) });
  // 保存期間＋間隔＋ずれ（8日と2時間）を過ぎて残っていた未決済の注文：削除し、遅れていた件数として数える。決済済みの古い注文は数えない
  await db.collection(C.checkouts).doc("c_overdue").set({ status: "CREATED", createdAt: new Date(t - 9 * DAY), expiresAt: new Date(t - 9 * DAY) });
  await db.collection(C.checkouts).doc("c_paid_old").set({ status: "SUCCEEDED", providerPaymentId: "cs_test_old", createdAt: new Date(t - 20 * DAY), expiresAt: new Date(t - 20 * DAY) });
  await db.collection(C.checkouts).doc("c_refunded").set({ status: "REFUNDED", providerPaymentId: "cs_test_r", createdAt: new Date(t - 8 * DAY), expiresAt: new Date(t - 8 * DAY) });
  await db.collection(C.checkouts).doc("p_keep").set({ status: "PROCESSING", processingStartedAt: new Date(Date.now() - 14 * 60_000), createdAt: new Date(), expiresAt: new Date(t + H) });
  await db.collection(C.checkouts).doc("p_fail").set({ status: "PROCESSING", processingStartedAt: new Date(Date.now() - 16 * 60_000), createdAt: new Date(), expiresAt: new Date(t + H) });
  await db.collection(C.checkouts).doc("p_paid").set({ status: "PROCESSING", providerPaymentId: "cs_test_p", processingStartedAt: new Date(Date.now() - 60 * 60_000), createdAt: new Date(), expiresAt: new Date(t + H) });
  await runMaintenance();
  const ids = async (c: string) => (await db.collection(c).get()).docs.map((d) => d.id).sort();
  assert.deepEqual(await ids(C.fortuneResults), ["r_keep"]);
  assert.deepEqual(await ids(C.checkouts), ["c_keep", "c_paid_old", "c_refunded", "p_fail", "p_keep", "p_paid"]);
  const pc = ((await db.collection(C.system).doc("maintenanceTasks").get()).get("lastTasks") as { task: string; overdueFound: number; stoppedBy: string | null; processed: number }[]).find((x) => x.task === "purgeCheckouts")!;
  assert.deepEqual([pc.processed, pc.overdueFound, pc.stoppedBy], [2, 1, null], JSON.stringify(pc));
  const st = async (id: string) => (await db.collection(C.checkouts).doc(id).get()).get("status");
  assert.deepEqual([await st("c_refunded"), await st("p_keep"), await st("p_fail"), await st("p_paid")], ["REFUNDED", "PROCESSING", "FAILED", "PROCESSING"]);
  step("保存期間・状態の区切り（占い結果30日・未決済の注文7日・課金不明の処理中15分）と、返金済み・決済済みの注文を残す条件は今までどおり。期限を過ぎて残っていた未決済の注文だけを遅れとして実数で数える");

  // ---- 7. 競合の防止：読んだ後に Webhook の確定・利用で変わった記録は上書きしない（次の回に回す） ----
  await resetProject();
  for (let i = 0; i < 3; i++) await db.collection(C.checkouts).doc(`exp_${i}`).set({ status: "CREATED", createdAt: new Date(t - DAY), expiresAt: new Date(t - 60_000 * (i + 1)) });
  await db.collection(C.fortuneSessions).doc("s_race").set({ status: "PAID", expiresAt: new Date(t - 60_000), transactionId: "tx_race" });
  await db.collection(C.transactions).doc("tx_race").set({ fortuneStatus: "PAID", paymentStatus: "SUCCEEDED" });
  await db.collection(C.fortuneSessions).doc("s_ok").set({ status: "PAID", expiresAt: new Date(t - 120_000), transactionId: "tx_ok" });
  await db.collection(C.transactions).doc("tx_ok").set({ fortuneStatus: "PAID" });
  // 書き込みの直前に、別の処理（Webhook の確定・占いの利用）が記録を変える
  const batchProto = Object.getPrototypeOf(db.batch()) as { commit: () => Promise<unknown> };
  const origCommit = batchProto.commit;
  let raced = false;
  // トランザクションの確定も内部でまとめての書き込みを使うので、権利のトランザクションが終わった後（注文を読んだ後）の最初の書き込みで変える
  let txDone = 0;
  batchProto.commit = async function (this: unknown) {
    if (!raced && txDone >= 2 && pendingTx === 0) {
      raced = true;
      await db.collection(C.checkouts).doc("exp_0").update({ status: "SUCCEEDED", providerPaymentId: "cs_test_race", updatedAt: new Date() });
    }
    return origCommit.call(this);
  };
  const txProto = Object.getPrototypeOf(db) as { runTransaction: (...a: unknown[]) => Promise<unknown> };
  const origTx = txProto.runTransaction;
  let txRaced = false;
  let pendingTx = 0;
  txProto.runTransaction = async function (this: unknown, ...a: unknown[]) {
    if (!txRaced) {
      txRaced = true;
      await db.collection(C.fortuneSessions).doc("s_race").update({ status: "USED" }); // 期限の直前に占いを使った
    }
    pendingTx++;
    try {
      return await origTx.apply(this, a);
    } finally {
      pendingTx--;
      txDone++;
    }
  };
  try {
    m = await runMaintenance();
  } finally {
    batchProto.commit = origCommit;
    txProto.runTransaction = origTx;
  }
  assert.ok(raced && txRaced, "競合を作れませんでした（検証の前提）");
  assert.deepEqual([await st("exp_0"), (await db.collection(C.checkouts).doc("exp_0").get()).get("providerPaymentId")], ["SUCCEEDED", "cs_test_race"], "決済済みになった注文を EXPIRED で上書きしました");
  assert.deepEqual([await st("exp_1"), await st("exp_2")], ["EXPIRED", "EXPIRED"], "競合していない注文が処理されていません");
  assert.equal((await db.collection(C.fortuneSessions).doc("s_race").get()).get("status"), "USED", "利用済みになった権利を EXPIRED で上書きしました");
  assert.equal((await db.collection(C.transactions).doc("tx_race").get()).get("fortuneStatus"), "PAID", "競合した権利の決済記録を変えました");
  assert.equal((await db.collection(C.fortuneSessions).doc("s_ok").get()).get("status"), "EXPIRED");
  assert.equal(m.conflictsSkipped, 2, JSON.stringify([m, (await db.collection(C.system).doc("maintenanceTasks").get()).get("lastTasks")]));
  const lt = (await db.collection(C.system).doc("maintenanceTasks").get()).get("lastTasks") as { task: string; conflicts: number }[];
  assert.deepEqual([lt.find((x) => x.task === "expireSessions")!.conflicts, lt.find((x) => x.task === "expireCheckouts")!.conflicts], [1, 1], "競合が想定の処理で数えられていません");
  step("競合の防止：読んだ後に決済済みになった注文・利用された権利は上書きせず（conflictsSkipped=2）、ほかの記録は今までどおり処理");

  // ---- 8. 中止の合図：中止の後は読み込み・書き込みを始めない ----
  await resetProject();
  await db.collection(C.fortuneResults).doc("r_old").set({ createdAt: new Date(t - 40 * DAY) });
  await db.collection(C.fortuneSessions).doc("s_paid").set({ status: "PAID", expiresAt: new Date(t - 60_000), transactionId: "tx_a" });
  const ac = new AbortController();
  ac.abort();
  m = await runMaintenance({}, Date.now, ac.signal);
  assert.equal(m.truncatedTasks, 8);
  assert.ok((await db.collection(C.fortuneResults).doc("r_old").get()).exists, "中止の後に削除しました");
  assert.equal((await db.collection(C.fortuneSessions).doc("s_paid").get()).get("status"), "PAID", "中止の後に更新しました");
  step("中止の合図の後は、読み込み・書き込みを始めない（すべての処理を打ち切りとして数える）");

  // ---- 9. 運営者への通知（Discord）：送信は模擬（discord.com への送信をこのプロセスの中で受け取る。外には送らない） ----
  await resetProject();
  const token = randomBytes(51).toString("base64url");
  process.env.OPS_ALERT_WEBHOOK_URL = `https://discord.com/api/webhooks/${"2".repeat(18)}/${token}`;
  const sent: string[] = [];
  let discordStatus = 204;
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const u = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (u.hostname === "discord.com" || u.hostname === "discordapp.com") {
      sent.push(String(init?.body ?? ""));
      return new Response(null, { status: discordStatus });
    }
    return realFetch(input, init);
  }) as typeof fetch;
  try {
    const notifyDoc = () => fsdb().collection(C.system).doc("alertNotification").get();
    // 1回目：異常が無く、正常の報告の履歴も無い → 週1回の正常の報告を送る（実行の回数は記録から数える）
    res = await call();
    assert.equal(res.status, 200);
    let rn = (await runDoc().get()).data()!;
    assert.equal(rn.lastNotification.status, "heartbeat", JSON.stringify(rn.lastNotification));
    assert.equal(sent.length, 1);
    const hb = JSON.parse(sent[0]) as { content: string };
    assert.match(hb.content, /^【正常】100円占い・決済の運用（ローカル） 週1回の定期報告/);
    assert.match(hb.content, /・直近7日の実行：1回（今回を含む。記録は .+ から）/);
    assert.match(hb.content, /・未確認：決済監視の異常 0件・決済要確認 0件/);
    assert.match(hb.content, /届かないことは自動では検知できません/);
    assert.ok((await notifyDoc()).get("lastHeartbeatAt"));
    assert.equal(((await runDoc().get()).get("recentStarts") as unknown[]).length, 1, "実行の履歴が記録されていません");
    // 2回目：異常が無く、正常の報告から7日未満 → 送らない
    res = await call();
    assert.equal(sent.length, 1);
    assert.equal((await runDoc().get()).get("lastNotification.status"), "nothing");
    assert.equal(((await runDoc().get()).get("recentStarts") as unknown[]).length, 2);

    // 新しい未確認の決済監視の異常：1回だけ送る（同じ未確認は次の回に送らない）
    const { recordPaymentAlert } = await import("@/lib/firestore/payment-alerts");
    await recordPaymentAlert({ kind: "stripe_paid_not_confirmed", objectType: "checkout", objectId: "co_notify_1", checkoutId: "co_notify_1", mode: "test" });
    res = await call();
    assert.equal(sent.length, 2);
    const msg = JSON.parse(sent[1]) as { content: string; allowed_mentions: unknown };
    assert.deepEqual(msg.allowed_mentions, { parse: [] });
    assert.match(msg.content, /^【要対応】100円占い・決済の運用（ローカル）/);
    assert.match(msg.content, /■ 新しい未確認の決済監視の異常：1件/);
    assert.match(msg.content, /Stripe では支払い済みなのに、アプリで決済が確定していない（テスト） ×1/);
    assert.ok(!sent[1].includes("co_notify_1"), "本文に注文の ID が入りました");
    for (const secret of [token, process.env.CRON_SECRET!, process.env.SESSION_SECRET!]) for (const b of sent) assert.ok(!b.includes(secret), "本文に秘密の値が入りました");
    rn = (await runDoc().get()).data()!;
    assert.deepEqual([rn.lastNotification.status, rn.lastNotification.newAlerts], ["sent", 1]);
    assert.ok(!JSON.stringify(rn).includes(token) && !JSON.stringify((await notifyDoc()).data()).includes(token), "送信先のトークンが記録されました");
    res = await call();
    assert.equal(sent.length, 2, "同じ未確認の異常をもう一度通知しました");
    assert.equal((await runDoc().get()).get("lastNotification.status"), "nothing");

    // 送信の失敗：通知済みにしない（次の回にもう一度送る）。定期処理の結果・応答は変わらない
    await recordPaymentAlert({ kind: "checkout_stuck_processing", objectType: "checkout", objectId: "co_notify_2", checkoutId: "co_notify_2", mode: "test" });
    discordStatus = 500;
    res = await call();
    assert.equal(res.status, 200);
    rn = (await runDoc().get()).data()!;
    assert.deepEqual([rn.lastNotification.status, rn.lastNotification.errorCode, rn.lastStatus], ["send_failed", "http_500", "completed"]);
    assert.equal((await notifyDoc()).get("lastStatus"), "send_failed");
    discordStatus = 204;
    res = await call();
    assert.match(JSON.parse(sent[sent.length - 1]).content, /確定待ちのまま一定時間を過ぎた注文がある（テスト） ×1/, "失敗した通知が次の回に送られません");
    assert.equal((await runDoc().get()).get("lastNotification.status"), "sent");

    // 送信先が正規の Discord ではない：送らない（定期処理は成功のまま）
    const before = sent.length;
    process.env.OPS_ALERT_WEBHOOK_URL = `https://evil.example/api/webhooks/${"2".repeat(18)}/${token}`;
    res = await call();
    assert.equal(res.status, 200);
    assert.equal(sent.length, before);
    assert.equal((await runDoc().get()).get("lastNotification.status"), "invalid_url");
  } finally {
    globalThis.fetch = realFetch;
    delete process.env.OPS_ALERT_WEBHOOK_URL;
  }
  step("運営者への通知：初回は週1回の正常の報告（実行の回数は記録から）、7日未満は送らない。異常を本文にまとめて送る（メンション無効・ID と秘密の値なし）。新しい未確認の異常は1回だけ。送信の失敗は次の回に送り直し、定期処理の結果は変えない。正規の Discord 以外には送らない");

  await resetProject();
  console.log("\nCRON PHASES E2E PASSED");
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("\nCRON PHASES E2E FAILED:", e);
    process.exit(1);
  });
