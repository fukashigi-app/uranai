import "server-only";
import { randomUUID } from "node:crypto";
import { FieldValue } from "firebase-admin/firestore";
import { DuplicateEmailError } from "@/lib/errors";
import { C, fsdb } from "./admin";
import { writeAudit } from "./audit";
import { isAlreadyExists } from "./shared";

/**
 * 最初の運営アカウント作成（Firestore 版）。
 *  system/initialSetup … 作成済みの印。一度作られたら消さない限り二度と作成できない
 *  （運営アカウントを後で削除・無効化しても、この画面は再び使えるようにはならない）
 */

const markerRef = () => fsdb().collection(C.system).doc("initialSetup");
const operatorQuery = () => fsdb().collection(C.users).where("role", "==", "OPERATOR").limit(1);

export async function isInitialSetupDone(): Promise<boolean> {
  const [marker, ops] = await Promise.all([markerRef().get(), operatorQuery().get()]);
  return marker.exists || !ops.empty;
}

/**
 * 運営アカウントが1件も無いときだけ作成する。
 * 確認と作成を1つのトランザクションで行い、印のドキュメントを create()（既にあれば失敗）するため、
 * 同時に何回送信されても作成されるのは1件だけ。
 */
export async function createInitialOperator(input: { name: string; email: string; passwordHash: string }): Promise<"created" | "done"> {
  const email = input.email.trim().toLowerCase();
  const userId = randomUUID();
  try {
    return await fsdb().runTransaction(async (tx) => {
      const [marker, ops] = await Promise.all([tx.get(markerRef()), tx.get(operatorQuery())]);
      if (marker.exists || !ops.empty) return "done" as const;
      tx.create(markerRef(), { completedAt: FieldValue.serverTimestamp(), userId });
      tx.create(fsdb().collection(C.userEmails).doc(email), { userId });
      tx.create(fsdb().collection(C.users).doc(userId), {
        email,
        name: input.name,
        passwordHash: input.passwordHash,
        role: "OPERATOR",
        isActive: true,
        failedLoginCount: 0,
        lockedUntil: null,
        lastLoginAt: null,
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      });
      await writeAudit({ actorUserId: null, actorRole: "SYSTEM", action: "admin.setup", targetType: "user", targetId: userId, after: { email } }, tx);
      return "created" as const;
    });
  } catch (e) {
    if (!isAlreadyExists(e)) throw e;
    // 同時送信で先に作成された場合は「完了済み」、そうでなければメールアドレスの重複
    if (await isInitialSetupDone()) return "done";
    throw new DuplicateEmailError();
  }
}
