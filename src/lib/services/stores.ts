import "server-only";
import { eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { storeUsers, stores, users, type Store } from "@/lib/db/schema";
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
  const [before] = await db().select({ status: stores.status }).from(stores).where(eq(stores.id, storeId));
  if (!before || before.status === status) return;
  await db().update(stores).set({ status }).where(eq(stores.id, storeId));
  await writeAudit({ actorUserId: actor.userId, actorRole: actor.role, action: status === "ACTIVE" ? "store.resume" : "store.suspend", targetType: "store", targetId: storeId, storeId, before, after: { status } });
}

/** QR再発行: 店舗コードを新しくする（旧QRは無効になる） */
export async function reissueStoreCode(storeId: string, actor: Actor): Promise<string> {
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

export class DuplicateEmailError extends Error {}

export async function createStoreUser(storeId: string, input: { name: string; email: string; password: string }, actor: Actor) {
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
  await db().update(users).set({ passwordHash: await hashPassword(password), failedLoginCount: 0, lockedUntil: null }).where(eq(users.id, userId));
  await writeAudit({ actorUserId: actor.userId, actorRole: actor.role, action: "user.password.set", targetType: "user", targetId: userId });
}
