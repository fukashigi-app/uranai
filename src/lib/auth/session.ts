import "server-only";
import { cache } from "react";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { and, eq, gt, asc } from "drizzle-orm";
import { db } from "@/lib/db";
import { authSessions, storeUsers, stores, users, type Store } from "@/lib/db/schema";
import { randomToken, sha256Hex } from "@/lib/security/crypto";
import { secureCookiesEnabled } from "@/lib/env";

const OPERATOR_TTL_MS = 12 * 60 * 60 * 1000;
const STORE_TTL_MS = 14 * 24 * 60 * 60 * 1000;

export function sessionCookieName(): string {
  // __Host- 接頭辞: Secure 必須・Domain指定不可・Path=/ のみ → サブドメインからの上書きを防ぐ
  return secureCookiesEnabled() ? "__Host-sid" : "sid";
}

export type SessionUser = {
  id: string;
  email: string;
  name: string;
  role: "OPERATOR" | "STORE";
};

export async function createSession(userId: string, role: SessionUser["role"]): Promise<void> {
  const token = randomToken(32);
  const ttl = role === "OPERATOR" ? OPERATOR_TTL_MS : STORE_TTL_MS;
  const expiresAt = new Date(Date.now() + ttl);
  await db().insert(authSessions).values({ id: sha256Hex(token), userId, expiresAt });
  const jar = await cookies();
  jar.set(sessionCookieName(), token, {
    httpOnly: true,
    secure: secureCookiesEnabled(),
    sameSite: "lax",
    path: "/",
    expires: expiresAt,
  });
}

export async function destroySession(): Promise<void> {
  const jar = await cookies();
  const token = jar.get(sessionCookieName())?.value;
  if (token) await db().delete(authSessions).where(eq(authSessions.id, sha256Hex(token)));
  jar.delete(sessionCookieName());
}

/** 同一リクエスト内でキャッシュ */
export const getSessionUser = cache(async (): Promise<SessionUser | null> => {
  const jar = await cookies();
  const token = jar.get(sessionCookieName())?.value;
  if (!token || token.length > 100) return null;
  const rows = await db()
    .select({ id: users.id, email: users.email, name: users.name, role: users.role })
    .from(authSessions)
    .innerJoin(users, eq(users.id, authSessions.userId))
    .where(and(eq(authSessions.id, sha256Hex(token)), gt(authSessions.expiresAt, new Date()), eq(users.isActive, true)))
    .limit(1);
  return rows[0] ?? null;
});

export async function requireOperator(): Promise<SessionUser> {
  const user = await getSessionUser();
  if (!user || user.role !== "OPERATOR") redirect("/admin/login");
  return user;
}

/**
 * 店舗スタッフ認可。storeId は必ずサーバー側で store_users から解決する（URL/リクエストの値は使わない）。
 */
export const getStoreContext = cache(async (): Promise<{ user: SessionUser; store: Store } | null> => {
  const user = await getSessionUser();
  if (!user || user.role !== "STORE") return null;
  const rows = await db()
    .select({ store: stores })
    .from(storeUsers)
    .innerJoin(stores, eq(stores.id, storeUsers.storeId))
    .where(eq(storeUsers.userId, user.id))
    .orderBy(asc(storeUsers.createdAt))
    .limit(1);
  if (!rows[0]) return null;
  return { user, store: rows[0].store };
});

export async function requireStoreUser(): Promise<{ user: SessionUser; store: Store }> {
  const ctx = await getStoreContext();
  if (!ctx) redirect("/store/login");
  return ctx;
}
