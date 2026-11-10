import { isIP } from "node:net";

/**
 * レート制限に使う送信元 IP の判定方式（Cloud Run 移行用）。
 *
 *  CLIENT_IP_SOURCE が未設定・空 … 従来どおり（Vercel 向け。request.ts の clientKey がそのまま判定する。この関数では扱わない）
 *  CLIENT_IP_SOURCE=x-forwarded-for-from-right
 *    … X-Real-IP は一切使わない（利用者が自由に付けられるため）。
 *      X-Forwarded-For を右から数えて CLIENT_IP_XFF_POSITION_FROM_RIGHT 番目（1 = 末尾）の値だけを使う。
 *      左側（先頭側）の値は利用者が自由に書けるので使わない。
 *      何番目を信頼するかは、Cloud Run の実環境（Sandbox）で確かめてから設定する（コードでは決めない）。
 *
 * 安全側の扱い：
 *  - 設定の誤り（想定外の CLIENT_IP_SOURCE・位置の未設定・範囲外・数字以外）… ClientIpConfigError を投げる
 *    （レート制限を素通りさせない。呼び出し側の API は 500/503 になり、処理を進めない）
 *  - ヘッダーの欠落・件数不足・IP の形ではない値 … "unresolved"（すべて同じ1つのキーにまとめる。
 *    不正なヘッダーで新しいレート制限のキーを無制限に作れない）
 *
 * IP の生の値は保存・記録しない（呼び出し側でハッシュ化する）。この関数はログを出さない。
 */
type Env = Record<string, string | undefined>;

export const CLIENT_IP_SOURCE_XFF_FROM_RIGHT = "x-forwarded-for-from-right" as const;
/** 信頼する位置の上限（右から数えて。実際の構成で必要になるのは 1〜2 の見込み） */
export const CLIENT_IP_MAX_POSITION = 5;
/** これより多い X-Forwarded-For の件数は異常として扱う（解析の負荷を抑える） */
export const CLIENT_IP_MAX_XFF_ENTRIES = 32;

export type ClientIpMode = { kind: "default" } | { kind: "xff-from-right"; position: number };
export type ClientIpUnresolvedReason = "xff_missing" | "xff_too_many_entries" | "xff_too_few_entries" | "xff_not_an_ip";
export type ClientIpResolution = { status: "resolved"; ip: string } | { status: "unresolved"; reason: ClientIpUnresolvedReason };

export class ClientIpConfigError extends Error {
  readonly code = "client_ip_config_invalid";
  constructor() {
    // 設定値そのものはメッセージに含めない
    super("Client IP source is misconfigured: CLIENT_IP_SOURCE / CLIENT_IP_XFF_POSITION_FROM_RIGHT");
    this.name = "ClientIpConfigError";
  }
}

/** 判定方式（設定の誤りは例外。黙って従来の方式に戻さない） */
export function clientIpMode(e: Env = process.env): ClientIpMode {
  const source = (e.CLIENT_IP_SOURCE ?? "").trim();
  if (source === "") return { kind: "default" };
  if (source !== CLIENT_IP_SOURCE_XFF_FROM_RIGHT) throw new ClientIpConfigError();
  const raw = (e.CLIENT_IP_XFF_POSITION_FROM_RIGHT ?? "").trim();
  if (!/^[1-9]$/.test(raw)) throw new ClientIpConfigError();
  const position = Number(raw);
  if (position > CLIENT_IP_MAX_POSITION) throw new ClientIpConfigError();
  return { kind: "xff-from-right", position };
}

/** X-Forwarded-For を分割（前後の空白を除く。空の要素も1件として数える＝位置をずらさない） */
export function splitForwardedFor(value: string | null): string[] | null {
  if (value === null) return null;
  if (value.trim() === "") return [];
  return value.split(",").map((s) => s.trim());
}

/** IP アドレスの正規化（IPv4・IPv6 だけを受け付ける。ポート付き・角括弧付き・その他は null） */
export function normalizeIp(v: string): string | null {
  const kind = isIP(v);
  if (kind === 4) return v;
  if (kind === 6) return v.toLowerCase();
  return null;
}

/** X-Forwarded-For の右から position 番目を使って送信元 IP を決める（X-Real-IP は見ない） */
export function resolveFromForwardedFor(headers: Headers, position: number): ClientIpResolution {
  const entries = splitForwardedFor(headers.get("x-forwarded-for"));
  if (entries === null || entries.length === 0) return { status: "unresolved", reason: "xff_missing" };
  if (entries.length > CLIENT_IP_MAX_XFF_ENTRIES) return { status: "unresolved", reason: "xff_too_many_entries" };
  if (entries.length < position) return { status: "unresolved", reason: "xff_too_few_entries" };
  const ip = normalizeIp(entries[entries.length - position]);
  if (!ip) return { status: "unresolved", reason: "xff_not_an_ip" };
  return { status: "resolved", ip };
}
