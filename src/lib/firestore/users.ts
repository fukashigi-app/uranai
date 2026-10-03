import "server-only";
import { randomUUID } from "node:crypto";
import { FieldValue } from "firebase-admin/firestore";
import type { Store } from "@/lib/db/schema";
import { getDummyHash, hashPassword, verifyPassword } from "@/lib/auth/password";
import type { LoginResult } from "@/lib/auth/login";
import type { SessionUser } from "@/lib/auth/session";
import { DuplicateEmailError } from "@/lib/errors";
import { C, fsdb, mustDate, toDate } from "./admin";
import { writeAudit, type AuditEntry } from "./audit";
import { isAlreadyExists } from "./shared";
import { toStore } from "./stores";

/**
 * ユーザー・ログイン・セッション（Firestore 版）。
 *  users/{userId}             … アカウント
 *  userEmails/{メール小文字}   … メールアドレスの重複防止（PostgreSQL の UNIQUE の代わり）
 *  storeUsers/{userId_storeId} … どの店舗の担当か
 *  authSessions/{トークンのハッシュ} … ログイン中の状態（生トークンは保存しない）
 */

type Actor = { userId: string | null; role: AuditEntry["actorRole"] };

const MAX_FAILURES = 5;
const LOCK_MS = 15 * 60 * 1000;

// ---------- セッション ----------

export async function createSession(hash: string, userId: string, expiresAt: Date): Promise<void> {
  await fsdb().collection(C.authSessions).doc(hash).set({ userId, expiresAt, createdAt: FieldValue.serverTimestamp() });
}

export async function deleteSession(hash: string): Promise<void> {
  await fsdb().collection(C.authSessions).doc(hash).delete();
}

export async function getSessionUser(hash: string): Promise<SessionUser | null> {
  const s = await fsdb().collection(C.authSessions).doc(hash).get();
  if (!s.exists) return null;
  const exp = toDate(s.get("expiresAt"));
  if (!exp || exp <= new Date()) return null;
  const u = await fsdb().collection(C.users).doc(String(s.get("userId"))).get();
  if (!u.exists || u.get("isActive") !== true) return null;
  return { id: u.id, email: String(u.get("email")), name: String(u.get("name")), role: u.get("role") };
}

/** 店舗スタッフの担当店舗（最初に紐づいた1店舗）。storeId は必ずここで解決する */
export async function getStoreForUser(userId: string): Promise<Store | null> {
  const links = await fsdb().collection(C.storeUsers).where("userId", "==", userId).get();
  if (links.empty) return null;
  const first = links.docs.map((d) => ({ storeId: String(d.get("storeId")), at: mustDate(d.get("createdAt")).getTime() })).sort((a, b) => a.at - b.at)[0];
  const st = await fsdb().collection(C.stores).doc(first.storeId).get();
  return st.exists ? toStore(st.id, st.data()!) : null;
}

// ---------- ログイン（失敗5回で15分ロック） ----------

export async function authenticate(emailRaw: string, password: string, role: "OPERATOR" | "STORE"): Promise<LoginResult> {
  const email = emailRaw.trim().toLowerCase();
  const idx = email ? await fsdb().collection(C.userEmails).doc(email).get() : null;
  const userRef = idx?.exists ? fsdb().collection(C.users).doc(String(idx.get("userId"))) : null;
  const snap = userRef ? await userRef.get() : null;

  if (!snap?.exists || !userRef) {
    await verifyPassword(password, await getDummyHash()); // 存在有無をタイミングで推測させない
    return { ok: false, reason: "invalid" };
  }
  const u = snap.data()!;
  const lockedUntil = toDate(u.lockedUntil);
  if (lockedUntil && lockedUntil > new Date()) return { ok: false, reason: "locked" };

  const valid = await verifyPassword(password, String(u.passwordHash));
  if (!valid || u.isActive !== true || u.role !== role) {
    if (!valid) {
      // 同時に何回も試された場合でも回数を取りこぼさないようトランザクションで加算
      await fsdb().runTransaction(async (tx) => {
        const cur = await tx.get(userRef);
        const failures = Number(cur.get("failedLoginCount") ?? 0) + 1;
        tx.update(userRef, {
          failedLoginCount: failures >= MAX_FAILURES ? 0 : failures,
          lockedUntil: failures >= MAX_FAILURES ? new Date(Date.now() + LOCK_MS) : (toDate(cur.get("lockedUntil")) ?? null),
        });
      });
    }
    return { ok: false, reason: "invalid" };
  }
  await userRef.update({ failedLoginCount: 0, lockedUntil: null, lastLoginAt: new Date(), updatedAt: FieldValue.serverTimestamp() });
  return { ok: true, userId: snap.id };
}

// ---------- アカウント作成・変更 ----------

async function createUser(
  input: { name: string; email: string; password: string },
  role: "OPERATOR" | "STORE",
  link?: { storeId: string; actor: Actor },
): Promise<string> {
  const email = input.email.trim().toLowerCase();
  const passwordHash = await hashPassword(input.password);
  const userId = randomUUID();
  try {
    await fsdb().runTransaction(async (tx) => {
      const emailRef = fsdb().collection(C.userEmails).doc(email);
      // create() は既に存在すると失敗する → 同じメールの二重登録を防ぐ
      tx.create(emailRef, { userId });
      tx.create(fsdb().collection(C.users).doc(userId), {
        email,
        name: input.name,
        passwordHash,
        role,
        isActive: true,
        failedLoginCount: 0,
        lockedUntil: null,
        lastLoginAt: null,
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      });
      if (link) {
        tx.create(fsdb().collection(C.storeUsers).doc(`${userId}_${link.storeId}`), {
          userId,
          storeId: link.storeId,
          role: "OWNER",
          createdAt: FieldValue.serverTimestamp(),
        });
        await writeAudit(
          { actorUserId: link.actor.userId, actorRole: link.actor.role, action: "store.user.create", targetType: "user", targetId: userId, storeId: link.storeId, after: { email: input.email, name: input.name } },
          tx,
        );
      }
    });
  } catch (e) {
    if (isAlreadyExists(e)) throw new DuplicateEmailError();
    throw e;
  }
  return userId;
}

export function createOperator(input: { name: string; email: string; password: string }): Promise<string> {
  return createUser(input, "OPERATOR");
}

export function createStoreUser(storeId: string, input: { name: string; email: string; password: string }, actor: Actor): Promise<string> {
  return createUser(input, "STORE", { storeId, actor });
}

export async function setUserPassword(userId: string, password: string, actor: Actor): Promise<void> {
  await fsdb()
    .collection(C.users)
    .doc(userId)
    .update({ passwordHash: await hashPassword(password), failedLoginCount: 0, lockedUntil: null, updatedAt: FieldValue.serverTimestamp() });
  await writeAudit({ actorUserId: actor.userId, actorRole: actor.role, action: "user.password.set", targetType: "user", targetId: userId });
}

export async function getUserPasswordHash(userId: string): Promise<string | null> {
  const u = await fsdb().collection(C.users).doc(userId).get();
  return u.exists ? String(u.get("passwordHash")) : null;
}

export async function getUserStoreId(userId: string): Promise<string | null> {
  const links = await fsdb().collection(C.storeUsers).where("userId", "==", userId).limit(1).get();
  return links.empty ? null : String(links.docs[0].get("storeId"));
}

export async function setUserActive(userId: string, active: boolean, storeId: string, actor: Actor): Promise<void> {
  await fsdb().collection(C.users).doc(userId).update({ isActive: active, updatedAt: FieldValue.serverTimestamp() });
  await writeAudit({ actorUserId: actor.userId, actorRole: actor.role, action: active ? "user.enable" : "user.disable", targetType: "user", targetId: userId, storeId });
}

export async function listStoreStaff(storeId: string) {
  const links = await fsdb().collection(C.storeUsers).where("storeId", "==", storeId).get();
  if (links.empty) return [];
  const refs = links.docs.map((d) => fsdb().collection(C.users).doc(String(d.get("userId"))));
  const users = await fsdb().getAll(...refs);
  return users
    .filter((u) => u.exists)
    .map((u) => ({ id: u.id, name: String(u.get("name")), email: String(u.get("email")), isActive: u.get("isActive") === true, lastLoginAt: toDate(u.get("lastLoginAt")) }));
}

/** 運営アカウントが1つでもあるか（初期セットアップ確認用） */
export async function hasOperator(): Promise<boolean> {
  const q = await fsdb().collection(C.users).where("role", "==", "OPERATOR").limit(1).get();
  return !q.empty;
}
