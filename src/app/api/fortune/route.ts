import { NextResponse } from "next/server";
import { guardPost, jsonError, jsonOk, readJson } from "@/lib/api";
import { getAccessToken } from "@/lib/cookies";
import { fortuneInputSchema, getFortuneEngine } from "@/lib/fortune/engine";
import { FortuneError, runFortune } from "@/lib/services/fortune";
import { getTestSession, isSameHostRequest, isSecureRequest, logTestFortune, saveTestSession, testGenerateContext } from "@/lib/services/test-store";
import { jstDateString } from "@/lib/time";

export async function POST(req: Request) {
  // ===== テストモード（決済なし）: 売上テーブルを使わず Cookie だけで完結 =====
  const test = await getTestSession();
  if (test) {
    if (!isSameHostRequest(req)) return jsonError(403, "forbidden_origin", "不正なリクエストです。ページを再読み込みしてください。");
    if (test.status === "done") return NextResponse.json({ ok: true, test: true }); // 二重送信は同じ結果
    const parsed = fortuneInputSchema.safeParse(await readJson(req).catch(() => null));
    if (!parsed.success) return jsonError(400, "invalid_input", parsed.error.issues[0]?.message ?? "入力内容を確認してください。");
    if (parsed.data.type !== test.type) return jsonError(400, "type_mismatch", "選んだ占いと入力内容が一致しません。最初からやり直してください。");
    try {
      const now = new Date();
      const done = { ...test, status: "done" as const, date: jstDateString(now), at: now.getTime(), input: parsed.data };
      await getFortuneEngine().generate(parsed.data, testGenerateContext(done)); // 生成できることを確認（結果は表示時に同じ条件で再生成）
      await saveTestSession(done, isSecureRequest(req));
      await logTestFortune(test.storeCode, test.type);
      return NextResponse.json({ ok: true, test: true });
    } catch (e) {
      console.error("[api/fortune:test] failed", (e as Error).message);
      return jsonError(500, "internal", "占いの結果を作れませんでした。最初からやり直してください。");
    }
  }

  // ===== 通常（有料）フロー: 決済成功で発行された占い権利が必要 =====
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
