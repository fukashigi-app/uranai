/**
 * 【一時的・Cloud Run の Sandbox 専用】送信元 IP のヘッダーの構造の診断。
 * Cloud Run で X-Forwarded-For の何番目を信頼できるか（CLIENT_IP_XFF_POSITION_FROM_RIGHT）を決めるためだけに使い、確認後に削除する。
 *   削除するもの：このファイル・src/app/api/ops/client-ip/route.ts・tests/client-ip-diagnostics.test.ts
 *   （環境変数 CLIENT_IP_DIAGNOSTICS・CLIENT_IP_DIAGNOSTICS_TOKEN も Cloud Run から削除する）
 *
 * 有効になる条件（すべて満たすときだけ。1つでも欠ければ 404 で、存在も示さない）
 *  - CLIENT_IP_DIAGNOSTICS=on
 *  - Cloud Run 上（K_SERVICE がある）で、Vercel 上ではない（VERCEL が無い）
 *  - Sandbox の設定（VERCEL_ENV=preview・FIREBASE_PROJECT_ID がコードに固定した Preview 用のプロジェクト・
 *    PRODUCTION_FIREBASE_PROJECT_ID が本番のプロジェクト ID と一致）
 *  - Stripe の本番用の設定が無い（本番用のキー・STRIPE_LIVE_CHECKOUT=on のどちらも無い）
 *  - 診断用のトークン（CLIENT_IP_DIAGNOSTICS_TOKEN。32文字以上）が設定されている
 * 認証：診断用のトークン（Authorization: Bearer または x-client-ip-diagnostics-token のどちらか一方）と、運営アカウントのログインの両方（ルート側で確認）。
 *
 * 返すのは構造だけ：件数・位置ごとの形の種類（ipv4 / ipv6 / 文書用のアドレス / IP ではない など）・
 * 運営者が申告した自分の IP と一致するか（true / false）。IP・ヘッダーの値・Cookie・トークンは返さない。
 * 保存・ログ出力はしない。
 */
import { createHash, timingSafeEqual } from "node:crypto";
import { PRODUCTION_FIREBASE_PROJECT_ID, previewFirebaseTargetOf } from "@/lib/firestore/target-guard";
import { CLIENT_IP_MAX_XFF_ENTRIES, clientIpMode, normalizeIp, resolveFromForwardedFor, splitForwardedFor } from "@/lib/security/client-ip";

type Env = Record<string, string | undefined>;

export const CLIENT_IP_DIAGNOSTICS_TOKEN_MIN_LENGTH = 32;
/** 運営者が自分の IP を申告するヘッダー（値は比較だけに使い、返さない・保存しない） */
export const EXPECTED_IP_HEADER = "x-diagnostics-expected-ip";
/** 返す X-Forwarded-For の要素の数の上限（右から） */
const MAX_REPORTED_ENTRIES = 8;

export type ClientIpDiagnosticsAccess = "disabled" | "unauthorized" | "ok";

/** 本番の Stripe の設定が少しでもあるか（あれば診断を有効にしない） */
function hasLiveStripe(e: Env): boolean {
  const key = (e.STRIPE_SECRET_KEY ?? "").trim();
  return key.startsWith("sk_live_") || key.startsWith("rk_live_") || (e.STRIPE_LIVE_CHECKOUT ?? "").trim().toLowerCase() === "on";
}

/** 診断を有効にできる環境か（トークンの照合の前に判定する。データベースには接続しない） */
export function clientIpDiagnosticsEnabled(e: Env = process.env): boolean {
  if (e.CLIENT_IP_DIAGNOSTICS !== "on") return false;
  if (!e.K_SERVICE || e.VERCEL) return false;
  if (e.VERCEL_ENV !== "preview") return false;
  if (e.FIREBASE_PROJECT_ID === PRODUCTION_FIREBASE_PROJECT_ID || !previewFirebaseTargetOf(e.FIREBASE_PROJECT_ID)) return false;
  if (e.PRODUCTION_FIREBASE_PROJECT_ID !== PRODUCTION_FIREBASE_PROJECT_ID) return false;
  if (hasLiveStripe(e)) return false;
  return (e.CLIENT_IP_DIAGNOSTICS_TOKEN ?? "").trim().length >= CLIENT_IP_DIAGNOSTICS_TOKEN_MIN_LENGTH;
}

/** 診断用のトークンの専用ヘッダー（Cloud Run の IAM・IAP が使う Authorization と衝突させないため） */
export const DIAGNOSTICS_TOKEN_HEADER = "x-client-ip-diagnostics-token";

/**
 * 診断用のトークンの確認。トークンは次のどちらか一方だけで送る（値は CLIENT_IP_DIAGNOSTICS_TOKEN。新しい秘密は増やさない）。
 *  - Authorization: Bearer <トークン>（従来の方式）
 *  - x-client-ip-diagnostics-token: <トークン>（Google Cloud 側の認証が Authorization を使う場合）
 * 両方のヘッダーがある場合は、どちらを使うかの優先順位を作らずに拒否する（値に関係なく。Google 側の ID トークンが
 * Authorization に残る経路では、Google 側の認証を X-Serverless-Authorization で送る）。
 * 比較はハッシュしてから timingSafeEqual。トークンは返さない・記録しない。
 */
export function clientIpDiagnosticsAccess(headers: Headers, e: Env = process.env): ClientIpDiagnosticsAccess {
  if (!clientIpDiagnosticsEnabled(e)) return "disabled";
  const expected = (e.CLIENT_IP_DIAGNOSTICS_TOKEN ?? "").trim();
  const authorization = headers.get("authorization");
  const dedicated = headers.get(DIAGNOSTICS_TOKEN_HEADER);
  if (authorization !== null && dedicated !== null) return "unauthorized";
  let presented: string | null = null;
  if (dedicated !== null) {
    presented = /^\S+$/.test(dedicated) ? dedicated : null;
  } else {
    const m = /^Bearer (\S+)$/.exec(authorization ?? "");
    presented = m ? m[1] : null;
  }
  if (presented === null || !constantTimeEqual(presented, expected)) return "unauthorized";
  return "ok";
}

function constantTimeEqual(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a, "utf8").digest();
  const hb = createHash("sha256").update(b, "utf8").digest();
  return timingSafeEqual(ha, hb) && a === b;
}

export type EntryKind = "ipv4" | "ipv6" | "ip-with-port" | "empty" | "other";

function entryKind(v: string): EntryKind {
  if (v === "") return "empty";
  if (normalizeIp(v)) return normalizeIp(v)!.includes(":") ? "ipv6" : "ipv4";
  if (/^\d{1,3}(\.\d{1,3}){3}:\d{1,5}$/.test(v) || /^\[[0-9a-fA-F:.]+\]:\d{1,5}$/.test(v)) return "ip-with-port";
  return "other";
}

/** 文書用のアドレス（RFC 5737・RFC 3849）。偽装の試験で付けた値が何番目に入ったかを、値を返さずに示す */
function isDocumentationAddress(v: string): boolean {
  const ip = normalizeIp(v);
  if (!ip) return false;
  return /^(192\.0\.2|198\.51\.100|203\.0\.113)\.\d{1,3}$/.test(ip) || ip.startsWith("2001:db8:");
}

const presence = (v: string | null) => v !== null;

function sameHost(v: string | null, appUrl: string | undefined): boolean | null {
  if (v === null) return null;
  try {
    return new URL(appUrl ?? "").host.toLowerCase() === v.split(",")[0].trim().toLowerCase();
  } catch {
    return false;
  }
}

export type ClientIpDiagnostics = {
  clientIpSource: { mode: "default" | "x-forwarded-for-from-right" | "invalid"; position: number | null; resolution: string; resolvedMatchesExpected: boolean | null };
  expectedIpProvided: boolean;
  xRealIp: { present: boolean; kind: EntryKind | null; matchesExpected: boolean | null };
  xForwardedFor: {
    present: boolean;
    entryCount: number;
    entriesFromRight: { fromRight: number; kind: EntryKind; documentationAddress: boolean; matchesExpected: boolean | null }[];
  };
  forwardedHeaderPresent: boolean;
  host: { present: boolean; matchesAppUrl: boolean | null };
  xForwardedHost: { present: boolean; entryCount: number; firstMatchesAppUrl: boolean | null };
  xForwardedProto: { present: boolean; entryCount: number; first: "https" | "http" | "other" | null };
};

export function clientIpDiagnostics(headers: Headers, e: Env = process.env): ClientIpDiagnostics {
  const expected = normalizeIp((headers.get(EXPECTED_IP_HEADER) ?? "").trim());
  const matches = (v: string | null): boolean | null => (expected === null || v === null ? null : normalizeIp(v.trim()) === expected);

  let source: ClientIpDiagnostics["clientIpSource"];
  try {
    const mode = clientIpMode(e);
    if (mode.kind === "default") {
      source = { mode: "default", position: null, resolution: "default (Vercel 向けの判定)", resolvedMatchesExpected: null };
    } else {
      const r = resolveFromForwardedFor(headers, mode.position);
      source =
        r.status === "resolved"
          ? { mode: "x-forwarded-for-from-right", position: mode.position, resolution: "resolved", resolvedMatchesExpected: expected === null ? null : r.ip === expected }
          : { mode: "x-forwarded-for-from-right", position: mode.position, resolution: `unresolved (${r.reason})`, resolvedMatchesExpected: null };
    }
  } catch {
    source = { mode: "invalid", position: null, resolution: "config_error", resolvedMatchesExpected: null };
  }

  const xff = splitForwardedFor(headers.get("x-forwarded-for")) ?? [];
  const reported = xff.length > CLIENT_IP_MAX_XFF_ENTRIES ? [] : xff.slice(-MAX_REPORTED_ENTRIES).reverse();
  const xRealIp = headers.get("x-real-ip");
  const xfh = headers.get("x-forwarded-host");
  const xfp = headers.get("x-forwarded-proto");
  const proto = xfp === null ? null : xfp.split(",")[0].trim().toLowerCase();

  return {
    clientIpSource: source,
    expectedIpProvided: expected !== null,
    xRealIp: { present: presence(xRealIp), kind: xRealIp === null ? null : entryKind(xRealIp.trim()), matchesExpected: matches(xRealIp) },
    xForwardedFor: {
      present: presence(headers.get("x-forwarded-for")),
      entryCount: xff.length,
      entriesFromRight: reported.map((v, i) => ({ fromRight: i + 1, kind: entryKind(v), documentationAddress: isDocumentationAddress(v), matchesExpected: matches(v) })),
    },
    forwardedHeaderPresent: presence(headers.get("forwarded")),
    host: { present: presence(headers.get("host")), matchesAppUrl: sameHost(headers.get("host"), e.APP_URL) },
    xForwardedHost: { present: presence(xfh), entryCount: xfh === null ? 0 : xfh.split(",").length, firstMatchesAppUrl: sameHost(xfh, e.APP_URL) },
    xForwardedProto: { present: presence(xfp), entryCount: xfp === null ? 0 : xfp.split(",").length, first: proto === null ? null : proto === "https" || proto === "http" ? proto : "other" },
  };
}
