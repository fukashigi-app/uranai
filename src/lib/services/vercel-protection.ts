import "server-only";
import { formatDateTimeJa } from "@/lib/time";

/**
 * Vercel Authentication（Deployment Protection）の状態の確認（表示・警告のためだけに使う。開発モードの利用条件にはしない）。
 *
 * ログイン情報を付けずに、このデプロイ自身の確認用 URL（/api/health/probe）へアクセスして、返ってきた応答で判断する。
 *  unprotected   … アプリがそのまま応答した＝誰でもサイトを開ける状態（警告）
 *  auth_required … 認証を求める応答（HTTP 401、または Vercel のログイン画面 https://vercel.com/sso-api への転送）が返った。
 *                  「保護されている」とは断定しない（表示も「認証を求める応答を確認」）
 *                  HTTP 403 は Firewall・Bot 対策・IP の制限などでも返るため、認証の要求とは扱わない（unknown）
 *  unknown       … Vercel 以外で実行中・通信の失敗・想定外の応答など。「保護されている」とは扱わない（未確認）
 * 結果はサーバーのメモリに5分だけ保存する（利用者の操作のたびに確認しない）。保護を回避する設定（Bypass）は使わない。
 */
export const PROBE_PATH = "/api/health/probe";
export const PROBE_MARKER = "uranai-protection-probe";

export type ProtectionState = "unprotected" | "auth_required" | "unknown";
export type ProtectionStatus = { state: ProtectionState; detail: string; checkedAt: number };

const TTL_MS = 5 * 60 * 1000;
const TIMEOUT_MS = 3000;
let cached: ProtectionStatus | null = null;

type Env = Record<string, string | undefined>;

/** 確認するホスト（本番は本番ドメイン、それ以外はこのデプロイの URL）。Vercel 以外では null */
export function probeHost(e: Env = process.env): string | null {
  if (!e.VERCEL_ENV) return null;
  const raw = (e.VERCEL_ENV === "production" ? e.VERCEL_PROJECT_PRODUCTION_URL : e.VERCEL_URL) ?? "";
  const host = raw.trim().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  return /^[a-z0-9.-]+(:\d+)?$/i.test(host) ? host : null;
}

/** 応答から状態を判断する（単体テスト用に分けている） */
export function classifyProbeResponse(status: number, location: string | null, body: string): { state: ProtectionState; detail: string } {
  if (status === 200 && body.includes(PROBE_MARKER)) {
    return { state: "unprotected", detail: "ログインせずにサイトを開ける状態です。開発中は Vercel の Deployment Protection（Vercel Authentication）を有効にしてください。" };
  }
  if (status === 401) {
    return { state: "auth_required", detail: "ログインしていないアクセスに認証を求める応答（HTTP 401）が返りました。保護の設定は Vercel の画面でも確認してください。" };
  }
  if (status >= 300 && status < 400 && isVercelLoginRedirect(location)) {
    return { state: "auth_required", detail: "ログインしていないアクセスが Vercel のログイン画面へ転送されました。保護の設定は Vercel の画面でも確認してください。" };
  }
  if (status === 403) {
    return { state: "unknown", detail: "確認できませんでした（HTTP 403。Firewall・Bot 対策・IP の制限などでも返るため、認証の要求とは扱いません）。Vercel の画面で確認してください。" };
  }
  return { state: "unknown", detail: `確認できませんでした（想定外の応答 HTTP ${status}）。Vercel の画面で確認してください。` };
}

/**
 * 転送先が Vercel のログイン画面（https://vercel.com/sso-api）か。任意の外部 URL は信用しない。
 * 絶対 URL で、https・ホストがちょうど vercel.com（サブドメイン・ポート・ユーザー名の付いたものは不可）・パスが /sso-api のものだけ。
 */
export function isVercelLoginRedirect(location: string | null): boolean {
  if (!location || location.length > 4096) return false;
  if (!/^https:\/\//i.test(location)) return false; // 相対 URL・別の方式は不可
  let u: URL;
  try {
    u = new URL(location);
  } catch {
    return false;
  }
  return u.protocol === "https:" && u.hostname === "vercel.com" && u.port === "" && u.username === "" && u.password === "" && (u.pathname === "/sso-api" || u.pathname.startsWith("/sso-api/"));
}

export async function getProtectionStatus(opts: { force?: boolean; fetchImpl?: typeof fetch; env?: Env } = {}): Promise<ProtectionStatus> {
  const now = Date.now();
  if (!opts.force && cached && now - cached.checkedAt < TTL_MS) return cached;
  const host = probeHost(opts.env);
  let result: { state: ProtectionState; detail: string };
  if (!host) {
    result = { state: "unknown", detail: "Vercel 以外で実行中のため確認できません。" };
  } else {
    try {
      const res = await (opts.fetchImpl ?? fetch)(`https://${host}${PROBE_PATH}`, {
        method: "GET",
        redirect: "manual",
        cache: "no-store",
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      const body = res.status === 200 ? (await res.text()).slice(0, 500) : "";
      result = classifyProbeResponse(res.status, res.headers.get("location"), body);
    } catch {
      result = { state: "unknown", detail: "確認できませんでした（通信に失敗しました）。Vercel の画面で確認してください。" };
    }
  }
  cached = { ...result, checkedAt: now };
  return cached;
}

export const PROTECTION_LABEL: Record<ProtectionState, string> = {
  unprotected: "保護されていません（警告）",
  auth_required: "認証を求める応答を確認",
  unknown: "未確認（保護されているかは分かりません）",
};

/** 表示用の文言。最後に確認した日時と、最大5分前の結果を表示している可能性を添える */
export function describeProtection(s: ProtectionStatus): string {
  return `${PROTECTION_LABEL[s.state]}（最終確認：${formatDateTimeJa(new Date(s.checkedAt))}・最大${TTL_MS / 60000}分前の結果を表示している場合があります）`;
}
