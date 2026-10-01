import "server-only";
import { eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { users } from "@/lib/db/schema";
import { getDummyHash, verifyPassword } from "./password";

const MAX_FAILURES = 5;
const LOCK_MS = 15 * 60 * 1000;

export type LoginResult =
  | { ok: true; userId: string }
  | { ok: false; reason: "invalid" | "locked" };

export async function authenticate(
  emailRaw: string,
  password: string,
  role: "OPERATOR" | "STORE",
): Promise<LoginResult> {
  const email = emailRaw.trim().toLowerCase();
  const [user] = await db()
    .select()
    .from(users)
    .where(sql`lower(${users.email}) = ${email}`)
    .limit(1);

  if (!user) {
    await verifyPassword(password, await getDummyHash());
    return { ok: false, reason: "invalid" };
  }
  if (user.lockedUntil && user.lockedUntil > new Date()) return { ok: false, reason: "locked" };

  const valid = await verifyPassword(password, user.passwordHash);
  if (!valid || !user.isActive || user.role !== role) {
    if (!valid) {
      const failures = user.failedLoginCount + 1;
      await db()
        .update(users)
        .set({
          failedLoginCount: failures >= MAX_FAILURES ? 0 : failures,
          lockedUntil: failures >= MAX_FAILURES ? new Date(Date.now() + LOCK_MS) : user.lockedUntil,
        })
        .where(eq(users.id, user.id));
    }
    return { ok: false, reason: "invalid" };
  }
  await db()
    .update(users)
    .set({ failedLoginCount: 0, lockedUntil: null, lastLoginAt: new Date() })
    .where(eq(users.id, user.id));
  return { ok: true, userId: user.id };
}
