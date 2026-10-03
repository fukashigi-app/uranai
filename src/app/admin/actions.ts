"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { performLogin } from "@/lib/auth/login-action";
import { destroySession, requireOperator } from "@/lib/auth/session";
import { validatePasswordStrength, verifyPassword } from "@/lib/auth/password";
import { bankInfoSchema, fieldErrors, newStoreUserSchema, storeProfileSchema } from "@/lib/validation";
import {
  createStore,
  createStoreUser,
  DuplicateEmailError,
  getStoreById,
  getUserPasswordHash,
  getUserStoreId,
  readBankInfo,
  reissueStoreCode,
  setStoreShareBps,
  setStoreStatus,
  setUserActive,
  setUserPassword,
  updateBankInfo,
  updateStoreProfile,
} from "@/lib/services/stores";
import { generateSettlements, updateSettlementStatus } from "@/lib/services/settlements";
import { writeAudit } from "@/lib/services/audit";
import { randomToken } from "@/lib/security/crypto";
import type { FormState } from "@/components/console/form";

const uuid = z.uuid();
const PROFILE_FIELDS = ["name", "contactName", "postalCode", "address", "phone", "email"];
const BANK_FIELDS = ["bankName", "bankCode", "branchName", "branchCode", "accountType", "accountNumber", "accountHolder"];
const pick = (fd: FormData, keys: string[]) => Object.fromEntries(keys.map((k) => [k, fd.get(k) ?? ""]));

async function operator() {
  const u = await requireOperator();
  return { user: u, actor: { userId: u.id, role: "OPERATOR" as const } };
}

function assertId(id: string) {
  if (!uuid.safeParse(id).success) throw new Error("invalid id");
}

export async function adminLoginAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const r = await performLogin(fd, "OPERATOR");
  if (r === "ok") redirect("/admin");
  return r;
}

export async function adminLogoutAction() {
  await destroySession();
  redirect("/admin/login");
}

export async function createStoreAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const { actor } = await operator();
  const profile = storeProfileSchema.safeParse(pick(fd, PROFILE_FIELDS));
  const wantsUser = String(fd.get("userEmail") ?? "").trim() !== "";
  const userParsed = wantsUser
    ? newStoreUserSchema.safeParse({ name: fd.get("userName") || fd.get("contactName") || "店舗スタッフ", email: fd.get("userEmail"), password: fd.get("userPassword") })
    : null;
  const errors = { ...(profile.success ? {} : fieldErrors(profile.error)) };
  if (userParsed && !userParsed.success) {
    for (const [k, v] of Object.entries(fieldErrors(userParsed.error))) errors[`user${k[0].toUpperCase()}${k.slice(1)}`] = v;
  }
  if (userParsed?.success) {
    const weak = validatePasswordStrength(userParsed.data.password);
    if (weak) errors.userPassword = weak;
  }
  if (!profile.success || Object.keys(errors).length) return { errors, message: "入力内容を確認してください" };
  const store = await createStore(profile.data, actor);
  if (userParsed?.success) {
    try {
      await createStoreUser(store.id, userParsed.data, actor);
    } catch (e) {
      if (e instanceof DuplicateEmailError) {
        redirect(`/admin/stores/${store.id}?notice=dup-user`);
      }
      throw e;
    }
  }
  redirect(`/admin/stores/${store.id}`);
}

export async function updateStoreAction(storeId: string, _prev: FormState, fd: FormData): Promise<FormState> {
  const { actor } = await operator();
  assertId(storeId);
  const parsed = storeProfileSchema.safeParse(pick(fd, PROFILE_FIELDS));
  if (!parsed.success) return { errors: fieldErrors(parsed.error), message: "入力内容を確認してください" };
  const shareRaw = String(fd.get("storeSharePercent") ?? "").trim();
  if (shareRaw !== "") {
    const pct = Number(shareRaw);
    if (!Number.isFinite(pct) || pct < 0 || pct > 100 || Math.round(pct * 100) !== pct * 100) return { errors: { storeSharePercent: "0〜100の数値で入力してください" } };
    await setStoreShareBps(storeId, Math.round(pct * 100), actor);
  }
  await updateStoreProfile(storeId, parsed.data, actor);
  revalidatePath(`/admin/stores/${storeId}`);
  return { ok: true, message: "店舗情報を保存しました" };
}

export async function updateStoreBankAdminAction(storeId: string, _prev: FormState, fd: FormData): Promise<FormState> {
  const { actor } = await operator();
  assertId(storeId);
  const parsed = bankInfoSchema.safeParse(pick(fd, BANK_FIELDS));
  if (!parsed.success) return { errors: fieldErrors(parsed.error), message: "入力内容を確認してください" };
  await updateBankInfo(storeId, parsed.data, actor);
  revalidatePath(`/admin/stores/${storeId}`);
  return { ok: true, message: "振込先を保存しました" };
}

export async function setStoreStatusAction(storeId: string, status: "ACTIVE" | "SUSPENDED", _prev: FormState): Promise<FormState> {
  const { actor } = await operator();
  assertId(storeId);
  await setStoreStatus(storeId, status, actor);
  revalidatePath(`/admin/stores/${storeId}`);
  return { ok: true, message: status === "ACTIVE" ? "店舗を再開しました" : "店舗を停止しました（新規決済を受け付けません）" };
}

export async function reissueQrAction(storeId: string, _prev: FormState): Promise<FormState> {
  const { actor } = await operator();
  assertId(storeId);
  await reissueStoreCode(storeId, actor);
  revalidatePath(`/admin/stores/${storeId}`);
  return { ok: true, message: "QRコードを再発行しました。旧QRコードは無効になりました。店舗に新しいQRの設置を依頼してください。" };
}

/** 口座番号の全桁表示（振込作業用）。閲覧は監査ログに記録 */
export async function revealBankAction(storeId: string, _prev: FormState): Promise<FormState> {
  const { actor } = await operator();
  assertId(storeId);
  const s = await getStoreById(storeId);
  const bank = s ? readBankInfo(s) : null;
  if (!bank) return { message: "振込先が登録されていません" };
  await writeAudit({ actorUserId: actor.userId, actorRole: "OPERATOR", action: "store.bank.reveal", targetType: "store", targetId: storeId, storeId });
  return { ok: true, message: `${bank.bankName} ${bank.branchName} ${bank.accountType} ${bank.accountNumber} ${bank.accountHolder}` };
}

export async function createStoreUserAction(storeId: string, _prev: FormState, fd: FormData): Promise<FormState> {
  const { actor } = await operator();
  assertId(storeId);
  const parsed = newStoreUserSchema.safeParse({ name: fd.get("name"), email: fd.get("email"), password: fd.get("password") });
  if (!parsed.success) return { errors: fieldErrors(parsed.error) };
  const weak = validatePasswordStrength(parsed.data.password);
  if (weak) return { errors: { password: weak } };
  try {
    await createStoreUser(storeId, parsed.data, actor);
  } catch (e) {
    if (e instanceof DuplicateEmailError) return { errors: { email: "このメールアドレスは既に使われています" } };
    throw e;
  }
  revalidatePath(`/admin/stores/${storeId}`);
  return { ok: true, message: "店舗アカウントを作成しました" };
}

/** 店舗アカウントのパスワードを再発行（一時パスワードは一度だけ表示） */
export async function resetStoreUserPasswordAction(storeId: string, userId: string, _prev: FormState): Promise<FormState> {
  const { actor } = await operator();
  assertId(storeId);
  assertId(userId);
  if ((await getUserStoreId(userId)) !== storeId) return { message: "アカウントが見つかりません" };
  const temp = `${randomToken(9)}9a`;
  await setUserPassword(userId, temp, actor);
  return { ok: true, message: `一時パスワード: ${temp}（この画面を閉じると再表示できません。店舗へ安全な方法で伝え、変更を依頼してください）` };
}

export async function toggleStoreUserAction(storeId: string, userId: string, active: boolean, _prev: FormState): Promise<FormState> {
  const { actor } = await operator();
  assertId(storeId);
  assertId(userId);
  if ((await getUserStoreId(userId)) !== storeId) return { message: "アカウントが見つかりません" };
  await setUserActive(userId, active, storeId, actor);
  revalidatePath(`/admin/stores/${storeId}`);
  return { ok: true, message: active ? "アカウントを有効化しました" : "アカウントを無効化しました" };
}

export async function generateSettlementsAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const { actor } = await operator();
  const ym = String(fd.get("yearMonth") ?? "");
  try {
    const r = await generateSettlements(ym, actor);
    revalidatePath("/admin/settlements");
    return { ok: true, message: `精算を作成しました（作成/更新 ${r.upserted}件、処理中・支払済のためスキップ ${r.skipped}件）` };
  } catch (e) {
    return { message: (e as Error).message };
  }
}

const statusSchema = z.enum(["UNPAID", "PROCESSING", "PAID"]);

export async function updateSettlementAction(id: string, _prev: FormState, fd: FormData): Promise<FormState> {
  const { actor } = await operator();
  assertId(id);
  const status = statusSchema.safeParse(fd.get("status"));
  if (!status.success) return { message: "状態を選択してください" };
  await updateSettlementStatus(id, status.data, String(fd.get("note") ?? ""), actor);
  revalidatePath("/admin/settlements");
  return { ok: true, message: "更新しました" };
}

export async function changeAdminPasswordAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const { user, actor } = await operator();
  const hash = await getUserPasswordHash(user.id);
  if (!hash || !(await verifyPassword(String(fd.get("currentPassword") ?? ""), hash))) return { errors: { currentPassword: "現在のパスワードが正しくありません" } };
  const next = String(fd.get("newPassword") ?? "");
  const weak = validatePasswordStrength(next);
  if (weak) return { errors: { newPassword: weak } };
  await setUserPassword(user.id, next, actor);
  return { ok: true, message: "パスワードを変更しました" };
}
