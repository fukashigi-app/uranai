import "server-only";
import { NextResponse } from "next/server";
import { isSameOrigin, clientKey } from "@/lib/security/request";
import { rateLimit } from "@/lib/security/rate-limit";

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
