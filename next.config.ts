import type { NextConfig } from "next";
import { readOperatorInfo } from "./src/config/operator";
import { checkFirestoreTarget, FIRESTORE_TARGET_MESSAGE } from "./src/lib/firestore/target-guard";

const isDev = process.env.NODE_ENV !== "production";

/**
 * セキュリティヘッダー。payjp.js（決済フォーム iframe）と 3Dセキュア認証画面のみ外部を許可。
 */
const csp = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline' https://js.pay.jp${isDev ? " 'unsafe-eval'" : ""}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https://*.pay.jp",
  "font-src 'self' data:",
  "connect-src 'self' https://api.pay.jp https://*.pay.jp",
  // 3Dセキュアはカード会社の認証ページを表示するため https 全般を許可
  "frame-src https://js.pay.jp https://*.pay.jp https:",
  "frame-ancestors 'none'",
  "form-action 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  ...(isDev ? [] : ["upgrade-insecure-requests"]),
].join("; ");

const securityHeaders = [
  { key: "Content-Security-Policy", value: csp },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=(self)" },
  ...(isDev ? [] : [{ key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" }]),
];

// 特商法表記などの運営者情報の設定漏れ（仮の値・形式の誤り）を本番ビルドのログに出す。
// 本番を止めないよう、ビルドは失敗させない（仮の値は表示に使わず、既定の屋号・問い合わせ先を表示する）。
if (!isDev) {
  for (const issue of readOperatorInfo().issues) {
    if (issue.level === "error") console.warn(`[operator-info] ${issue.message}`);
  }
  // Preview から本番の Firebase に接続する設定になっていないか（実行時はデータベースへのアクセスを停止する）
  if (process.env.DB_PROVIDER === "firestore" || process.env.FIREBASE_PROJECT_ID) {
    const target = checkFirestoreTarget();
    if (!target.ok) console.warn(`[firestore-target] ${FIRESTORE_TARGET_MESSAGE[target.reason]}`);
  }
}

const nextConfig: NextConfig = {
  poweredByHeader: false,
  async headers() {
    return [
      { source: "/:path*", headers: securityHeaders },
      // 決済・占い・管理画面はキャッシュさせない
      { source: "/(payment|fortune|store|admin)/:path*", headers: [{ key: "Cache-Control", value: "private, no-store" }] },
    ];
  },
};

export default nextConfig;
