import "server-only";
import { eq, sql } from "drizzle-orm";
import { isFirestore } from "@/lib/data-provider";
import * as fsSetup from "@/lib/firestore/setup";
import { db } from "@/lib/db";
import { auditLogs, users } from "@/lib/db/schema";
import { hashPassword } from "@/lib/auth/password";
import { DuplicateEmailError } from "@/lib/errors";
import { writeAudit } from "./audit";

/**
 * 最初の運営アカウントを本番サイト上（/admin/setup）で1回だけ作成する。
 * - 運営アカウントが1件も無いときだけ作成できる
 * - 一度作成したら「作成済みの印」を残し、以後この画面からは作成できない
 * - パスワードは既存ルールで検証し、scrypt ハッシュのみ保存する（平文は保存しない）
 */

export { DuplicateEmailError };
export { checkSetupToken, setupTokenRequired } from "@/lib/auth/setup-input";

/** 初期設定が完了しているか（運営アカウントが存在する、または初回作成済み） */
export async function isInitialSetupDone(): Promise<boolean> {
  if (isFirestore()) return fsSetup.isInitialSetupDone();
  const [op] = await db().select({ id: users.id }).from(users).where(eq(users.role, "OPERATOR")).limit(1);
  if (op) return true;
  const [mark] = await db().select({ id: auditLogs.id }).from(auditLogs).where(eq(auditLogs.action, "admin.setup")).limit(1);
  return Boolean(mark);
}

export async function createInitialOperator(input: { name: string; email: string; password: string }): Promise<"created" | "done"> {
  const passwordHash = await hashPassword(input.password);
  if (isFirestore()) return fsSetup.createInitialOperator({ name: input.name, email: input.email, passwordHash });
  return db().transaction(async (tx) => {
    // 同時送信でも1件だけ作成されるよう、確認～作成の間はロックする
    await tx.execute(sql`SELECT pg_advisory_xact_lock(72400101)`);
    const [op] = await tx.select({ id: users.id }).from(users).where(eq(users.role, "OPERATOR")).limit(1);
    const [mark] = await tx.select({ id: auditLogs.id }).from(auditLogs).where(eq(auditLogs.action, "admin.setup")).limit(1);
    if (op || mark) return "done" as const;
    const inserted = await tx
      .insert(users)
      .values({ email: input.email.trim().toLowerCase(), name: input.name, passwordHash, role: "OPERATOR" })
      .onConflictDoNothing()
      .returning({ id: users.id });
    if (!inserted[0]) throw new DuplicateEmailError();
    await writeAudit({ actorUserId: null, actorRole: "SYSTEM", action: "admin.setup", targetType: "user", targetId: inserted[0].id, after: { email: input.email.trim().toLowerCase() } }, tx);
    return "created" as const;
  });
}
