import { NextResponse } from "next/server";
import { clientIpDiagnostics, clientIpDiagnosticsAccess } from "@/lib/ops/client-ip-diagnostics";
import { getSessionUser } from "@/lib/auth/session";

export const dynamic = "force-dynamic";

const HEADERS = { "Cache-Control": "no-store", "X-Robots-Tag": "noindex" };

/**
 * 【一時的・Cloud Run の Sandbox 専用】送信元 IP のヘッダーの構造の診断（lib/ops/client-ip-diagnostics.ts）。確認後に削除する。
 * 判定の順序：有効か（環境変数だけ）→ 診断用のトークン（Authorization: Bearer か x-client-ip-diagnostics-token の一方だけ）→ 運営アカウントのログイン。
 * 無効・トークンの誤りではデータベースに接続しない（ログインの確認は最後）。ログは出さない。
 */
export async function GET(req: Request): Promise<Response> {
  const access = clientIpDiagnosticsAccess(req.headers);
  if (access === "disabled") return new NextResponse("Not found", { status: 404, headers: HEADERS });
  if (access === "unauthorized") return new NextResponse("Unauthorized", { status: 401, headers: HEADERS });
  let user: Awaited<ReturnType<typeof getSessionUser>> = null;
  try {
    user = await getSessionUser();
  } catch {
    user = null;
  }
  if (user?.role !== "OPERATOR") return new NextResponse("Forbidden", { status: 403, headers: HEADERS });
  return NextResponse.json({ clientIp: clientIpDiagnostics(req.headers), checkedAt: new Date().toISOString() }, { headers: HEADERS });
}
