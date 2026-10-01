import { NextResponse, type NextRequest } from "next/server";

/**
 * - /s/{storeCode}: QR経由のアクセス時に店舗コードを Cookie に保存（DB照会はページ/決済APIで実施）
 * - /store/*, /admin/*: セッションCookieが無ければログインへ（楽観的チェック。本当の認可は各ページで実施）
 */
export function proxy(req: NextRequest) {
  const { pathname } = req.nextUrl;
  const secure = req.nextUrl.protocol === "https:";

  // 店舗コード（テスト店舗 "test" も含む）
  const qr = /^\/s\/([a-z0-9]{4,32})\/?$/.exec(pathname);
  if (qr) {
    const res = NextResponse.next();
    res.cookies.set("qr_store", qr[1], {
      httpOnly: true,
      secure,
      sameSite: "lax",
      path: "/",
      maxAge: 60 * 60 * 6,
    });
    return res;
  }

  const hasSession = Boolean(req.cookies.get("__Host-sid")?.value || req.cookies.get("sid")?.value);
  if (pathname.startsWith("/store") && pathname !== "/store/login" && !hasSession) {
    return NextResponse.redirect(new URL("/store/login", req.url));
  }
  if (pathname.startsWith("/admin") && pathname !== "/admin/login" && !hasSession) {
    return NextResponse.redirect(new URL("/admin/login", req.url));
  }
  return NextResponse.next();
}

export const config = {
  matcher: ["/s/:path*", "/store/:path*", "/admin/:path*"],
};
