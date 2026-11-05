import "server-only";
import { randomUUID } from "node:crypto";
import { FieldValue } from "firebase-admin/firestore";
import { C, fsdb, toDate } from "./admin";
import type { CronPhaseRecord, CronRunStatus } from "@/lib/ops/cron-phases";

/**
 * 定期処理（/api/cron/maintenance）全体の排他制御と、段階ごとの実行の記録（Firestore 版）。
 *  system/cronLock … 実行中の定期処理（所有者の ID・取得の時刻・有効期限）。トランザクションで取得する
 *                     （複数のサーバーのインスタンス・Vercel の重複した呼び出しでも、同時に動くのは1つだけ）
 *  system/cronRun  … 最後に開始・終了した定期処理（所有者の ID・状態・段階ごとの結果・実行時間）
 *
 * 有効期限は関数の実行時間の上限（300秒）より長い。強制終了されたロックは期限が過ぎれば次の定期処理が取得できる。
 * 解除・終了の記録は、自分（所有者の ID が一致）のときだけ（期限切れの後に別の定期処理が取得したロック・記録は上書きしない）。
 * 保存するのは ID・時刻・状態・件数・エラーの識別子だけ（秘密情報・個人情報・エラーの文面は保存しない）。
 */

/** ロックの有効期限（maxDuration の300秒＋余裕。これより前に、同じ定期処理が強制終了されている） */
export const CRON_LOCK_TTL_MS = 330 * 1000;

const lockRef = () => fsdb().collection(C.system).doc("cronLock");
const runRef = () => fsdb().collection(C.system).doc("cronRun");

export type CronLockResult = { ok: true; ownerId: string; tookOverExpired: boolean } | { ok: false; heldUntil: Date | null };

/** Firestore のトランザクションの競合（ABORTED）か */
const isContention = (e: unknown) => {
  const code = (e as { code?: unknown })?.code;
  return code === 10 || code === "aborted" || code === "ABORTED";
};

/** 競合したときに取得をやり直す回数と、間の待ち時間（ミリ秒の範囲。短く、ばらつかせる） */
const CONTENTION_ATTEMPTS = 6;
const CONTENTION_WAIT_MS: [number, number] = [50, 200];

/**
 * 取得：ロックが無い・期限切れのときだけ。Firestore の失敗は例外（呼び出し側で定期処理を始めない）。
 * トランザクションは SDK のやり直しを使わず（maxAttempts: 1）、競合したら短い間隔で数回だけ取り直す。
 *  - SDK の既定のやり直しは数秒待つため、その間に先の定期処理が終わると、重複した呼び出しがもう一度実行してしまう
 *  - 1回だけで諦めると、同時の呼び出しがすべて競合して、どれも実行しないことがある
 * 取り直しても競合が続くときは「実行中」として扱う（別の定期処理がロックを取得しようとしている）
 */
export async function acquireCronLock(now: Date, ttlMs: number = CRON_LOCK_TTL_MS, ownerId: string = randomUUID()): Promise<CronLockResult> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await acquireOnce(now, ttlMs, ownerId);
    } catch (e) {
      if (!isContention(e)) throw e;
      if (attempt >= CONTENTION_ATTEMPTS) return { ok: false, heldUntil: null };
      const [lo, hi] = CONTENTION_WAIT_MS;
      await new Promise((ok) => setTimeout(ok, lo + Math.floor(Math.random() * (hi - lo))));
    }
  }
}

function acquireOnce(now: Date, ttlMs: number, ownerId: string): Promise<CronLockResult> {
  return fsdb().runTransaction(async (tx) => {
    const cur = await tx.get(lockRef());
    const until = cur.exists ? toDate(cur.get("expiresAt")) : null;
    if (cur.exists && until && until > now) return { ok: false as const, heldUntil: until };
    tx.set(lockRef(), { ownerId, acquiredAt: now, expiresAt: new Date(now.getTime() + ttlMs) });
    // 開始の記録：強制終了されても「running のまま・終了の時刻なし」で残り、止まったことが分かる
    tx.set(runRef(), { currentRunId: ownerId, lastStartedAt: now, currentStatus: "running", updatedAt: FieldValue.serverTimestamp() }, { merge: true });
    return { ok: true as const, ownerId, tookOverExpired: cur.exists };
  }, { maxAttempts: 1 });
}

/** まだ自分のロックか（所有者の ID が一致し、期限内） */
export async function isCronLockOwner(ownerId: string, now: Date = new Date()): Promise<boolean> {
  const cur = await lockRef().get();
  const until = cur.exists ? toDate(cur.get("expiresAt")) : null;
  return cur.exists && cur.get("ownerId") === ownerId && !!until && until > now;
}

/** 解除：自分のロックだけ（別の定期処理が取得したロックは外さない） */
export async function releaseCronLock(ownerId: string): Promise<boolean> {
  return fsdb().runTransaction(async (tx) => {
    const cur = await tx.get(lockRef());
    if (!cur.exists || cur.get("ownerId") !== ownerId) return false;
    tx.delete(lockRef());
    return true;
  });
}

/**
 * 決済監視の段階の要約（件数・状態・時刻だけ。決済の ID・店舗・個人情報・確認できなかった項目の文面は含めない）。
 * status … ok・issues・partial（点検の結果）／failed（点検の失敗）／busy（別の点検が実行中）／lock_failed（点検のロックを取れない）／
 *          skipped_time（時間不足で始めなかった）／skipped_lock_lost（定期処理のロックを失った）／timed_out（待つ上限を過ぎた）／unsupported
 */
export type CronPaymentMonitorSummary = {
  status: string;
  found: number | null;
  uncheckedCount: number | null;
  openReviews: number | null;
  stripeMode: "test" | "live" | null;
  finishedAt: Date | null;
};

export type CronRunRecord = { status: CronRunStatus; startedAt: Date; finishedAt: Date; phases: CronPhaseRecord[]; paymentMonitor?: CronPaymentMonitorSummary };

/** 終了の記録：最後に開始したのが自分のときだけ（古い定期処理が新しい記録を上書きしない） */
export async function recordCronRun(ownerId: string, r: CronRunRecord): Promise<boolean> {
  return fsdb().runTransaction(async (tx) => {
    const cur = await tx.get(runRef());
    if (cur.exists && cur.get("currentRunId") !== ownerId) return false;
    tx.set(
      runRef(),
      {
        currentRunId: ownerId,
        currentStatus: "finished",
        lastRunId: ownerId,
        lastStartedAt: r.startedAt,
        lastFinishedAt: r.finishedAt,
        lastDurationMs: r.finishedAt.getTime() - r.startedAt.getTime(),
        lastStatus: r.status,
        lastPhases: r.phases.map((p) => ({ ...p, errorCode: p.errorCode ? p.errorCode.slice(0, 80) : null })),
        ...(r.paymentMonitor ? { lastPaymentMonitor: { ...r.paymentMonitor, status: r.paymentMonitor.status.slice(0, 40) } } : {}),
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );
    return true;
  });
}
