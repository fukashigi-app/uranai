"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { performLogin } from "@/lib/auth/login-action";
import { destroySession, requireStoreUser } from "@/lib/auth/session";
import { verifyPassword, validatePasswordStrength } from "@/lib/auth/password";
import { bankInfoSchema, fieldErrors, storeProfileSchema } from "@/lib/validation";
import { getUserPasswordHash, setUserPassword, updateBankInfo, updateStoreProfile } from "@/lib/services/stores";
import type { FormState } from "@/components/console/form";

export async function storeLoginAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const r = await performLogin(fd, "STORE");
  if (r === "ok") redirect("/store/dashboard");
  return r;
}

export async function storeLogoutAction() {
  await destroySession();
  redirect("/store/login");
}

/** 店舗IDは必ずセッションから解決する（フォームの値は使わない） */
export async function updateStoreProfileAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const { user, store } = await requireStoreUser();
  const parsed = storeProfileSchema.safeParse(Object.fromEntries(["name", "contactName", "postalCode", "address", "phone", "email"].map((k) => [k, fd.get(k) ?? ""])));
  if (!parsed.success) return { errors: fieldErrors(parsed.error), message: "入力内容を確認してください" };
  await updateStoreProfile(store.id, parsed.data, { userId: user.id, role: "STORE" });
  revalidatePath("/store", "layout");
  return { ok: true, message: "店舗情報を保存しました" };
}

export async function updateBankAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const { user, store } = await requireStoreUser();
  const parsed = bankInfoSchema.safeParse(Object.fromEntries(["bankName", "bankCode", "branchName", "branchCode", "accountType", "accountNumber", "accountHolder"].map((k) => [k, fd.get(k) ?? ""])));
  if (!parsed.success) return { errors: fieldErrors(parsed.error), message: "入力内容を確認してください" };
  // 口座変更は本人確認としてパスワード再入力を求める
  const hash = await getUserPasswordHash(user.id);
  if (!hash || !(await verifyPassword(String(fd.get("currentPassword") ?? ""), hash))) {
    return { errors: { currentPassword: "パスワードが正しくありません" }, message: "確認のためログインパスワードを入力してください" };
  }
  await updateBankInfo(store.id, parsed.data, { userId: user.id, role: "STORE" });
  revalidatePath("/store/bank");
  return { ok: true, message: "振込先を保存しました" };
}

export async function changeStorePasswordAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const { user } = await requireStoreUser();
  const current = String(fd.get("currentPassword") ?? "");
  const next = String(fd.get("newPassword") ?? "");
  const hash = await getUserPasswordHash(user.id);
  if (!hash || !(await verifyPassword(current, hash))) return { errors: { currentPassword: "現在のパスワードが正しくありません" } };
  const weak = validatePasswordStrength(next);
  if (weak) return { errors: { newPassword: weak } };
  await setUserPassword(user.id, next, { userId: user.id, role: "STORE" });
  return { ok: true, message: "パスワードを変更しました" };
}
