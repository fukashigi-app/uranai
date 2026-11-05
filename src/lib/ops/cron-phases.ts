/**
 * 定期処理（/api/cron/maintenance）を「段階」に分けて順に実行する仕組み（Firestore・Stripe に依存しない純粋な処理）。
 *
 *  - 段階ごとに例外を取り込み、成功・失敗・時間切れ・スキップと実行時間を記録する（1つが失敗しても次の段階を実行する）
 *  - 段階ごとに「開始してよい時刻」（定期処理の開始からの時間）と「待つ上限」を持つ。
 *    前の段階が長引いても、後ろの段階の時間を使い切らないよう、締め切りを過ぎた段階は始めない（skipped: deadline）
 *  - 全体の締め切り（hardDeadlineMs）を過ぎたら、新しい段階を始めずに安全に終了する。関数の実行時間の上限（maxDuration）より前に
 *    応答・記録・ロックの解除ができるように、余裕を持たせた値を渡す
 *  - 待つ上限を過ぎた段階は timed_out（処理は裏で続く可能性があるので、呼び出し側はロックを外さず期限で外れるのを待つ）
 *  - 段階を始める前に、定期処理のロックをまだ持っているかを確かめる（stillOwner）。持っていなければ残りを始めない（skipped: lock_lost）
 * 段階の処理そのもの（メンテナンス・Webhook の復旧・再確認）の中身は変えない。秘密情報・エラーの文面は記録しない（エラーの識別子だけ）。
 */

export type CronPhaseStatus = "ok" | "failed" | "timed_out" | "skipped";
export type CronPhaseSkipReason = "deadline" | "lock_lost";

export type CronPhaseRecord = {
  name: string;
  status: CronPhaseStatus;
  reason: CronPhaseSkipReason | null;
  /** 失敗の識別子（Error.name・Firestore のコードなど。エラーの文面は含めない） */
  errorCode: string | null;
  /** 定期処理の開始から、この段階を始めるまでの時間（スキップは null） */
  startedAtMs: number | null;
  durationMs: number;
};

export type CronPhase = {
  name: string;
  /** 定期処理の開始からこの時間を過ぎていたら、この段階を始めない */
  startNotAfterMs: number;
  /** この段階を待つ上限（全体の締め切りまでの残りの方が短ければ、そちらを使う） */
  maxMs: number;
  run: () => Promise<void>;
};

export type CronRunOutcome = {
  phases: CronPhaseRecord[];
  /** 待つ上限を過ぎた段階があった（処理が裏で続いている可能性がある） */
  timedOut: boolean;
  /** ロックを失ったため、残りの段階を始めなかった */
  lockLost: boolean;
  elapsedMs: number;
};

export type CronRunStatus = "completed" | "partial" | "timed_out" | "lock_lost";

/** 実行全体の結果：すべて成功 completed、時間切れ timed_out、ロックを失った lock_lost、それ以外（失敗・スキップあり）partial */
export function cronRunStatusOf(o: Pick<CronRunOutcome, "phases" | "timedOut" | "lockLost">): CronRunStatus {
  if (o.lockLost) return "lock_lost";
  if (o.timedOut) return "timed_out";
  return o.phases.every((p) => p.status === "ok") ? "completed" : "partial";
}

class PhaseTimeout extends Error {
  name = "PhaseTimeout";
}

export async function runCronPhases(
  phases: readonly CronPhase[],
  opts: {
    /** 定期処理の開始時刻（clock と同じ基準のミリ秒） */
    startedAt: number;
    /** 定期処理の開始からこの時間を過ぎたら、新しい段階を始めない */
    hardDeadlineMs: number;
    clock?: () => number;
    /** 定期処理のロックをまだ持っているか（確かめられないときは false を返すこと＝始めない） */
    stillOwner?: () => Promise<boolean>;
    errorCodeOf: (e: unknown) => string;
  },
): Promise<CronRunOutcome> {
  const clock = opts.clock ?? Date.now;
  const records: CronPhaseRecord[] = [];
  let timedOut = false;
  let lockLost = false;
  const skip = (name: string, reason: CronPhaseSkipReason) => records.push({ name, status: "skipped", reason, errorCode: null, startedAtMs: null, durationMs: 0 });

  for (const phase of phases) {
    if (lockLost) {
      skip(phase.name, "lock_lost");
      continue;
    }
    const elapsed = clock() - opts.startedAt;
    if (elapsed > phase.startNotAfterMs || elapsed >= opts.hardDeadlineMs) {
      skip(phase.name, "deadline");
      continue;
    }
    if (opts.stillOwner) {
      let owner = false;
      try {
        owner = await opts.stillOwner();
      } catch {
        owner = false; // 確かめられない：同時に別の定期処理が動いている可能性を否定できないので始めない
      }
      if (!owner) {
        lockLost = true;
        skip(phase.name, "lock_lost");
        continue;
      }
    }
    const t0 = clock();
    const limitMs = Math.max(0, Math.min(phase.maxMs, opts.hardDeadlineMs - (t0 - opts.startedAt)));
    let timer: ReturnType<typeof setTimeout> | undefined;
    const work = Promise.resolve().then(phase.run);
    work.catch(() => undefined); // 待つのをやめた後の失敗を、未処理の例外にしない
    try {
      await Promise.race([
        work,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new PhaseTimeout()), limitMs);
        }),
      ]);
      records.push({ name: phase.name, status: "ok", reason: null, errorCode: null, startedAtMs: t0 - opts.startedAt, durationMs: clock() - t0 });
    } catch (e) {
      if (e instanceof PhaseTimeout) {
        timedOut = true;
        records.push({ name: phase.name, status: "timed_out", reason: null, errorCode: "PhaseTimeout", startedAtMs: t0 - opts.startedAt, durationMs: clock() - t0 });
      } else {
        records.push({ name: phase.name, status: "failed", reason: null, errorCode: opts.errorCodeOf(e), startedAtMs: t0 - opts.startedAt, durationMs: clock() - t0 });
      }
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  return { phases: records, timedOut, lockLost, elapsedMs: clock() - opts.startedAt };
}
