import "server-only";
import { isFirestore } from "@/lib/data-provider";
import * as fsAudit from "@/lib/firestore/audit";
import { db, type Tx } from "@/lib/db";
import { auditLogs } from "@/lib/db/schema";

export async function writeAudit(
  entry: {
    actorUserId: string | null;
    actorRole: "OPERATOR" | "STORE" | "SYSTEM";
    action: string;
    targetType: string;
    targetId?: string | null;
    storeId?: string | null;
    before?: unknown;
    after?: unknown;
  },
  tx?: Tx,
): Promise<void> {
  if (isFirestore()) return fsAudit.writeAudit(entry);
  await (tx ?? db()).insert(auditLogs).values({
    actorUserId: entry.actorUserId,
    actorRole: entry.actorRole,
    action: entry.action,
    targetType: entry.targetType,
    targetId: entry.targetId ?? null,
    storeId: entry.storeId ?? null,
    before: entry.before ?? null,
    after: entry.after ?? null,
  });
}
