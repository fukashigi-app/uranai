import "server-only";
import { FieldPath, type DocumentData, type Query, type QueryDocumentSnapshot } from "firebase-admin/firestore";
import { C, fsdb, toDate } from "@/lib/firestore/admin";
import { acquireMonitorLock, markMonitorFinished, recordPaymentAlert, releaseMonitorLock, type MonitorSource } from "@/lib/firestore/payment-alerts";
import { countOpenPaymentReviews } from "@/lib/firestore/payment-reviews";
import { isStripeSessionId, retrieveStripeSession, stripeRuntime, type StripeRuntime } from "./stripe-checkout";
import { alertModeOf, hourBucket, MONITOR_LOCK_TTL_MS, MONITOR_LOOKBACK_DAYS, STUCK_PROCESSING_MINUTES, type AlertMode } from "./monitor-rules";

/**
 * 決済監視の点検（読み取り専用。決済の確定・返金・再決済などは一切しない）。運営画面の「今すぐ点検」・手動のスクリプトから実行する。
 *  1. 確定待ち（PROCESSING）のまま一定時間を過ぎた注文
 *  2. 上の注文のうち、Stripe では支払い済みなのにアプリで確定していないもの（Stripe API で Session を読むだけ）
 *     - Stripe との接続がない・モードの違う注文（テストの接続で本番の注文など）は照合せず「確認できなかった項目」にする
 *  3. 決済の記録・確定した注文があるのに、占い権利が無いもの（さかのぼる期間：MONITOR_LOOKBACK_DAYS 日）
 *  4. 確定済みの精算の金額と、取引に記録した支払った額の合計の食い違い
 * 見つかった異常は決済監視（paymentAlerts）に記録する（種類・対象ごとに1件）。点検の開始・終了・結果は system/paymentMonitor に残す。
 * 一部の確認に失敗・未実施なら結果は partial（「異常なし」とは表示しない）。すべて確認できなかったら failed。
 *
 * 負荷の上限（MONITOR_LIMITS）：Firestore はページに分けて読み、項目ごとの件数・Stripe の照合の件数・異常の書き込みの件数・
 * 実行時間に上限を設ける。上限で打ち切った項目は「確認できなかった項目」に入れる（打ち切った残りを異常なしと扱わない）。
 */

export type MonitorReport = {
  result: "ok" | "issues" | "partial" | "failed";
  found: number;
  unchecked: string[];
  checks: Record<string, number>;
  stripeMode: "test" | "live" | null;
  openReviews: number;
};

export const MONITOR_LIMITS = {
  /** Firestore の1回の読み込みの件数 */
  pageSize: 300,
  /** 確定待ち（PROCESSING）の注文 */
  processing: 500,
  /** Stripe の Session の照合（API の呼び出し） */
  stripeLookups: 50,
  /** 期間内の取引・注文 */
  transactions: 3000,
  checkouts: 3000,
  /** 確定済みの精算と、1つの精算の取引 */
  settlements: 300,
  txPerSettlement: 3000,
  /** 1回の点検で書き込む異常の件数 */
  alertWrites: 200,
  /** 実行時間 */
  deadlineMs: 45_000,
};
export type MonitorLimits = typeof MONITOR_LIMITS;

const modeOfCheckout = (d: DocumentData): AlertMode => (d.provider === "mock" ? "test" : alertModeOf(d.stripeLivemode));
const idOf = (v: unknown): string | null => (typeof v === "string" ? v : v && typeof v === "object" && typeof (v as { id?: unknown }).id === "string" ? (v as { id: string }).id : null);

class TimeUp extends Error {
  name = "TimeUp";
}

export type MonitorRun = { started: true; runId: string; report: MonitorReport } | { started: false; reason: "busy"; heldUntil: Date | null; source: string | null } | { started: false; reason: "lock_failed" };

/**
 * 点検を1回実行する（運営画面・手動のスクリプト・今後の Cron で共通）。
 * 同じ環境で同時に1つだけ（Firestore のトランザクションで取るロック。複数のサーバーのインスタンスでも有効）。
 *  - 実行中の点検があれば開始しない（busy）。ロックを取れない（Firestore の失敗）ときも開始しない（lock_failed）
 *  - ロックには有効期限（MONITOR_LOCK_TTL_MS）。途中で止まった点検のロックは期限が過ぎれば次の点検が取得できる
 *  - 結果の書き込み・ロックの解除は、自分の点検（runId）のときだけ（期限切れの後の古い点検は新しい点検を上書きしない）
 */
export async function runPaymentMonitor(opts: { rt?: StripeRuntime | null; now?: Date; limits?: Partial<MonitorLimits>; source?: MonitorSource } = {}): Promise<MonitorRun> {
  const now = opts.now ?? new Date();
  let lock: Awaited<ReturnType<typeof acquireMonitorLock>>;
  try {
    lock = await acquireMonitorLock({ now: new Date(), ttlMs: MONITOR_LOCK_TTL_MS, source: opts.source ?? "admin" });
  } catch (e) {
    console.error("[payment-monitor] lock failed", (e as Error)?.name);
    return { started: false, reason: "lock_failed" };
  }
  if (!lock.ok) return { started: false, reason: "busy", heldUntil: lock.heldUntil, source: lock.source };
  const runId = lock.runId;
  try {
    return { started: true, runId, report: await runChecks(runId, now, opts) };
  } finally {
    await releaseMonitorLock(runId).catch((e) => console.error("[payment-monitor] lock release failed", (e as Error)?.name)); // 外せなくても期限で外れる
  }
}

async function runChecks(runId: string, now: Date, opts: { rt?: StripeRuntime | null; limits?: Partial<MonitorLimits> }): Promise<MonitorReport> {
  const L: MonitorLimits = { ...MONITOR_LIMITS, ...opts.limits };
  // 時間の上限はロックの有効期限より短く（期限切れの後も点検が続いて、次の点検と重ならないように）
  L.deadlineMs = Math.min(L.deadlineMs, MONITOR_LOCK_TTL_MS - 60_000);
  const t0 = Date.now();
  const timeUp = () => Date.now() - t0 > L.deadlineMs;
  let rt: StripeRuntime | null;
  if (opts.rt !== undefined) rt = opts.rt;
  else {
    try {
      rt = stripeRuntime();
    } catch {
      rt = null;
    }
  }
  const unchecked: string[] = [];
  const checks: Record<string, number> = {};
  let found = 0;
  let written = 0;
  let alertsCapped = false;
  let completedSteps = 0;
  let erroredSteps = 0;
  let totalSteps = 0;
  const alert = async (a: Parameters<typeof recordPaymentAlert>[0]) => {
    found++;
    if (written >= L.alertWrites) {
      alertsCapped = true; // 件数は数えるが、記録はしない（「確認できなかった項目」に出す）
      return;
    }
    written++;
    if (!(await recordPaymentAlert(a, now))) unchecked.push("異常の記録に失敗");
  };
  /** 項目を実行する。失敗・時間切れ・上限での打ち切りは「確認できなかった項目」にする */
  const step = async (label: string, fn: () => Promise<boolean>) => {
    totalSteps++;
    if (timeUp()) {
      erroredSteps++;
      unchecked.push(`${label}（時間切れのため未実施）`);
      return;
    }
    try {
      const complete = await fn();
      if (complete) completedSteps++;
    } catch (e) {
      erroredSteps++;
      const timedOut = e instanceof TimeUp;
      unchecked.push(timedOut ? `${label}（時間切れのため途中まで）` : label);
      if (!timedOut) {
        console.error("[payment-monitor] check failed", { check: label, error: (e as Error)?.name });
        await recordPaymentAlert({ kind: "monitor_check_failed", objectType: "monitor", objectId: `${label}:${hourBucket(now)}`, mode: "unknown", errorName: (e as Error)?.name ?? null }, now);
      }
    }
  };
  /** ページに分けて読む（上限 max 件。上限を超えたら complete=false。時間切れは TimeUp） */
  async function readPaged(q: Query, orderField: string | FieldPath, max: number): Promise<{ docs: QueryDocumentSnapshot[]; complete: boolean }> {
    const docs: QueryDocumentSnapshot[] = [];
    let last: QueryDocumentSnapshot | undefined;
    for (;;) {
      if (timeUp()) throw new TimeUp();
      const want = Math.min(L.pageSize, max - docs.length + 1);
      let page = q.orderBy(orderField).limit(want);
      if (last) page = page.startAfter(last);
      const snap = await page.get();
      docs.push(...snap.docs);
      if (docs.length > max) return { docs: docs.slice(0, max), complete: false };
      if (snap.size < want) return { docs, complete: true };
      last = snap.docs[snap.docs.length - 1];
    }
  }
  const over = (label: string, max: number) => unchecked.push(`${label}（上限${max}件を超えたため一部のみ）`);

  const since = new Date(now.getTime() - MONITOR_LOOKBACK_DAYS * 86_400_000);
  const stuckBefore = new Date(now.getTime() - STUCK_PROCESSING_MINUTES * 60_000);

  // 1・2. 確定待ちのまま時間を過ぎた注文と、Stripe での支払いの状態（読むだけ）
  await step("確定待ちの注文", async () => {
    let complete = true;
    const { docs, complete: all } = await readPaged(fsdb().collection(C.checkouts).where("status", "==", "PROCESSING"), FieldPath.documentId(), L.processing);
    if (!all) {
      over("確定待ちの注文", L.processing);
      complete = false;
    }
    checks.processing = docs.length;
    const stuck = docs.filter((d) => {
      const started = toDate(d.get("processingStartedAt")) ?? toDate(d.get("updatedAt")) ?? toDate(d.get("createdAt"));
      return started !== null && started < stuckBefore;
    });
    checks.stuck = stuck.length;
    for (const d of stuck) {
      await alert({ kind: "checkout_stuck_processing", objectType: "checkout", objectId: d.id, checkoutId: d.id, storeId: String(d.get("storeId") ?? ""), mode: modeOfCheckout(d.data()) });
    }
    const stripeStuck = stuck.filter((d) => d.get("provider") === "stripe" && typeof d.get("providerPaymentId") === "string");
    if (!stripeStuck.length) return complete;
    if (!rt) {
      unchecked.push(`Stripe での支払いの照合（接続なし・${stripeStuck.length}件）`);
      return false;
    }
    let otherMode = 0;
    let compared = 0;
    let failed = 0;
    let skipped = 0;
    for (const d of stripeStuck) {
      const sessionId = String(d.get("providerPaymentId"));
      if (!isStripeSessionId(sessionId, rt.mode) || (typeof d.get("stripeLivemode") === "boolean" && d.get("stripeLivemode") !== (rt.mode === "live"))) {
        otherMode++;
        continue;
      }
      if (compared + failed >= L.stripeLookups || timeUp()) {
        skipped++;
        continue;
      }
      let s: Awaited<ReturnType<typeof retrieveStripeSession>>;
      try {
        s = await retrieveStripeSession(sessionId, rt); // 読むだけ（確定・返金・再決済はしない）
      } catch (e) {
        failed++;
        console.error("[payment-monitor] stripe read failed", { error: (e as Error)?.name });
        continue;
      }
      compared++;
      if (s.livemode !== (rt.mode === "live")) {
        otherMode++;
        continue;
      }
      if (s.payment_status !== "paid") continue;
      const pi = idOf(s.payment_intent);
      const txExists = pi ? (await fsdb().collection(C.transactions).doc(`stripe_${pi}`).get()).exists : false;
      if (!txExists) await alert({ kind: "stripe_paid_not_confirmed", objectType: "checkout", objectId: d.id, checkoutId: d.id, storeId: String(d.get("storeId") ?? ""), mode: alertModeOf(s.livemode) });
    }
    checks.stripeCompared = compared;
    if (otherMode) unchecked.push(`モードの違う注文（${rt.mode === "live" ? "本番" : "テスト"}の接続では照合しない・${otherMode}件）`);
    if (failed) unchecked.push(`Stripe での支払いの照合に失敗（${failed}件）`);
    if (skipped) unchecked.push(`Stripe での支払いの照合（上限${L.stripeLookups}件・時間を超えたため未照合 ${skipped}件）`);
    return complete && !otherMode && !failed && !skipped;
  });

  // 3. 決済の記録・確定した注文があるのに、占い権利が無い
  await step("占い権利の付与", async () => {
    let complete = true;
    const t = await readPaged(fsdb().collection(C.transactions).where("createdAt", ">=", since), "createdAt", L.transactions);
    if (!t.complete) {
      over("占い権利の付与（取引）", L.transactions);
      complete = false;
    }
    const txs = t.docs.filter((d) => ["stripe", "mock"].includes(String(d.get("paymentProvider"))));
    checks.recentTransactions = txs.length;
    for (let i = 0; i < txs.length; i += L.pageSize) {
      if (timeUp()) throw new TimeUp();
      const part = txs.slice(i, i + L.pageSize);
      const sessions = await fsdb().getAll(...part.map((x) => fsdb().collection(C.fortuneSessions).doc(x.id)));
      for (let j = 0; j < part.length; j++) {
        if (sessions[j].exists) continue;
        const x = part[j];
        await alert({ kind: "paid_without_entitlement", objectType: "transaction", objectId: x.id, transactionId: x.id, checkoutId: String(x.get("checkoutId") ?? ""), storeId: String(x.get("storeId") ?? ""), mode: x.get("paymentProvider") === "mock" ? "test" : alertModeOf(x.get("livemode")) });
      }
    }
    const c = await readPaged(fsdb().collection(C.checkouts).where("updatedAt", ">=", since), "updatedAt", L.checkouts);
    if (!c.complete) {
      over("占い権利の付与（注文）", L.checkouts);
      complete = false;
    }
    const done = c.docs.filter((d) => d.get("status") === "SUCCEEDED" && d.get("provider") === "stripe");
    checks.recentSucceededCheckouts = done.length;
    for (let i = 0; i < done.length; i += L.pageSize) {
      if (timeUp()) throw new TimeUp();
      const part = done.slice(i, i + L.pageSize);
      const keys = part.map((d) => (typeof d.get("providerPaymentKey") === "string" ? String(d.get("providerPaymentKey")) : ""));
      const refs = keys.filter(Boolean).map((k) => fsdb().collection(C.transactions).doc(k));
      const got = refs.length ? await fsdb().getAll(...refs) : [];
      const exists = new Set(got.filter((g) => g.exists).map((g) => g.id));
      for (let j = 0; j < part.length; j++) {
        if (keys[j] && exists.has(keys[j])) continue;
        const d = part[j];
        await alert({ kind: "paid_without_entitlement", objectType: "checkout", objectId: d.id, checkoutId: d.id, storeId: String(d.get("storeId") ?? ""), mode: modeOfCheckout(d.data()) });
      }
    }
    return complete;
  });

  // 4. 確定済みの精算の金額の食い違い（新しい仕組みで確定した精算だけ。以前の精算は決済要確認で扱う）
  await step("確定済みの精算", async () => {
    let complete = true;
    const s = await readPaged(fsdb().collection(C.settlements).where("lockedAt", ">=", new Date(now.getTime() - 120 * 86_400_000)), "lockedAt", L.settlements);
    if (!s.complete) {
      over("確定済みの精算", L.settlements);
      complete = false;
    }
    const locked = s.docs.filter((d) => d.get("status") === "PROCESSING" || d.get("status") === "PAID");
    checks.lockedSettlements = locked.length;
    let tooBig = 0;
    for (const st of locked) {
      if (timeUp()) throw new TimeUp();
      const txs = await fsdb().collection(C.transactions).where("settlementId", "==", st.id).limit(L.txPerSettlement + 1).get();
      if (txs.size > L.txPerSettlement) {
        tooBig++;
        continue; // 一部の取引だけで合計を比べない（誤った食い違い・誤った「一致」を出さない）
      }
      const sum = txs.docs.reduce((a, t) => a + Number(t.get("settledShare") ?? 0), 0);
      if (sum !== Number(st.get("storeShare") ?? 0)) {
        await alert({ kind: "settlement_inconsistent", objectType: "settlement", objectId: st.id, settlementId: st.id, storeId: String(st.get("storeId") ?? ""), mode: "live", amount: sum - Number(st.get("storeShare") ?? 0) });
      }
    }
    if (tooBig) unchecked.push(`確定済みの精算（取引が上限${L.txPerSettlement}件を超えた精算 ${tooBig}件は未確認）`);
    return complete && !tooBig;
  });

  let openReviews = 0;
  await step("決済要確認の件数", async () => {
    openReviews = await countOpenPaymentReviews();
    return true;
  });

  if (alertsCapped) unchecked.push(`異常の記録（上限${L.alertWrites}件を超えた分は記録していません）`);
  // すべての項目が失敗・時間切れ → failed／一部でも確認できなかった → partial／すべて確認して異常あり → issues
  const result: MonitorReport["result"] = erroredSteps === totalSteps ? "failed" : unchecked.length || completedSteps < totalSteps ? "partial" : found ? "issues" : "ok";
  if (result !== "ok" && result !== "issues" && !unchecked.length) unchecked.push("確認できなかった項目あり");
  const uncheckedList = [...new Set(unchecked)];
  try {
    if (!(await markMonitorFinished({ runId, now: new Date(), result, unchecked: uncheckedList, found, stripeMode: rt?.mode ?? null, checks }))) console.error("[payment-monitor] newer run exists; result not written");
  } catch (e) {
    console.error("[payment-monitor] status write failed", (e as Error)?.name);
  }
  return { result, found, unchecked: uncheckedList, checks, stripeMode: rt?.mode ?? null, openReviews };
}
