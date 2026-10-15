import "server-only";
import { and, eq, gt, ne } from "drizzle-orm";
import { isFirestore } from "@/lib/data-provider";
import * as fsUsers from "@/lib/firestore/users";
import { db } from "@/lib/db";
import { authSessions, users } from "@/lib/db/schema";
import type { SessionUser } from "./session";

/**
 * ログイン状態（セッション）のデータベース操作だけをまとめたもの。
 * Cookie や画面遷移（next/headers・next/navigation）に依存しないので、サービス層・テストからも使える。
 */

/** ログイン状態を保存する（生トークンは保存せず、ハッシュだけ） */
export async function saveSessionRecord(tokenHash: string, userId: string, expiresAt: Date): Promise<void> {
  if (isFirestore()) await fsUsers.createSession(tokenHash, userId, expiresAt);
  else await db().insert(authSessions).values({ id: tokenHash, userId, expiresAt });
}

/** トークンのハッシュから、有効なログイン中のユーザーを探す（期限切れ・無効化済み・削除済みは null） */
export async function findSessionUser(tokenHash: string): Promise<SessionUser | null> {
  if (isFirestore()) return fsUsers.getSessionUser(tokenHash);
  const rows = await db()
    .select({ id: users.id, email: users.email, name: users.name, role: users.role })
    .from(authSessions)
    .innerJoin(users, eq(users.id, authSessions.userId))
    .where(and(eq(authSessions.id, tokenHash), gt(authSessions.expiresAt, new Date()), eq(users.isActive, true)))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * そのユーザーのログイン状態をすべて無効にする（パスワードの変更・再発行時）。
 * keepTokenHash を渡すと、その1つ（＝本人が今使っている端末）だけ残す。
 * 消すのは指定したユーザーのものだけ（他のアカウント・他店舗には影響しない）。戻り値は無効にした件数。
 */
export async function revokeUserSessions(userId: string, keepTokenHash?: string | null): Promise<number> {
  if (isFirestore()) return fsUsers.deleteUserSessions(userId, keepTokenHash ?? null);
  const where = keepTokenHash ? and(eq(authSessions.userId, userId), ne(authSessions.id, keepTokenHash)) : eq(authSessions.userId, userId);
  const deleted = await db().delete(authSessions).where(where).returning({ id: authSessions.id });
  return deleted.length;
}

