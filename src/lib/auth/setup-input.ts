import "server-only";
import { z } from "zod";
import { sha256Hex, safeEqual } from "@/lib/security/crypto";
import { validatePasswordStrength } from "./password";

/** 初回の運営アカウント作成フォームの入力チェック（パスワードは既存ルール validatePasswordStrength を使用） */
const schema = z.object({
  name: z.string().trim().max(100, "100文字以内で入力してください"),
  email: z.email("メールアドレスを正しく入力してください").max(254, "メールアドレスが長すぎます"),
  password: z.string().max(200, "パスワードが長すぎます"),
  passwordConfirm: z.string().max(200),
  token: z.string().max(500),
});

export type SetupInput = { name: string; email: string; password: string; token: string };

export function parseSetupInput(fd: FormData): { ok: true; data: SetupInput } | { ok: false; errors: Record<string, string> } {
  const str = (k: string) => {
    const v = fd.get(k);
    return typeof v === "string" ? v : "";
  };
  const parsed = schema.safeParse({
    name: str("name"),
    email: str("email").trim(),
    password: str("password"),
    passwordConfirm: str("passwordConfirm"),
    token: str("token"),
  });
  const errors: Record<string, string> = {};
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const k = String(issue.path[0] ?? "form");
      errors[k] ??= issue.message;
    }
    return { ok: false, errors };
  }
  const d = parsed.data;
  const weak = validatePasswordStrength(d.password);
  if (weak) errors.password = weak;
  else if (d.password !== d.passwordConfirm) errors.passwordConfirm = "確認用パスワードが一致しません";
  if (Object.keys(errors).length) return { ok: false, errors };
  return { ok: true, data: { name: d.name || "運営管理者", email: d.email.toLowerCase(), password: d.password, token: d.token } };
}

/**
 * 任意のセットアップキー（Vercel の環境変数 ADMIN_SETUP_TOKEN）。
 * 設定されている場合は、画面でこのキーを入力しないと作成できない（URL を知った第三者による先回りを防ぐ）。
 */
export function setupTokenRequired(): boolean {
  return Boolean(process.env.ADMIN_SETUP_TOKEN?.trim());
}

export function checkSetupToken(input: string): boolean {
  const expected = process.env.ADMIN_SETUP_TOKEN?.trim();
  if (!expected) return true;
  // 長さの違いも含めて比較時間を一定にするため、ハッシュ同士を比較
  return safeEqual(sha256Hex(input.trim()), sha256Hex(expected));
}
