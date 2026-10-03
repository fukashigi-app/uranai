import { NextResponse } from "next/server";
import { getSessionUser, getStoreContext } from "@/lib/auth/session";
import { qrPng } from "@/lib/services/qr";
import { getStoreById } from "@/lib/services/stores";

/**
 * QR PNG ダウンロード。店舗スタッフは自店舗のみ（storeId はセッションから解決）。
 * 運営は ?storeId= で任意店舗を取得可能。
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const size = Math.min(2048, Math.max(256, Number(url.searchParams.get("size")) || 1024));
  let code: string | null = null;
  let name = "store";
  const ctx = await getStoreContext();
  if (ctx) {
    code = ctx.store.storeCode;
    name = ctx.store.name;
  } else {
    const user = await getSessionUser();
    const storeId = url.searchParams.get("storeId") ?? "";
    if (user?.role === "OPERATOR" && /^[0-9a-f-]{36}$/.test(storeId)) {
      const s = await getStoreById(storeId);
      if (s) {
        code = s.storeCode;
        name = s.name;
      }
    }
  }
  if (!code) return new NextResponse("unauthorized", { status: 401 });
  const png = await qrPng(code, size);
  return new NextResponse(new Uint8Array(png), {
    headers: {
      "Content-Type": "image/png",
      "Content-Disposition": `attachment; filename="qr-${code}.png"; filename*=UTF-8''${encodeURIComponent(`QR_${name}.png`)}`,
      "Cache-Control": "private, no-store",
    },
  });
}
