import "server-only";
import { FieldValue, type Transaction } from "firebase-admin/firestore";
import { C, fsdb } from "./admin";

export type AuditEntry = {
  actorUserId: string | null;
  actorRole: "OPERATOR" | "STORE" | "SYSTEM";
  action: string;
  targetType: string;
  targetId?: string | null;
  storeId?: string | null;
  before?: unknown;
  after?: unknown;
};

function toDoc(e: AuditEntry) {
  return {
    actorUserId: e.actorUserId,
    actorRole: e.actorRole,
    action: e.action,
    targetType: e.targetType,
    targetId: e.targetId ?? null,
    storeId: e.storeId ?? null,
    // 監査ログの before/after は任意の JSON。undefined を含む場合に備えて JSON 経由で正規化
    before: e.before === undefined ? null : JSON.parse(JSON.stringify(e.before ?? null)),
    after: e.after === undefined ? null : JSON.parse(JSON.stringify(e.after ?? null)),
    createdAt: FieldValue.serverTimestamp(),
  };
}

export async function writeAudit(entry: AuditEntry, tx?: Transaction): Promise<void> {
  const ref = fsdb().collection(C.auditLogs).doc();
  if (tx) tx.set(ref, toDoc(entry));
  else await ref.set(toDoc(entry));
}
