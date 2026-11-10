import { appUrlFromEnv } from "@/lib/env";

/**
 * 自サイトのオリジンの基準（Cloud Run 移行用）。
 *
 *  TRUSTED_ORIGIN_SOURCE が未設定・空 … 従来どおり（Vercel 向け。Vercel が設定する Host / X-Forwarded-Host も自サイトとして扱う。
 *                                       呼び出し側の従来の処理がそのまま判定する）
 *  TRUSTED_ORIGIN_SOURCE=app-url      … APP_URL のオリジンだけを自サイトとする（Cloud Run 用）。
 *                                       利用者が送った Host・X-Forwarded-Host・X-Forwarded-Proto は一切使わない。
 *
 * app-url のときの APP_URL の条件（満たさなければ TrustedOriginConfigError。黙って従来の方式に戻さない）：
 *  - 設定されている・https の絶対 URL・ユーザー名/パスワードを含まない・パス（末尾の / を除く）・クエリ・フラグメントを含まない
 *  - アプリが実際に使う公開 URL（env().APP_URL＝QR・Stripe の戻り先の基準）と同じオリジン
 */
type Env = Record<string, string | undefined>;

export const TRUSTED_ORIGIN_SOURCE_APP_URL = "app-url" as const;

export type TrustedOriginMode = { kind: "default" } | { kind: "app-url"; origin: string; host: string };

export class TrustedOriginConfigError extends Error {
  readonly code = "trusted_origin_config_invalid";
  constructor() {
    // 設定値そのものはメッセージに含めない
    super("Trusted origin is misconfigured: TRUSTED_ORIGIN_SOURCE=app-url requires APP_URL to be an https origin");
    this.name = "TrustedOriginConfigError";
  }
}

export function trustedOriginMode(e: Env = process.env): TrustedOriginMode {
  const source = (e.TRUSTED_ORIGIN_SOURCE ?? "").trim();
  if (source === "") return { kind: "default" };
  if (source !== TRUSTED_ORIGIN_SOURCE_APP_URL) throw new TrustedOriginConfigError();
  const raw = (e.APP_URL ?? "").trim();
  if (raw === "" || /\s/.test(raw)) throw new TrustedOriginConfigError();
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new TrustedOriginConfigError();
  }
  if (url.protocol !== "https:" || !url.hostname || url.username || url.password) throw new TrustedOriginConfigError();
  if (url.pathname !== "/" || url.search || url.hash || raw.includes("?") || raw.includes("#")) throw new TrustedOriginConfigError();
  // アプリが使う公開 URL（QR・Stripe の戻り先）と食い違っていれば停止する
  let effective: string;
  try {
    effective = new URL(appUrlFromEnv(e)).origin;
  } catch {
    throw new TrustedOriginConfigError();
  }
  if (effective !== url.origin) throw new TrustedOriginConfigError();
  return { kind: "app-url", origin: url.origin, host: url.host };
}

/** Origin（なければ Referer）のオリジン。無い・解析できなければ null（呼び出し側で拒否する） */
export function requestSourceOrigin(req: Request): string | null {
  const origin = req.headers.get("origin");
  if (origin !== null) return origin;
  const referer = req.headers.get("referer");
  if (referer === null) return null;
  try {
    return new URL(referer).origin;
  } catch {
    return null;
  }
}

/**
 * 共有用のトップURL（占い結果の共有ボタン）。
 *  - 従来（Vercel）：アクセス中のドメイン（X-Forwarded-Host → Host）から作る（設定に依存しない。変更前と同じ処理）
 *  - app-url（Cloud Run 用）：APP_URL のオリジンだけ（利用者が送った Host・X-Forwarded-Host を混ぜない）
 */
export function shareSiteOrigin(h: Headers, e: Env = process.env): string {
  const trusted = trustedOriginMode(e);
  if (trusted.kind === "app-url") return trusted.origin;
  const host = (h.get("x-forwarded-host") ?? h.get("host") ?? "localhost:3000").split(",")[0].trim();
  const proto = (h.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https")).split(",")[0].trim();
  return `${proto}://${host}`;
}
