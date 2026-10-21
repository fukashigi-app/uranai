import { NextResponse } from "next/server";
import { PROBE_MARKER } from "@/lib/services/vercel-protection";

export const dynamic = "force-dynamic";

/**
 * Vercel Authentication の状態の確認用（lib/services/vercel-protection.ts）。
 * ログインせずにここへ届いた＝誰でもサイトを開ける状態、と判断するための目印だけを返す（設定や秘密情報は返さない）。
 */
export function GET() {
  return NextResponse.json({ probe: PROBE_MARKER }, { headers: { "Cache-Control": "no-store", "X-Robots-Tag": "noindex" } });
}
