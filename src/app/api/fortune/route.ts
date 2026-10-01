import { guardPost, jsonError, jsonOk, readJson } from "@/lib/api";
import { getAccessToken } from "@/lib/cookies";
import { fortuneInputSchema } from "@/lib/fortune/engine";
import { FortuneError, runFortune } from "@/lib/services/fortune";

export async function POST(req: Request) {
  const blocked = await guardPost(req, "fortune", 20, 60);
  if (blocked) return blocked;
  const parsed = fortuneInputSchema.safeParse(await readJson(req).catch(() => null));
  if (!parsed.success) {
    // 入力値そのものはログに出さない（生年月日を含むため）
    return jsonError(400, "invalid_input", parsed.error.issues[0]?.message ?? "入力内容を確認してください。");
  }
  try {
    await runFortune(await getAccessToken(), parsed.data);
    return jsonOk({ ok: true });
  } catch (e) {
    if (e instanceof FortuneError) return jsonError(e.httpStatus, e.code, e.userMessage);
    console.error("[api/fortune] failed", (e as Error).message);
    return jsonError(500, "internal", "占いの実行中にエラーが発生しました。もう一度お試しください。");
  }
}
