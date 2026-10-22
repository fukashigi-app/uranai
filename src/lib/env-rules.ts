/**
 * 環境変数の判定のうち、server-only に依存しないもの（npm run check:env などのスクリプトからも使う）。
 * 値そのもの（秘密鍵など）は返さない。lib/env.ts から再エクスポートしている。
 */
type RawProcessEnv = Record<string, string | undefined>;

/**
 * サイトの公開状態（SITE_STATUS）。
 *  open        … 通常どおり（未設定もこれ）
 *  coming_soon … 準備中。無料テスト・有料の決済とも受け付けない（運営・店舗の管理画面は使える）
 *  development … 開発モード。一般の方には準備中を表示し、決済は誰に対しても受け付けない。
 *                運営アカウント（OPERATOR）でログイン中の人だけが、テスト店舗（/s/test）と稼働中の登録店舗の QR で無料の占いを確認できる（lib/services/dev-mode.ts）
 * それ以外の値（打ち間違いなど）は、意図せず公開してしまわないよう準備中として扱う（unknown=true）。
 */
export type SiteStatus = "open" | "coming_soon" | "development";

export function siteStatus(e: RawProcessEnv = process.env): { status: SiteStatus; unknown: boolean } {
  const v = (e.SITE_STATUS ?? "").trim().toLowerCase();
  if (v === "" || v === "open") return { status: "open", unknown: false };
  if (v === "coming_soon") return { status: "coming_soon", unknown: false };
  if (v === "development") return { status: "development", unknown: false };
  return { status: "coming_soon", unknown: true };
}

/** 決済サービスの本番用キー（実際に課金できるキー）の環境変数名。値は返さない */
export function livePaymentKeyNames(e: RawProcessEnv = process.env): string[] {
  const live = /^(sk|pk|rk)_live_/;
  return ["PAYJP_SECRET_KEY", "PAYJP_PUBLIC_KEY", "STRIPE_SECRET_KEY", "STRIPE_PUBLISHABLE_KEY", "NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY"].filter((k) => live.test((e[k] ?? "").trim()));
}

/**
 * 開発モード（SITE_STATUS=development）なのに本番用の決済キーが設定されている。
 * 開発モードのつもりで実際の課金ができる状態にしないよう、占いの受付（無料・有料とも）を止める。
 */
export function isDevModeLiveKeyConflict(e: RawProcessEnv = process.env): boolean {
  return siteStatus(e).status === "development" && livePaymentKeyNames(e).length > 0;
}

/**
 * 無料の占い（テストモード・開発モード）の Cookie の署名に使える SESSION_SECRET か。
 * 未設定・短い・同じ文字の繰り返しなど推測しやすい値なら false（無料の占いを提供しない）。
 */
export function isSessionSecretStrong(e: RawProcessEnv = process.env): boolean {
  const v = e.SESSION_SECRET ?? "";
  if (v.length < 32) return false;
  if (new Set(v).size < 8) return false;
  return !/^(change[-_ ]?me|changeme|secret|password|your[-_]|example|dummy|test)/i.test(v);
}
