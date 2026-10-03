import "server-only";
import { isFirestore } from "@/lib/data-provider";
import * as fsStores from "@/lib/firestore/stores";
import * as fsUsers from "@/lib/firestore/users";
import { desc, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { auditLogs, storeUsers, stores, users, type Store } from "@/lib/db/schema";
import { decryptJson, encryptJson, generateStoreCode } from "@/lib/security/crypto";
import { hashPassword } from "@/lib/auth/password";
import { DEFAULT_STORE_SHARE_BPS } from "@/config/pricing";
import type { BankInfo, StoreProfileInput } from "@/lib/validation";
import { writeAudit } from "./audit";

export type Actor = { userId: string | null; role: "OPERATOR" | "STORE" | "SYSTEM" };

const PROFILE_KEYS = ["name", "contactName", "postalCode", "address", "phone", "email"] as const;

function pickProfile(s: Pick<Store, (typeof PROFILE_KEYS)[number]>) {
  return Object.fromEntries(PROFILE_KEYS.map((k) => [k, s[k]])) as StoreProfileInput;
}

export async function createStore(input: StoreProfileInput, actor: Actor): Promise<Store> {
  if (isFirestore()) return fsStores.createStore(input, actor);
  for (let attempt = 0; attempt < 5; attempt++) {
    const inserted = await db()
      .insert(stores)
      .values({ ...input, storeCode: generateStoreCode(), storeShareBps: DEFAULT_STORE_SHARE_BPS })
      .onConflictDoNothing()
      .returning();
    if (inserted[0]) {
      await writeAudit({ actorUserId: actor.userId, actorRole: actor.role, action: "store.create", targetType: "store", targetId: inserted[0].id, storeId: inserted[0].id, after: input });
      return inserted[0];
    }
  }
  throw new Error("failed to generate unique store code");
}

export async function updateStoreProfile(storeId: string, input: StoreProfileInput, actor: Actor): Promise<void> {
  if (isFirestore()) return fsStores.updateStoreProfile(storeId, input, actor);
  await db().transaction(async (tx) => {
    const [before] = await tx.select().from(stores).where(eq(stores.id, storeId)).for("update");
    if (!before) throw new Error("store not found");
    await tx.update(stores).set(input).where(eq(stores.id, storeId));
    const prev = pickProfile(before);
    const changedBefore: Record<string, string> = {};
    const changedAfter: Record<string, string> = {};
    for (const k of PROFILE_KEYS) {
      if (prev[k] !== input[k]) {
        changedBefore[k] = prev[k];
        changedAfter[k] = input[k];
      }
    }
    if (Object.keys(changedAfter).length) {
      await writeAudit({ actorUserId: actor.userId, actorRole: actor.role, action: "store.profile.update", targetType: "store", targetId: storeId, storeId, before: changedBefore, after: changedAfter }, tx);
    }
  });
}

export function maskAccountNumber(last4: string | null | undefined): string {
  return last4 ? `***${last4}` : "未登録";
}

/** 履歴にはマスク済みの値のみ残す */
function maskedBank(b: BankInfo | null) {
  if (!b) return null;
  return { bankName: b.bankName, bankCode: b.bankCode, branchName: b.branchName, branchCode: b.branchCode, accountType: b.accountType, accountNumber: `***${b.accountNumber.slice(-4)}`, accountHolder: b.accountHolder };
}

export function readBankInfo(store: Pick<Store, "bankInfoEncrypted">): BankInfo | null {
  if (!store.bankInfoEncrypted) return null;
  return decryptJson<BankInfo>(store.bankInfoEncrypted);
}

/** 画面表示用（口座番号はマスク） */
export function readBankInfoMasked(store: Pick<Store, "bankInfoEncrypted">) {
  return maskedBank(readBankInfo(store));
}

export async function updateBankInfo(storeId: string, bank: BankInfo, actor: Actor): Promise<void> {
  if (isFirestore()) return fsStores.updateBankInfo(storeId, bank, actor);
  await db().transaction(async (tx) => {
    const [before] = await tx.select().from(stores).where(eq(stores.id, storeId)).for("update");
    if (!before) throw new Error("store not found");
    await tx
      .update(stores)
      .set({ bankInfoEncrypted: encryptJson(bank), bankAccountLast4: bank.accountNumber.slice(-4), bankUpdatedAt: new Date() })
      .where(eq(stores.id, storeId));
    await writeAudit({ actorUserId: actor.userId, actorRole: actor.role, action: "store.bank.update", targetType: "store", targetId: storeId, storeId, before: maskedBank(readBankInfo(before)), after: maskedBank(bank) }, tx);
  });
}

export async function setStoreStatus(storeId: string, status: "ACTIVE" | "SUSPENDED", actor: Actor): Promise<void> {
  if (isFirestore()) return fsStores.setStoreStatus(storeId, status, actor);
  const [before] = await db().select({ status: stores.status }).from(stores).where(eq(stores.id, storeId));
  if (!before || before.status === status) return;
  await db().update(stores).set({ status }).where(eq(stores.id, storeId));
  await writeAudit({ actorUserId: actor.userId, actorRole: actor.role, action: status === "ACTIVE" ? "store.resume" : "store.suspend", targetType: "store", targetId: storeId, storeId, before, after: { status } });
}

/** QR再発行: 店舗コードを新しくする（旧QRは無効になる） */
export async function reissueStoreCode(storeId: string, actor: Actor): Promise<string> {
  if (isFirestore()) return fsStores.reissueStoreCode(storeId, actor);
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = generateStoreCode();
    const [before] = await db().select({ storeCode: stores.storeCode }).from(stores).where(eq(stores.id, storeId));
    if (!before) throw new Error("store not found");
    const updated = await db()
      .update(stores)
      .set({ storeCode: code })
      .where(sql`${stores.id} = ${storeId} AND NOT EXISTS (SELECT 1 FROM stores s2 WHERE s2.store_code = ${code})`)
      .returning({ id: stores.id });
    if (updated[0]) {
      await writeAudit({ actorUserId: actor.userId, actorRole: actor.role, action: "store.qr.reissue", targetType: "store", targetId: storeId, storeId, before, after: { storeCode: code } });
      return code;
    }
  }
  throw new Error("failed to reissue store code");
}

export { DuplicateEmailError } from "@/lib/errors";
import { DuplicateEmailError } from "@/lib/errors";

export async function createStoreUser(storeId: string, input: { name: string; email: string; password: string }, actor: Actor) {
  if (isFirestore()) return fsUsers.createStoreUser(storeId, input, actor);
  const passwordHash = await hashPassword(input.password);
  return db().transaction(async (tx) => {
    const inserted = await tx
      .insert(users)
      .values({ email: input.email.trim().toLowerCase(), name: input.name, passwordHash, role: "STORE" })
      .onConflictDoNothing()
      .returning({ id: users.id });
    if (!inserted[0]) throw new DuplicateEmailError();
    await tx.insert(storeUsers).values({ userId: inserted[0].id, storeId, role: "OWNER" });
    await writeAudit({ actorUserId: actor.userId, actorRole: actor.role, action: "store.user.create", targetType: "user", targetId: inserted[0].id, storeId, after: { email: input.email, name: input.name } }, tx);
    return inserted[0].id;
  });
}

export async function createOperator(input: { name: string; email: string; password: string }) {
  if (isFirestore()) return fsUsers.createOperator(input);
  const passwordHash = await hashPassword(input.password);
  const inserted = await db()
    .insert(users)
    .values({ email: input.email.trim().toLowerCase(), name: input.name, passwordHash, role: "OPERATOR" })
    .onConflictDoNothing()
    .returning({ id: users.id });
  if (!inserted[0]) throw new DuplicateEmailError();
  return inserted[0].id;
}

export async function setUserPassword(userId: string, password: string, actor: Actor) {
  if (isFirestore()) return fsUsers.setUserPassword(userId, password, actor);
  await db().update(users).set({ passwordHash: await hashPassword(password), failedLoginCount: 0, lockedUntil: null }).where(eq(users.id, userId));
  await writeAudit({ actorUserId: actor.userId, actorRole: actor.role, action: "user.password.set", targetType: "user", targetId: userId });
}

// ===== 画面・アクションから使う読み書き（以前はページ内で直接DBを操作していたもの）=====

export async function getStoreById(id: string): Promise<Store | null> {
  if (isFirestore()) return fsStores.getStoreById(id);
  const [s] = await db().select().from(stores).where(eq(stores.id, id));
  return s ?? null;
}

export async function getStoresByIds(ids: string[]): Promise<Store[]> {
  if (isFirestore()) return fsStores.getStoresByIds(ids);
  if (!ids.length) return [];
  return db().select().from(stores).where(inArray(stores.id, ids));
}

/** 店舗配分率の変更（以後の決済にのみ適用。過去の取引は保存済みの取り分のまま） */
export async function setStoreShareBps(storeId: string, bps: number, actor: Actor): Promise<void> {
  if (isFirestore()) return fsStores.setStoreShareBps(storeId, bps, actor);
  const [before] = await db().select({ bps: stores.storeShareBps }).from(stores).where(eq(stores.id, storeId));
  if (!before || before.bps === bps) return;
  await db().update(stores).set({ storeShareBps: bps }).where(eq(stores.id, storeId));
  await writeAudit({ actorUserId: actor.userId, actorRole: actor.role, action: "store.share.update", targetType: "store", targetId: storeId, storeId, before: { storeShareBps: before.bps }, after: { storeShareBps: bps } });
}

export async function getUserPasswordHash(userId: string): Promise<string | null> {
  if (isFirestore()) return fsUsers.getUserPasswordHash(userId);
  const [u] = await db().select({ hash: users.passwordHash }).from(users).where(eq(users.id, userId));
  return u?.hash ?? null;
}

/** ユーザーが所属する店舗ID（最初の1件） */
export async function getUserStoreId(userId: string): Promise<string | null> {
  if (isFirestore()) return fsUsers.getUserStoreId(userId);
  const [link] = await db().select().from(storeUsers).where(eq(storeUsers.userId, userId));
  return link?.storeId ?? null;
}

export async function setUserActive(userId: string, active: boolean, storeId: string, actor: Actor): Promise<void> {
  if (isFirestore()) return fsUsers.setUserActive(userId, active, storeId, actor);
  await db().update(users).set({ isActive: active }).where(eq(users.id, userId));
  await writeAudit({ actorUserId: actor.userId, actorRole: actor.role, action: active ? "user.enable" : "user.disable", targetType: "user", targetId: userId, storeId });
}

export type StaffRow = { id: string; name: string; email: string; isActive: boolean; lastLoginAt: Date | null };

export async function listStoreStaff(storeId: string): Promise<StaffRow[]> {
  if (isFirestore()) return fsUsers.listStoreStaff(storeId);
  return db()
    .select({ id: users.id, name: users.name, email: users.email, isActive: users.isActive, lastLoginAt: users.lastLoginAt })
    .from(storeUsers)
    .innerJoin(users, eq(users.id, storeUsers.userId))
    .where(eq(storeUsers.storeId, storeId));
}

export type AuditRow = { id: string; action: string; actorRole: string; createdAt: Date; before: unknown; after: unknown };

export async function listStoreAuditLogs(storeId: string, limit = 30): Promise<AuditRow[]> {
  if (isFirestore()) return fsStores.listStoreAuditLogs(storeId, limit);
  return db()
    .select({ id: auditLogs.id, action: auditLogs.action, actorRole: auditLogs.actorRole, createdAt: auditLogs.createdAt, before: auditLogs.before, after: auditLogs.after })
    .from(auditLogs)
    .where(eq(auditLogs.storeId, storeId))
    .orderBy(desc(auditLogs.createdAt))
    .limit(limit);
}
