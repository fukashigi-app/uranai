import "server-only";
import { env } from "@/lib/env";
import { sha256Hex } from "./crypto";

/**
 * 独自API(POST)用のCSRF対策。Origin（なければ Referer）が自サイトか検証する。
 * 自サイト = APP_URL、またはリクエスト先のホスト自身（Vercel の本番ドメイン/プレビューURL/独自ドメインのいずれでも動作）。
 * Next.js の Server Actions と同じく Origin と Host の一致で判定する。
 */
export function isSameOrigin(req: Request): boolean {
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

/**
 * Rate Limit 用のクライアント識別子。IPそのものは保存せずハッシュ化する（プライバシー配慮）。
 */
export function clientKey(headers: Headers): string {
  const ip =
    headers.get("x-real-ip") ??
    headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    "unknown";
  return sha256Hex(`${env().SESSION_SECRET}:${ip}`).slice(0, 32);
}
