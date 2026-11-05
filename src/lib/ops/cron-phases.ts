/**
 * 定期処理（/api/cron/maintenance）を「段階」に分けて順に実行する仕組み（Firestore・Stripe に依存しない純粋な処理）。
 *
 *  - 段階ごとに例外を取り込み、成功・失敗・時間切れ・スキップと実行時間を記録する（1つが失敗しても次の段階を実行する）
 *  - 段階ごとに「開始してよい時刻」（定期処理の開始からの時間）と「待つ上限」を持つ。
 *    前の段階が長引いても、後ろの段階の時間を使い切らないよう、締め切りを過ぎた段階は始めない（skipped: deadline）
 *  - 全体の締め切り（hardDeadlineMs）を過ぎたら、新しい段階を始めずに安全に終了する。関数の実行時間の上限（maxDuration）より前に
 *    応答・記録・ロックの解除ができるように、余裕を持たせた値を渡す
 *  - 待つ上限を過ぎた段階には中止の合図（AbortSignal）を送り、止まるのを短い時間（ABORT_GRACE_MS）だけ待つ。
 *    結果は必ず timed_out（中止が終わっても正常終了とは記録しない）。止まったかは abortSettled に残す。
 *    止まらなかった段階があれば、処理が裏で続いている可能性があるので、呼び出し側はロックを外さず期限で外れるのを待つ
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
  /** 時間切れの段階だけ：中止の合図の後、処理が止まったか（true＝止まった・false＝待つのをやめた時点で続いていた） */
  abortSettled: boolean | null;
};

export type CronPhase = {
  name: string;
  /** 定期処理の開始からこの時間を過ぎていたら、この段階を始めない */
  startNotAfterMs: number;
  /** この段階を待つ上限（全体の締め切りまでの残りの方が短ければ、そちらを使う） */
  maxMs: number;
  /** signal … 時間切れのときに中止の合図が送られる。処理はページ・1件ごとに確かめ、中止の後は新しい処理を始めない */
  run: (signal: AbortSignal) => Promise<void>;
};

/** 中止の合図を送った後、段階が止まるのを待つ上限（全体の締め切りまでの残りの方が短ければ、そちらを使う） */
export const ABORT_GRACE_MS = 10 * 1000;

export type CronRunOutcome = {
  phases: CronPhaseRecord[];
  /** 待つ上限を過ぎた段階があった */
  timedOut: boolean;
  /** 中止の合図の後も止まらなかった段階があった（処理が裏で続いている可能性がある。ロックを外さない） */
  unsettled: boolean;
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

export async function runCronPhases(
  phases: readonly CronPhase[],
  opts: {
    /** 定期処理の開始時刻（clock と同じ基準のミリ秒） */
    startedAt: number;
    /** 定期処理の開始からこの時間を過ぎたら、新しい段階を始めない */
    hardDeadlineMs: number;
    clock?: () => number;
    /** 中止の後に止まるのを待つ上限（自動テスト用。既定は ABORT_GRACE_MS） */
    abortGraceMs?: number;
    /** 定期処理のロックをまだ持っているか（確かめられないときは false を返すこと＝始めない） */
    stillOwner?: () => Promise<boolean>;
    errorCodeOf: (e: unknown) => string;
  },
): Promise<CronRunOutcome> {
  const clock = opts.clock ?? Date.now;
  const records: CronPhaseRecord[] = [];
  let timedOut = false;
  let unsettled = false;
  let lockLost = false;
  const skip = (name: string, reason: CronPhaseSkipReason) => records.push({ name, status: "skipped", reason, errorCode: null, startedAtMs: null, durationMs: 0, abortSettled: null });

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
    const controller = new AbortController();
    let settled = false;
    const work = Promise.resolve()
      .then(() => phase.run(controller.signal))
      .finally(() => void (settled = true));
    work.catch(() => undefined); // 待つのをやめた後の失敗を、未処理の例外にしない
    const base = { name: phase.name, reason: null, startedAtMs: t0 - opts.startedAt };
    const r = await waitFor(work, limitMs);
    if (r.kind === "ok") records.push({ ...base, status: "ok", errorCode: null, durationMs: clock() - t0, abortSettled: null });
    else if (r.kind === "error") records.push({ ...base, status: "failed", errorCode: opts.errorCodeOf(r.error), durationMs: clock() - t0, abortSettled: null });
    else {
      // 時間切れ：中止の合図を送り、止まるのを少しだけ待つ（全体の締め切りは超えない）。止まっても timed_out のまま
      timedOut = true;
      controller.abort();
      const graceMs = Math.max(0, Math.min(opts.abortGraceMs ?? ABORT_GRACE_MS, opts.hardDeadlineMs - (clock() - opts.startedAt)));
      if (!settled) await waitFor(work, graceMs);
      if (!settled) unsettled = true;
      records.push({ ...base, status: "timed_out", errorCode: "PhaseTimeout", durationMs: clock() - t0, abortSettled: settled });
    }
  }
  return { phases: records, timedOut, unsettled, lockLost, elapsedMs: clock() - opts.startedAt };
}

/** work を最大 ms だけ待つ（待つのをやめても work は止めない） */
async function waitFor(work: Promise<void>, ms: number): Promise<{ kind: "ok" } | { kind: "error"; error: unknown } | { kind: "timeout" }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work.then(
        () => ({ kind: "ok" as const }),
        (error: unknown) => ({ kind: "error" as const, error }),
      ),
      new Promise<{ kind: "timeout" }>((ok) => {
        timer = setTimeout(() => ok({ kind: "timeout" }), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
