import "server-only";
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { env } from "@/lib/env";

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

export function sha256Hex(v: string): string {
  return createHash("sha256").update(v).digest("hex");
}

export function hmacSha256Hex(secret: string, v: string): string {
  return createHmac("sha256", secret).update(v).digest("hex");
}

/** 定数時間比較（長さが異なる場合もタイミング差を出さない） */
export function safeEqual(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb) && a.length === b.length;
}

function encryptionKey(): Buffer {
  const raw = env().DATA_ENCRYPTION_KEY;
  // 口座情報を保存する時にだけ必要（未設定でも占い機能は動く）
  if (!raw) throw new Error("DATA_ENCRYPTION_KEY is not set (required to store bank account info)");
  const key = Buffer.from(raw, "base64");
  if (key.length !== 32) throw new Error("DATA_ENCRYPTION_KEY must be base64 of 32 bytes");
  return key;
}

/** AES-256-GCM。形式: v1.<iv>.<tag>.<ciphertext>（base64url） */
export function encryptJson(value: unknown): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const ct = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ["v1", iv.toString("base64url"), tag.toString("base64url"), ct.toString("base64url")].join(".");
}

export function decryptJson<T>(payload: string): T {
  const [v, iv, tag, ct] = payload.split(".");
  if (v !== "v1" || !iv || !tag || !ct) throw new Error("invalid encrypted payload");
  const decipher = createDecipheriv("aes-256-gcm", encryptionKey(), Buffer.from(iv, "base64url"));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  const pt = Buffer.concat([decipher.update(Buffer.from(ct, "base64url")), decipher.final()]);
  return JSON.parse(pt.toString("utf8")) as T;
}

/** 推測困難な店舗コード（紛らわしい文字を除いた31文字 × 12桁 ≒ 59bit） */
const STORE_CODE_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";
export function generateStoreCode(length = 12): string {
  const bytes = randomBytes(length * 2);
  let out = "";
  for (let i = 0; i < bytes.length && out.length < length; i++) {
    // 偏りを避けるため 248(=31*8) 以上は捨てる
    if (bytes[i] < 248) out += STORE_CODE_ALPHABET[bytes[i] % 31];
  }
  if (out.length < length) return generateStoreCode(length);
  return out;
}

export function isPlausibleStoreCode(code: string): boolean {
  return /^[a-z0-9]{6,32}$/.test(code);
}
