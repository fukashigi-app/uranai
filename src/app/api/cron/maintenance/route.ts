import { NextResponse } from "next/server";
import { env } from "@/lib/env";
import { safeEqual } from "@/lib/security/crypto";
import { runMaintenance } from "@/lib/services/maintenance";
import { errorCodeOf, recordMaintenanceRun } from "@/lib/services/maintenance-status";

/**
 * Vercel Cron 等から `Authorization: Bearer <CRON_SECRET>` で呼び出す。
 * CRON_SECRET が未設定なら常に 401（認証を弱めない）。未設定は /api/health と運営ダッシュボードで検知する。
 * 実行結果（成功/失敗・最終実行時刻・処理件数）は記録とログに残す。秘密鍵やリクエストヘッダーの値は出さない。
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
    return NextResponse.json(result);
  } catch (e) {
    const errorCode = errorCodeOf(e);
    await recordMaintenanceRun({ ok: false, errorCode }, startedAt);
    // ログには原因の確認に必要な先頭1行だけ（記録には識別子だけを保存）
    console.error("[cron] maintenance failed", { errorCode, message: String((e as Error)?.message ?? "").split("\n")[0].slice(0, 200), ms: Date.now() - startedAt.getTime() });
    return NextResponse.json({ ok: false, error: "maintenance_failed" }, { status: 500 });
  }
}
