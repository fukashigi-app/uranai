import "server-only";
import { NextResponse } from "next/server";
import { isSameOrigin, clientKey } from "@/lib/security/request";
import { rateLimit } from "@/lib/security/rate-limit";
import type { ServiceStopReason } from "@/lib/env";

export function jsonError(status: number, code: string, message: string) {
  return NextResponse.json({ error: { code, message } }, { status, headers: { "Cache-Control": "no-store" } });
}

export function jsonOk<T>(data: T, status = 200) {
  return NextResponse.json(data, { status, headers: { "Cache-Control": "no-store" } });
}

/** 利用者向けPOST APIの共通ガード（CSRF + Rate Limit） */
export async function guardPost(req: Request, bucket: string, limit: number, windowSec: number) {
  if (!isSameOrigin(req)) return jsonError(403, "forbidden_origin", "不正なリクエストです。ページを再読み込みしてください。");
  if (!(await rateLimit(`${bucket}:${clientKey(req.headers)}`, limit, windowSec))) {
    return jsonError(429, "rate_limited", "アクセスが集中しています。少し時間をおいてから再度お試しください。");
  }
  return null;
}

export async function readJson(req: Request, maxBytes = 4096): Promise<unknown> {
  const text = await req.text();
  if (text.length > maxBytes) throw new Error("payload too large");
  return JSON.parse(text);
}

/**
 * 決済の API を止めるときの応答。停止の理由が無ければ null。
 *  dangerous_config … 本番の危険な設定・開発モードでの本番用決済キー（実際の課金へ切り替えずに停止）
 *  development      … 開発モード（運営アカウントも含め、決済は受け付けない）
 *  coming_soon      … 準備中
 */
export function paymentStopResponse(stop: ServiceStopReason | null) {
  if (stop === "dangerous_config") return jsonError(503, "service_paused", "ただいま占いの受付を一時停止しています。しばらくしてからお試しください。");
  if (stop === "development") return jsonError(503, "development_mode", "ただいま準備中です（開発モードのため、お支払いは受け付けていません）。");
  if (stop === "coming_soon") return jsonError(503, "coming_soon", "ただいま準備中です。公開まで今しばらくお待ちください。");
  return null;
}
