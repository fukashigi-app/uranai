import type { NextConfig } from "next";

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
