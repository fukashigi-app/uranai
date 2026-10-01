import type { Metadata, Viewport } from "next";
import { Cormorant_Garamond, Noto_Sans_JP, Shippori_Mincho } from "next/font/google";
import { siteConfig } from "@/config/site";
import "./globals.css";

const notoSans = Noto_Sans_JP({ variable: "--font-noto-sans", weight: ["400", "500", "700"], preload: false, display: "swap" });
const shippori = Shippori_Mincho({ variable: "--font-shippori", weight: ["500", "700"], preload: false, display: "swap" });
const cormorant = Cormorant_Garamond({ variable: "--font-cormorant", weight: ["500", "600"], subsets: ["latin"], display: "swap" });

export const metadata: Metadata = {
  metadataBase: new URL(process.env.APP_URL ?? "http://localhost:3000"),
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
        {children}
      </body>
    </html>
  );
}
