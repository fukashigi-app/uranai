import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth/session";
import { isSameOrigin } from "@/lib/security/request";
import { parseDiscordWebhookUrl, sendDiscordAlert } from "@/lib/ops/alert-notifier";
import { DiagnosticsRateLimiter } from "@/lib/ops/stripe-account-diagnostics";
import { buildTestAlertPayload, isTestAlertAllowed } from "@/lib/ops/test-alert";

export const dynamic = "force-dynamic";

const HEADERS = { "Cache-Control": "private, no-store, max-age=0", "X-Robots-Tag": "noindex" };
/**
 * 送信の回数の制限（サーバーのメモリだけ。Firestore には書かない）：運営者ごとに10分に1回・全体で10分に3回・同時に1件。
 * Vercel のインスタンスごとに数えるので、複数のインスタンスにまたがる連続の送信を完全には防げない
 */
const sendLimiter = new DiagnosticsRateLimiter(1, 3, 10 * 60_000);
const SEND_TIMEOUT_MS = 5000;

/**
 * Sandbox v2 専用：運営者が行う Discord の「テスト異常」の通知（src/lib/ops/test-alert.ts）。POST だけ。
 *  body { mode: "preview" } … 送信する本文を返すだけ（送信しない）
 *  body { mode: "send" }    … 1回だけ送信し、結果（sent・失敗の種類）を返す。自動では送り直さない
 * 確かめる順：Sandbox v2 の Preview か（違えば 404）→ 自サイトからの送信か（CSRF。違えば 403）→ 運営アカウントか（違えば 404）。
 * 実際の定期処理・決済監視は動かさない。Firestore に書き込まない（ログインの確認の読み込みだけ）。Stripe には接続しない。
 * 送信先の URL・トークンは応答・ログに出さない。
 */
export async function POST(req: Request): Promise<Response> {
  if (!isTestAlertAllowed()) return new NextResponse("Not found", { status: 404, headers: HEADERS });
  if (!isSameOrigin(req)) return new NextResponse("Forbidden", { status: 403, headers: HEADERS });
  const user = await getSessionUser();
  if (!user || user.role !== "OPERATOR") return new NextResponse("Not found", { status: 404, headers: HEADERS });

  let mode: unknown;
  try {
    mode = ((await req.json()) as { mode?: unknown })?.mode;
  } catch {
    mode = undefined;
  }
  if (mode !== "preview" && mode !== "send") return NextResponse.json({ error: "bad_request" }, { status: 400, headers: HEADERS });

  const raw = process.env.OPS_ALERT_WEBHOOK_URL;
  const webhook = !(raw ?? "").trim() ? "not_configured" : parseDiscordWebhookUrl(raw) ? "configured" : "invalid_url";
  const payload = buildTestAlertPayload();

  if (mode === "preview") return NextResponse.json({ mode: "preview", content: payload.content, webhook }, { headers: HEADERS });

  if (webhook !== "configured") return NextResponse.json({ mode: "send", result: "not_sent", error: webhook }, { status: 409, headers: HEADERS });
  const release = sendLimiter.acquire(user.id);
  if (!release) return NextResponse.json({ mode: "send", result: "not_sent", error: "rate_limited" }, { status: 429, headers: { ...HEADERS, "Retry-After": "600" } });
  try {
    const r = await sendDiscordAlert(raw!, payload, { timeoutMs: SEND_TIMEOUT_MS });
    console.info("[test-alert] test notification", { result: r.ok ? "sent" : "failed", error: r.ok ? null : r.error });
    return NextResponse.json(r.ok ? { mode: "send", result: "sent" } : { mode: "send", result: "failed", error: r.error }, { headers: HEADERS });
  } finally {
    release();
  }
}
