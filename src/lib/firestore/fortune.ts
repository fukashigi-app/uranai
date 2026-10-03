import "server-only";
import { FieldValue } from "firebase-admin/firestore";
import type { FortuneResultData } from "@/lib/db/schema";
import { RESULT_VIEWABLE_MS } from "@/config/pricing";
import { getFortuneEngine, type FortuneInput } from "@/lib/fortune/engine";
import { sha256Hex } from "@/lib/security/crypto";
import { FortuneError } from "@/lib/errors";
import type { FortuneSessionView } from "@/lib/services/fortune";
import { C, fsdb, mustDate, toDate } from "./admin";

/**
 * 有料の占い権利と結果（Firestore 版）。
 *  fortuneSessions/{transactionId} … 1決済につき1件の権利（Cookie トークンのハッシュで本人確認）
 *  fortuneResults/{sessionId}      … 結果（24時間再表示用。30日で削除）
 */

async function findSessionByToken(token: string) {
  const q = await fsdb().collection(C.fortuneSessions).where("tokenHash", "==", sha256Hex(token)).limit(1).get();
  return q.empty ? null : q.docs[0];
}

export async function getFortuneSession(token: string | null): Promise<FortuneSessionView> {
  if (!token) return { state: "none" };
  const s = await findSessionByToken(token);
  if (!s) return { state: "none" };
  const st = await fsdb().collection(C.stores).doc(String(s.get("storeId"))).get();
  const storeName = st.exists ? String(st.get("name")) : "";
  const status = s.get("status");
  const fortuneType = s.get("fortuneType");
  if (status === "USED") {
    const r = await fsdb().collection(C.fortuneResults).doc(s.id).get();
    const viewable = r.exists && (toDate(r.get("viewableUntil")) ?? new Date(0)) > new Date();
    return { state: "used", fortuneType, storeName, result: viewable ? (r.get("result") as FortuneResultData) : null };
  }
  const expiresAt = mustDate(s.get("expiresAt"));
  if (status === "EXPIRED" || expiresAt <= new Date()) return { state: "expired" };
  return { state: "paid", fortuneType, storeName, expiresAt };
}

/** 1つの権利につき1回だけ占える（PAID → USED をトランザクションで切り替え）。生年月日は保存しない */
export async function runFortune(token: string | null, input: FortuneInput): Promise<FortuneResultData> {
  if (!token) throw new FortuneError("no_session", "お支払い情報が確認できません。お店のQRコードからやり直してください。", 401);
  const found = await findSessionByToken(token);
  if (!found) throw new FortuneError("no_session", "お支払い情報が確認できません。お店のQRコードからやり直してください。", 401);
  const engine = getFortuneEngine();
  const sessionRef = found.ref;
  const resultRef = fsdb().collection(C.fortuneResults).doc(found.id);

  return fsdb().runTransaction(async (tx) => {
    const [s, existing] = await Promise.all([tx.get(sessionRef), tx.get(resultRef)]);
    if (!s.exists) throw new FortuneError("no_session", "お支払い情報が確認できません。お店のQRコードからやり直してください。", 401);
    if (s.get("status") === "USED" && existing.exists) return existing.get("result") as FortuneResultData; // 二重送信は同じ結果
    if (s.get("status") !== "PAID" || mustDate(s.get("expiresAt")) <= new Date()) throw new FortuneError("expired", "占いの有効期限が切れています。", 410);
    if (s.get("fortuneType") !== input.type) throw new FortuneError("type_mismatch", "お支払いいただいた占いと種類が異なります。", 400);

    const now = new Date();
    const result = await engine.generate(input, now);
    tx.update(sessionRef, { status: "USED", usedAt: now });
    tx.create(resultRef, {
      fortuneSessionId: s.id,
      storeId: s.get("storeId"),
      fortuneType: s.get("fortuneType"),
      engine: engine.id,
      result: JSON.parse(JSON.stringify(result)),
      viewableUntil: new Date(now.getTime() + RESULT_VIEWABLE_MS),
      createdAt: FieldValue.serverTimestamp(),
    });
    tx.update(fsdb().collection(C.transactions).doc(String(s.get("transactionId"))), { fortuneStatus: "COMPLETED", updatedAt: FieldValue.serverTimestamp() });
    return result;
  });
}
