import "server-only";
import { headers } from "next/headers";
import { loginSchema } from "@/lib/validation";
import { rateLimit } from "@/lib/security/rate-limit";
import { clientKey } from "@/lib/security/request";
import { authenticate } from "./login";
import { createSession } from "./session";
import type { FormState } from "@/components/console/form";

/** ログイン処理（IP単位のRate Limit + アカウントロック） */
export async function performLogin(fd: FormData, role: "OPERATOR" | "STORE"): Promise<FormState | "ok"> {
  const parsed = loginSchema.safeParse({ email: fd.get("email"), password: fd.get("password") });
  if (!parsed.success) return { message: "メールアドレスとパスワードを入力してください" };
  const h = await headers();
  if (!(await rateLimit(`login:${role}:${clientKey(h)}`, 10, 15 * 60))) {
    return { message: "ログイン試行回数が多すぎます。15分ほど時間をおいてお試しください。" };
  }
  const res = await authenticate(parsed.data.email, parsed.data.password, role);
  if (!res.ok) {
    return { message: res.reason === "locked" ? "アカウントが一時的にロックされています。15分後に再度お試しください。" : "メールアドレスまたはパスワードが正しくありません" };
  }
  await createSession(res.userId, role);
  return "ok";
}
