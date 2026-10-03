import "server-only";
import { randomUUID } from "node:crypto";
import { FieldValue, type DocumentData } from "firebase-admin/firestore";
import type { Store } from "@/lib/db/schema";
import { DEFAULT_STORE_SHARE_BPS } from "@/config/pricing";
import { decryptJson, encryptJson, generateStoreCode } from "@/lib/security/crypto";
import type { BankInfo, StoreProfileInput } from "@/lib/validation";
import { C, fsdb, mustDate, toDate } from "./admin";
import { writeAudit, type AuditEntry } from "./audit";
import { isAlreadyExists } from "./shared";

/**
 * 店舗（Firestore 版）。
 *  stores/{storeId}       … 店舗情報（口座は暗号化済みの文字列のみ）
 *  storeCodes/{storeCode} … QRの店舗コード → storeId（コードの重複防止）
 */

type Actor = { userId: string | null; role: AuditEntry["actorRole"] };

const PROFILE_KEYS = ["name", "contactName", "postalCode", "address", "phone", "email"] as const;

export function toStore(id: string, d: DocumentData): Store {
  return {
    id,
    storeCode: String(d.storeCode),
    name: String(d.name),
    contactName: String(d.contactName ?? ""),
    postalCode: String(d.postalCode ?? ""),
    address: String(d.address ?? ""),
    phone: String(d.phone ?? ""),
    email: String(d.email ?? ""),
    status: d.status === "SUSPENDED" ? "SUSPENDED" : "ACTIVE",
    storeShareBps: Number(d.storeShareBps ?? DEFAULT_STORE_SHARE_BPS),
    bankInfoEncrypted: d.bankInfoEncrypted ?? null,
    bankAccountLast4: d.bankAccountLast4 ?? null,
    bankUpdatedAt: toDate(d.bankUpdatedAt),
    createdAt: mustDate(d.createdAt),
    updatedAt: mustDate(d.updatedAt),
  };
}

const storeRef = (id: string) => fsdb().collection(C.stores).doc(id);
const codeRef = (code: string) => fsdb().collection(C.storeCodes).doc(code);

export async function getStoreById(id: string): Promise<Store | null> {
  const s = await storeRef(id).get();
  return s.exists ? toStore(s.id, s.data()!) : null;
}

export async function getStoresByIds(ids: string[]): Promise<Store[]> {
  const unique = [...new Set(ids)];
  if (!unique.length) return [];
  const snaps = await fsdb().getAll(...unique.map(storeRef));
  return snaps.filter((s) => s.exists).map((s) => toStore(s.id, s.data()!));
}

/** 全店舗（集計・一覧用）。最終利用日時も返す */
export async function listAllStores(): Promise<(Store & { lastUsedAt: Date | null })[]> {
  const snap = await fsdb().collection(C.stores).get();
  return snap.docs.map((d) => ({ ...toStore(d.id, d.data()), lastUsedAt: toDate(d.get("lastUsedAt")) }));
}

/** QRの店舗コードから店舗を探す */
export async function findStoreByCode(code: string): Promise<{ id: string; name: string; status: "ACTIVE" | "SUSPENDED"; storeCode: string } | null> {
  const c = await codeRef(code).get();
  if (!c.exists) return null;
  const s = await storeRef(String(c.get("storeId"))).get();
  if (!s.exists || s.get("storeCode") !== code) return null;
  return { id: s.id, name: String(s.get("name")), status: s.get("status") === "SUSPENDED" ? "SUSPENDED" : "ACTIVE", storeCode: code };
}

export async function createStore(input: StoreProfileInput, actor: Actor): Promise<Store> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const id = randomUUID();
    const code = generateStoreCode();
    try {
      await fsdb().runTransaction(async (tx) => {
        tx.create(codeRef(code), { storeId: id }); // 既にあるコードなら失敗 → 作り直し
        tx.create(storeRef(id), {
          ...input,
          storeCode: code,
          status: "ACTIVE",
          storeShareBps: DEFAULT_STORE_SHARE_BPS,
          bankInfoEncrypted: null,
          bankAccountLast4: null,
          bankUpdatedAt: null,
          lastUsedAt: null,
          createdAt: FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp(),
        });
        await writeAudit({ actorUserId: actor.userId, actorRole: actor.role, action: "store.create", targetType: "store", targetId: id, storeId: id, after: input }, tx);
      });
      return (await getStoreById(id))!;
    } catch (e) {
      if (!isAlreadyExists(e)) throw e;
    }
  }
  throw new Error("failed to generate unique store code");
}

export async function updateStoreProfile(storeId: string, input: StoreProfileInput, actor: Actor): Promise<void> {
  await fsdb().runTransaction(async (tx) => {
    const snap = await tx.get(storeRef(storeId));
    if (!snap.exists) throw new Error("store not found");
    const prev = snap.data()!;
    const changedBefore: Record<string, string> = {};
    const changedAfter: Record<string, string> = {};
    for (const k of PROFILE_KEYS) {
      if (String(prev[k] ?? "") !== input[k]) {
        changedBefore[k] = String(prev[k] ?? "");
        changedAfter[k] = input[k];
      }
    }
    tx.update(storeRef(storeId), { ...input, updatedAt: FieldValue.serverTimestamp() });
    if (Object.keys(changedAfter).length) {
      await writeAudit({ actorUserId: actor.userId, actorRole: actor.role, action: "store.profile.update", targetType: "store", targetId: storeId, storeId, before: changedBefore, after: changedAfter }, tx);
    }
  });
}

function maskedBank(b: BankInfo | null) {
  if (!b) return null;
  return { bankName: b.bankName, bankCode: b.bankCode, branchName: b.branchName, branchCode: b.branchCode, accountType: b.accountType, accountNumber: `***${b.accountNumber.slice(-4)}`, accountHolder: b.accountHolder };
}

export async function updateBankInfo(storeId: string, bank: BankInfo, actor: Actor): Promise<void> {
  const encrypted = encryptJson(bank); // 暗号化キー未設定ならここで失敗（平文で保存しない）
  await fsdb().runTransaction(async (tx) => {
    const snap = await tx.get(storeRef(storeId));
    if (!snap.exists) throw new Error("store not found");
    const prevEnc = snap.get("bankInfoEncrypted") as string | null;
    const before = prevEnc ? maskedBank(decryptJson<BankInfo>(prevEnc)) : null;
    tx.update(storeRef(storeId), { bankInfoEncrypted: encrypted, bankAccountLast4: bank.accountNumber.slice(-4), bankUpdatedAt: new Date(), updatedAt: FieldValue.serverTimestamp() });
    await writeAudit({ actorUserId: actor.userId, actorRole: actor.role, action: "store.bank.update", targetType: "store", targetId: storeId, storeId, before, after: maskedBank(bank) }, tx);
  });
}

export async function setStoreStatus(storeId: string, status: "ACTIVE" | "SUSPENDED", actor: Actor): Promise<void> {
  const snap = await storeRef(storeId).get();
  if (!snap.exists || snap.get("status") === status) return;
  await storeRef(storeId).update({ status, updatedAt: FieldValue.serverTimestamp() });
  await writeAudit({ actorUserId: actor.userId, actorRole: actor.role, action: status === "ACTIVE" ? "store.resume" : "store.suspend", targetType: "store", targetId: storeId, storeId, before: { status: snap.get("status") }, after: { status } });
}

/** QR再発行: 新しいコードを確保し、古いコードを無効にする（同時に1つのトランザクションで） */
export async function reissueStoreCode(storeId: string, actor: Actor): Promise<string> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = generateStoreCode();
    try {
      await fsdb().runTransaction(async (tx) => {
        const snap = await tx.get(storeRef(storeId));
        if (!snap.exists) throw new Error("store not found");
        const old = String(snap.get("storeCode"));
        tx.create(codeRef(code), { storeId });
        tx.delete(codeRef(old));
        tx.update(storeRef(storeId), { storeCode: code, updatedAt: FieldValue.serverTimestamp() });
        await writeAudit({ actorUserId: actor.userId, actorRole: actor.role, action: "store.qr.reissue", targetType: "store", targetId: storeId, storeId, before: { storeCode: old }, after: { storeCode: code } }, tx);
      });
      return code;
    } catch (e) {
      if (!isAlreadyExists(e)) throw e;
    }
  }
  throw new Error("failed to reissue store code");
}

export async function setStoreShareBps(storeId: string, bps: number, actor: Actor): Promise<void> {
  const snap = await storeRef(storeId).get();
  if (!snap.exists || Number(snap.get("storeShareBps")) === bps) return;
  await storeRef(storeId).update({ storeShareBps: bps, updatedAt: FieldValue.serverTimestamp() });
  await writeAudit({ actorUserId: actor.userId, actorRole: actor.role, action: "store.share.update", targetType: "store", targetId: storeId, storeId, before: { storeShareBps: snap.get("storeShareBps") }, after: { storeShareBps: bps } });
}

export async function listStoreAuditLogs(storeId: string, limit = 30) {
  const snap = await fsdb().collection(C.auditLogs).where("storeId", "==", storeId).get();
  return snap.docs
    .map((d) => ({ id: d.id, action: String(d.get("action")), actorRole: String(d.get("actorRole")), createdAt: mustDate(d.get("createdAt")), before: d.get("before") ?? null, after: d.get("after") ?? null }))
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
    .slice(0, limit);
}
