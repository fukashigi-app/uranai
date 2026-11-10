import "server-only";
import { env } from "@/lib/env";
import { sha256Hex } from "./crypto";
import { clientIpMode, resolveFromForwardedFor } from "./client-ip";
import { requestSourceOrigin, trustedOriginMode } from "./trusted-origin";

/**
 * 独自API(POST)用のCSRF対策。Origin（なければ Referer）が自サイトか検証する。
 * 自サイト = APP_URL、またはリクエスト先のホスト自身（Vercel の本番ドメイン/プレビューURL/独自ドメインのいずれでも動作）。
 * Next.js の Server Actions と同じく Origin と Host の一致で判定する。
 * TRUSTED_ORIGIN_SOURCE=app-url（Cloud Run 用）のときは APP_URL のオリジンだけを自サイトとする（lib/security/trusted-origin.ts）。
 */
export function isSameOrigin(req: Request): boolean {
  const trusted = trustedOriginMode();
  if (trusted.kind === "app-url") {
    // Cloud Run 用：APP_URL のオリジンだけ（Host・X-Forwarded-Host は見ない。Origin も Referer も無ければ拒否）
    return requestSourceOrigin(req) === trusted.origin;
  }
  const allowed = new Set<string>([new URL(env().APP_URL).origin]);
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host");
  const proto = req.headers.get("x-forwarded-proto") ?? new URL(req.url).protocol.replace(":", "");
  if (host) allowed.add(`${proto.split(",")[0].trim()}://${host.split(",")[0].trim()}`);
  const origin = req.headers.get("origin");
  if (origin) return allowed.has(origin);
  const referer = req.headers.get("referer");
  if (referer) {
    try {
      return allowed.has(new URL(referer).origin);
    } catch {
      return false;
    }
  }
  return false;
}

/** 送信元 IP を判定できなかったリクエストをまとめる1つのキー（Cloud Run 用の方式だけで使う。件数を増やせない） */
export const UNRESOLVED_CLIENT = "unresolved-client";

/**
 * Rate Limit 用のクライアント識別子。IPそのものは保存せずハッシュ化する（プライバシー配慮）。
 *  - CLIENT_IP_SOURCE 未設定（Vercel）… 従来どおり（Vercel が上書きする x-real-ip → X-Forwarded-For の先頭）
 *  - CLIENT_IP_SOURCE=x-forwarded-for-from-right（Cloud Run 用）… lib/security/client-ip.ts。
 *    判定できないリクエストはすべて1つのキーにまとめ、設定の誤りは例外（レート制限を素通りさせない）
 */
export function clientKey(headers: Headers): string {
  const mode = clientIpMode();
  if (mode.kind === "xff-from-right") {
    const r = resolveFromForwardedFor(headers, mode.position);
    return sha256Hex(`${env().SESSION_SECRET}:${r.status === "resolved" ? `ip:${r.ip}` : UNRESOLVED_CLIENT}`).slice(0, 32);
  }
  const ip =
    headers.get("x-real-ip") ??
    headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    "unknown";
  return sha256Hex(`${env().SESSION_SECRET}:${ip}`).slice(0, 32);
}
