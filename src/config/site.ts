/**
 * ブランド設定。サービス名・ロゴ・OGP・運営者情報はここ（または環境変数）で一括変更する。
 * クライアントからも参照されるため秘密情報は置かないこと。
 */
export const siteConfig = {
  name: process.env.NEXT_PUBLIC_SITE_NAME ?? "100円占い",
  shortName: process.env.NEXT_PUBLIC_SITE_SHORT_NAME ?? "100円占い",
  tagline:
    process.env.NEXT_PUBLIC_SITE_TAGLINE ?? "テーブルのQRから、今日の星をのぞいてみる。",
  description:
    process.env.NEXT_PUBLIC_SITE_DESCRIPTION ??
    "お店のQRコードから1回100円で楽しめる占い。生年月日・星座・血液型から今日の運勢をお届けします。",
  /** public/ 配下のロゴ。差し替える場合はファイルを置き換えるか環境変数で指定 */
  logoPath: process.env.NEXT_PUBLIC_LOGO_PATH ?? "/logo.svg",
  ogImagePath: process.env.NEXT_PUBLIC_OG_IMAGE_PATH ?? "/og.png",
  themeColor: process.env.NEXT_PUBLIC_THEME_COLOR ?? "#0b1026",
  /** 特定商取引法表記・利用規約に表示する運営者情報 */
  operator: {
    name: process.env.NEXT_PUBLIC_OPERATOR_NAME ?? "【運営事業者名を設定してください】",
    representative: process.env.NEXT_PUBLIC_OPERATOR_REPRESENTATIVE ?? "【代表者名】",
    address: process.env.NEXT_PUBLIC_OPERATOR_ADDRESS ?? "【所在地（請求があれば遅滞なく開示）】",
    phone: process.env.NEXT_PUBLIC_OPERATOR_PHONE ?? "【電話番号（請求があれば遅滞なく開示）】",
    email: process.env.NEXT_PUBLIC_OPERATOR_EMAIL ?? "support@example.com",
  },
} as const;

/** 画面表示用の価格。課金額はサーバーの config/pricing.ts のみを正とする */
export const DISPLAY_PRICE_JPY = 100;
