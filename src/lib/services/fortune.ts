import "server-only";
import { and, eq, gt } from "drizzle-orm";
import { db } from "@/lib/db";
import { fortuneResults, fortuneSessions, stores, transactions, type FortuneResultData } from "@/lib/db/schema";
import { RESULT_VIEWABLE_MS } from "@/config/pricing";
import { getFortuneEngine, type FortuneInput } from "@/lib/fortune/engine";
import { sha256Hex } from "@/lib/security/crypto";

export type FortuneSessionView =
  | { state: "none" }
  | { state: "paid"; fortuneType: FortuneInput["type"]; storeName: string; expiresAt: Date }
  | { state: "used"; fortuneType: FortuneInput["type"]; storeName: string; result: FortuneResultData | null }
  | { state: "expired" };

/** Cookie のトークンから占い権利を取得（URLにIDを含めないため改ざんで他人の結果は見られない） */
export async function getFortuneSession(token: string | null): Promise<FortuneSessionView> {
  if (!token) return { state: "none" };
  const [row] = await db()
    .select({ session: fortuneSessions, storeName: stores.name })
    .from(fortuneSessions)
    .innerJoin(stores, eq(stores.id, fortuneSessions.storeId))
    .where(eq(fortuneSessions.tokenHash, sha256Hex(token)))
    .limit(1);
  if (!row) return { state: "none" };
  const s = row.session;

  if (s.status === "USED") {
    const [result] = await db()
      .select({ result: fortuneResults.result })
      .from(fortuneResults)
      .where(and(eq(fortuneResults.fortuneSessionId, s.id), gt(fortuneResults.viewableUntil, new Date())))
      .limit(1);
    return { state: "used", fortuneType: s.fortuneType, storeName: row.storeName, result: result?.result ?? null };
  }
  if (s.status === "EXPIRED" || s.expiresAt <= new Date()) return { state: "expired" };
  return { state: "paid", fortuneType: s.fortuneType, storeName: row.storeName, expiresAt: s.expiresAt };
}

export class FortuneError extends Error {
  constructor(
    public readonly code: string,
    public readonly userMessage: string,
    public readonly httpStatus = 400,
  ) {
    super(code);
  }
}

/**
 * 占いを実行する。1つの権利につき1回だけ（PAID→USED の原子的更新）。
 * 生年月日などの入力値は seed 計算にのみ使い、DBには保存しない。
 */
export async function runFortune(token: string | null, input: FortuneInput): Promise<FortuneResultData> {
  if (!token) throw new FortuneError("no_session", "お支払い情報が確認できません。お店のQRコードからやり直してください。", 401);
  const tokenHash = sha256Hex(token);
  const engine = getFortuneEngine();

  return db().transaction(async (tx) => {
    const [session] = await tx
      .select()
      .from(fortuneSessions)
      .where(eq(fortuneSessions.tokenHash, tokenHash))
      .for("update")
      .limit(1);
    if (!session) throw new FortuneError("no_session", "お支払い情報が確認できません。お店のQRコードからやり直してください。", 401);

    if (session.status === "USED") {
      const [existing] = await tx.select().from(fortuneResults).where(eq(fortuneResults.fortuneSessionId, session.id));
      if (existing) return existing.result; // 二重送信時は同じ結果を返す
    }
    if (session.status !== "PAID" || session.expiresAt <= new Date()) {
      throw new FortuneError("expired", "占いの有効期限が切れています。", 410);
    }
    if (session.fortuneType !== input.type) {
      throw new FortuneError("type_mismatch", "お支払いいただいた占いと種類が異なります。", 400);
    }

    const now = new Date();
    const result = await engine.generate(input, now);
    await tx.update(fortuneSessions).set({ status: "USED", usedAt: now }).where(eq(fortuneSessions.id, session.id));
    await tx.insert(fortuneResults).values({
      fortuneSessionId: session.id,
      storeId: session.storeId,
      fortuneType: session.fortuneType,
      engine: engine.id,
      result,
      viewableUntil: new Date(now.getTime() + RESULT_VIEWABLE_MS),
    });
    await tx.update(transactions).set({ fortuneStatus: "COMPLETED" }).where(eq(transactions.id, session.transactionId));
    return result;
  });
}
