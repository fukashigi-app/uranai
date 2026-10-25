import { NextResponse } from "next/server";
import { diagnosticsAccess, firebaseTargetDiagnostics } from "@/lib/ops/firebase-target-diagnostics";

export const dynamic = "force-dynamic";

const HEADERS = { "Cache-Control": "no-store", "X-Robots-Tag": "noindex" };

/**
 * Preview 専用：Firebase の接続先の診断（true / false だけ）。運営が Preview の接続先を確かめるためのもの。
 *  - 認証は診断専用のトークン（Authorization: Bearer）。ログイン（Firestore を読み書きする）には頼らない
 *  - Firebase・Firestore には一切接続しない。本番・トークンの未設定では 404
 */
export function GET(req: Request): Response {
  const access = diagnosticsAccess(req.headers.get("authorization"));
  if (access === "disabled") return new NextResponse("Not found", { status: 404, headers: HEADERS });
  if (access === "unauthorized") return new NextResponse("Unauthorized", { status: 401, headers: HEADERS });
  return NextResponse.json({ firebaseTarget: firebaseTargetDiagnostics(), checkedAt: new Date().toISOString() }, { headers: HEADERS });
}
