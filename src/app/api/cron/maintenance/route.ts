import { NextResponse } from "next/server";
import { env } from "@/lib/env";
import { safeEqual } from "@/lib/security/crypto";
import { runMaintenance } from "@/lib/services/maintenance";
import { errorCodeOf, recordMaintenanceRun } from "@/lib/services/maintenance-status";
import { runCronWebhookRecovery } from "@/lib/payments/webhook-recovery";
import { runCronRecheckRecovery } from "@/lib/payments/recheck-recovery";

/** 決済記録の再確認の自動の回収は、定期処理の開始からこの時間を過ぎたら新しい回収を始めない（maxDuration 300秒の中で、ほかの処理を待たせない） */
const RECHECK_RECOVERY_NOT_AFTER_MS = 180 * 1000;

/**
 * 関数の実行時間の上限（秒）。Hobby プラン・Fluid Compute 有効の上限の300秒（Webhook と同じ。docs/preview-verification.md §11）。
 * Webhook の通知の自動の復旧は、開始から60秒を過ぎたら新しい通知を始めない（始めた通知は Webhook と同じく最後まで処理する）
 */
export const maxDuration = 300;

/**
 * Vercel Cron 等から `Authorization: Bearer <CRON_SECRET>` で呼び出す。
 * CRON_SECRET が未設定なら常に 401（認証を弱めない）。未設定は /api/health と運営ダッシュボードで検知する。
 * 実行結果（成功/失敗・最終実行時刻・処理件数）は記録とログに残す。秘密鍵やリクエストヘッダーの値は出さない。
 * メンテナンスの後に、Stripe の Webhook の通知の自動の復旧（webhook-recovery.ts）を実行する（メンテナンスの成否に関係なく。
 * 復旧の結果は system/webhookRecovery とログに残し、応答の状態コードはメンテナンスの結果で決める）。
 * 最後に、決済記録の作成の後の再確認が終わっていない決済記録（recheckState=PENDING）の自動の回収を実行する
 * （recheck-recovery.ts。結果は system/recheckRecovery とログ。失敗してもメンテナンスの結果を変えない）。
 */
export async function GET(req: Request) {
  const secret = env().CRON_SECRET;
  const auth = req.headers.get("authorization") ?? "";
  if (!secret || !safeEqual(auth, `Bearer ${secret}`)) {
    console.warn(`[cron] maintenance unauthorized (${secret ? "token mismatch" : "CRON_SECRET not configured"})`);
    return new NextResponse("unauthorized", { status: 401 });
  }
  const startedAt = new Date();
  try {
    const result = await runMaintenance();
    await recordMaintenanceRun({ ok: true, result }, startedAt);
    console.log("[cron] maintenance ok", { ...result, ms: Date.now() - startedAt.getTime() });
    const webhookRecovery = await recoverWebhooks();
    const recheckRecovery = await recoverRechecks(startedAt);
    return NextResponse.json({ ...result, webhookRecovery, recheckRecovery });
  } catch (e) {
    const errorCode = errorCodeOf(e);
    await recordMaintenanceRun({ ok: false, errorCode }, startedAt);
    // ログには原因の確認に必要な先頭1行だけ（記録には識別子だけを保存）
    console.error("[cron] maintenance failed", { errorCode, message: String((e as Error)?.message ?? "").split("\n")[0].slice(0, 200), ms: Date.now() - startedAt.getTime() });
    await recoverWebhooks();
    await recoverRechecks(startedAt);
    return NextResponse.json({ ok: false, error: "maintenance_failed" }, { status: 500 });
  }
}

/** Webhook の通知の自動の復旧（失敗してもメンテナンスの結果を変えない。結果はログと記録に残す） */
async function recoverWebhooks() {
  try {
    const r = await runCronWebhookRecovery();
    console.log("[cron] webhook recovery", r);
    return r;
  } catch (e) {
    console.error("[cron] webhook recovery failed", { errorCode: errorCodeOf(e) });
    return { status: "failed" as const };
  }
}

/** 決済記録の再確認の自動の回収（失敗してもメンテナンスの結果を変えない。結果はログと記録に残す） */
async function recoverRechecks(cronStartedAt: Date) {
  try {
    const r = await runCronRecheckRecovery(new Date(cronStartedAt.getTime() + RECHECK_RECOVERY_NOT_AFTER_MS));
    console.log("[cron] recheck recovery", r);
    return r;
  } catch (e) {
    console.error("[cron] recheck recovery failed", { errorCode: errorCodeOf(e) });
    return { status: "failed" as const };
  }
}
