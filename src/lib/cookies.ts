import "server-only";
import { cookies } from "next/headers";
import { secureCookiesEnabled } from "@/lib/env";

/** QRで読み込んだ店舗コード（秘密情報ではない。決済時に必ずDBで再検証する） */
export const QR_STORE_COOKIE = "qr_store";
/** 決済〜占い結果表示までの権利トークン（HttpOnly。DBにはハッシュのみ） */
export const ACCESS_COOKIE = "fx_access";
const ACCESS_MAX_AGE_SEC = 3 * 24 * 60 * 60;

export async function setAccessCookie(token: string) {
  (await cookies()).set(ACCESS_COOKIE, token, {
    httpOnly: true,
    secure: secureCookiesEnabled(),
    sameSite: "lax",
    path: "/",
    maxAge: ACCESS_MAX_AGE_SEC,
  });
}

export async function getAccessToken(): Promise<string | null> {
  const v = (await cookies()).get(ACCESS_COOKIE)?.value;
  return v && /^[A-Za-z0-9_-]{20,100}$/.test(v) ? v : null;
}

export async function getQrStoreCode(): Promise<string | null> {
  const v = (await cookies()).get(QR_STORE_COOKIE)?.value;
  return v && /^[a-z0-9]{4,32}$/.test(v) ? v : null;
}
