import "server-only";
import { cache } from "react";
import { isSessionSecretStrong, serviceStopReason } from "@/lib/env";
import { hasDatabase } from "@/lib/data-provider";
import type { SessionUser } from "@/lib/auth/session";

/**
 * ===== 開発モード（SITE_STATUS=development）=====
 *
 * - 一般の方には「ただいま準備中です」を表示し、決済の API は誰に対しても受け付けない（lib/env.ts の serviceStopReason）
 * - 無料の占いを使えるのは、運営アカウント（OPERATOR）でログイン中の人だけ。テスト店舗（/s/test）だけで使える
 * - 判定は毎回のリクエストでサーバー側で行う（画面側の表示や Cookie だけでは使えない）
 * - 危険な設定（本番の ENABLE_TEST_PAYMENT=true・PAYMENT_PROVIDER=mock、開発モードでの本番用決済キー）があれば、
 *   運営アカウントでも使えない（serviceStopReason が dangerous_config を優先して返す）
 * - SESSION_SECRET が安全な値でなければ使えない（Cookie の署名に使うため）
 * - 決済・売上のデータ（checkouts / transactions / fortuneSessions / fortuneResults）には一切書き込まない。
 *   利用は testFortuneLogs に mode: "development" を付けて記録するだけ
 */
export type DevModeDenyReason = "not_development" | "weak_secret" | "no_database" | "not_logged_in" | "not_operator" | "unavailable";
export type DevModeAccess = { ok: true; user: SessionUser; sessionHash: string } | { ok: false; reason: DevModeDenyReason };

/** 開発モードの無料占いを使えるか（同じリクエストの中では1回だけ判定する） */
export const devModeAccess = cache(async (): Promise<DevModeAccess> => {
  if (serviceStopReason() !== "development") return { ok: false, reason: "not_development" };
  if (!isSessionSecretStrong()) return { ok: false, reason: "weak_secret" };
  if (!hasDatabase()) return { ok: false, reason: "no_database" };
  try {
    // auth/session は next/navigation に依存するため、使うときだけ読み込む（スクリプトから test-store を読み込めるように）
    const { currentSessionHash, getSessionUser } = await import("@/lib/auth/session");
    const sessionHash = await currentSessionHash();
    if (!sessionHash) return { ok: false, reason: "not_logged_in" };
    const user = await getSessionUser();
    if (!user) return { ok: false, reason: "not_logged_in" };
    if (user.role !== "OPERATOR") return { ok: false, reason: "not_operator" };
    return { ok: true, user, sessionHash };
  } catch (e) {
    // ログイン状態を確認できないときは使わせない（安全側）
    console.error("[dev-mode] session check failed", (e as Error).name);
    return { ok: false, reason: "unavailable" };
  }
});
