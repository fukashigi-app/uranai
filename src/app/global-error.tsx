"use client";

import "./globals.css";

/** ルートレイアウト自体のエラー時の最終手段 */
export default function GlobalError() {
  return (
    <html lang="ja">
      <body style={{ background: "#070a1a", color: "#eef0fa", fontFamily: "sans-serif" }}>
        <div style={{ maxWidth: 420, margin: "0 auto", padding: "64px 20px", textAlign: "center" }}>
          <h1 style={{ fontSize: 20, color: "#ecd9a6" }}>うまく表示できませんでした</h1>
          <p style={{ fontSize: 14, lineHeight: 1.8, color: "#a7acc8" }}>お手数ですが、最初からやり直してください。</p>
          {/* ルートレイアウトが壊れている状態なので、クライアント遷移ではなく完全な再読み込みで戻す */}
          {/* eslint-disable-next-line @next/next/no-html-link-for-pages */}
          <a href="/" style={{ display: "inline-block", marginTop: 24, padding: "12px 24px", borderRadius: 16, background: "#dfc488", color: "#070a1a", fontWeight: 700, textDecoration: "none" }}>
            最初からやり直す
          </a>
        </div>
      </body>
    </html>
  );
}
