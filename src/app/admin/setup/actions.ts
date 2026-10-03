"use server";

import { headers } from "next/headers";
import { hasDatabase } from "@/lib/data-provider";
import { parseSetupInput } from "@/lib/auth/setup-input";
import { rateLimit } from "@/lib/security/rate-limit";
import { clientKey } from "@/lib/security/request";
import { checkSetupToken, createInitialOperator, DuplicateEmailError, isInitialSetupDone } from "@/lib/services/setup";

export type SetupState = { status: "created" | "done" | "error"; message?: string; errors?: Record<string, string> } | null;

const GENERIC_ERROR = "作成できませんでした。時間をおいて再度お試しください。";

/**
 * 最初の運営アカウントを作成（運営アカウントが1件も無いときだけ）。
 * 連打・総当たり対策: IP単位で15分5回、全体で1時間20回まで。
 * エラー内容（DB接続情報・秘密鍵など）は画面に出さず、サーバーログにだけ種類を残す。
 */
export async function setupAdminAction(_prev: SetupState, fd: FormData): Promise<SetupState> {
  if (!hasDatabase()) return { status: "error", message: "データベースが設定されていないため作成できません。" };
  try {
    if (await isInitialSetupDone()) return { status: "done" };

    const h = await headers();
    const ipOk = await rateLimit(`setup:ip:${clientKey(h)}`, 5, 15 * 60);
    const globalOk = await rateLimit("setup:global", 20, 60 * 60);
    if (!ipOk || !globalOk) return { status: "error", message: "試行回数が多すぎます。しばらく時間をおいてお試しください。" };

    const input = parseSetupInput(fd);
    if (!input.ok) return { status: "error", message: "入力内容を確認してください", errors: input.errors };
    if (!checkSetupToken(input.data.token)) {
      return { status: "error", message: "セットアップキーが正しくありません", errors: { token: "セットアップキーが正しくありません" } };
    }

    const result = await createInitialOperator(input.data);
    return { status: result };
  } catch (e) {
    if (e instanceof DuplicateEmailError) {
      return { status: "error", message: "このメールアドレスは既に使われています", errors: { email: "このメールアドレスは既に使われています" } };
    }
    console.error("[admin/setup] failed", (e as { code?: unknown })?.code ?? (e as Error)?.name ?? "error");
    return { status: "error", message: GENERIC_ERROR };
  }
}
