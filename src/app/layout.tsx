import type { Metadata, Viewport } from "next";
import { Cormorant_Garamond, Noto_Sans_JP, Shippori_Mincho } from "next/font/google";
import { siteConfig } from "@/config/site";
import { appUrlFromEnv, isNonProductionVercel } from "@/lib/env";
import "./globals.css";

const notoSans = Noto_Sans_JP({ variable: "--font-noto-sans", weight: ["400", "500", "700"], preload: false, display: "swap" });
const shippori = Shippori_Mincho({ variable: "--font-shippori", weight: ["500", "700"], preload: false, display: "swap" });
const cormorant = Cormorant_Garamond({ variable: "--font-cormorant", weight: ["500", "600"], subsets: ["latin"], display: "swap" });

export const metadata: Metadata = {
  metadataBase: new URL(appUrlFromEnv()),
  title: { default: `${siteConfig.name}｜今日の運勢を1回100円で`, template: `%s｜${siteConfig.name}` },
  description: siteConfig.description,
  applicationName: siteConfig.name,
  openGraph: {
    type: "website",
    siteName: siteConfig.name,
    title: siteConfig.name,
    description: siteConfig.description,
    images: [{ url: siteConfig.ogImagePath, width: 1200, height: 630 }],
    locale: "ja_JP",
  },
  twitter: { card: "summary_large_image" },
  formatDetection: { telephone: false, email: false, address: false },
};

export const viewport: Viewport = {
  themeColor: siteConfig.themeColor,
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="ja" className={`${notoSans.variable} ${shippori.variable} ${cormorant.variable} h-full antialiased`}>
      <body className="min-h-full">
        <div className="sky" aria-hidden />
        {isNonProductionVercel() ? (
          // Vercel の Preview（開発・テスト環境）だけに表示。本番・ローカルには表示しない
          <p
            role="note"
            data-env-banner
            className="relative z-50 w-full break-words bg-amber-400 px-3 py-1 text-center text-[11px] font-bold leading-snug tracking-wide text-night-900"
          >
            開発・テスト環境（本番ではありません）
          </p>
        ) : null}
        {children}
      </body>
    </html>
  );
}
