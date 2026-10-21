/**
 * バックアップファイルの暗号化（AES-256-GCM・合言葉から scrypt で鍵を作る）。
 *
 * ファイル形式（.ufbk）:
 *   "UFBK1\n" ＋ ヘッダー長（4バイト・ビッグエンディアン）＋ ヘッダー（JSON）＋ 暗号文 ＋ 認証タグ（16バイト）
 *   ヘッダー: { v, cipher, kdf, N, r, p, salt, iv }。ヘッダー全体も認証の対象（AAD）にして、書き換えを検出する。
 * 平文（圧縮済み）は呼び出し側で渡す。復号は認証タグの確認に成功したときだけ平文を返す。
 */
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";

const MAGIC = Buffer.from("UFBK1\n");
export const MIN_PASSPHRASE_LENGTH = 16;
const KDF = { N: 2 ** 15, r: 8, p: 1 } as const;

type Header = { v: 1; cipher: "aes-256-gcm"; kdf: "scrypt"; N: number; r: number; p: number; salt: string; iv: string };

export class BackupDecryptError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BackupDecryptError";
  }
}

export function assertPassphrase(pass: string | undefined): asserts pass is string {
  if (!pass || pass.length < MIN_PASSPHRASE_LENGTH) throw new Error(`合言葉は${MIN_PASSPHRASE_LENGTH}文字以上にしてください。`);
}

function deriveKey(pass: string, h: Pick<Header, "N" | "r" | "p" | "salt">): Buffer {
  return scryptSync(pass.normalize("NFKC"), Buffer.from(h.salt, "base64"), 32, { N: h.N, r: h.r, p: h.p, maxmem: 256 * h.N * h.r });
}

export function encryptBackup(plain: Buffer, pass: string): Buffer {
  assertPassphrase(pass);
  const header: Header = { v: 1, cipher: "aes-256-gcm", kdf: "scrypt", ...KDF, salt: randomBytes(16).toString("base64"), iv: randomBytes(12).toString("base64") };
  const headerBuf = Buffer.from(JSON.stringify(header));
  const len = Buffer.alloc(4);
  len.writeUInt32BE(headerBuf.length);
  const cipher = createCipheriv("aes-256-gcm", deriveKey(pass, header), Buffer.from(header.iv, "base64"));
  cipher.setAAD(Buffer.concat([MAGIC, len, headerBuf]));
  const body = Buffer.concat([cipher.update(plain), cipher.final()]);
  return Buffer.concat([MAGIC, len, headerBuf, body, cipher.getAuthTag()]);
}

export function decryptBackup(file: Buffer, pass: string): Buffer {
  if (file.length < MAGIC.length + 4 + 16 || !file.subarray(0, MAGIC.length).equals(MAGIC)) throw new BackupDecryptError("バックアップファイルの形式ではありません。");
  const len = file.readUInt32BE(MAGIC.length);
  const hStart = MAGIC.length + 4;
  if (len <= 0 || len > 4096 || hStart + len + 16 > file.length) throw new BackupDecryptError("バックアップファイルが壊れています（ヘッダー）。");
  let header: Header;
  try {
    header = JSON.parse(file.subarray(hStart, hStart + len).toString("utf8")) as Header;
  } catch {
    throw new BackupDecryptError("バックアップファイルが壊れています（ヘッダー）。");
  }
  if (header.v !== 1 || header.cipher !== "aes-256-gcm" || header.kdf !== "scrypt" || header.N > 2 ** 20) throw new BackupDecryptError("対応していない形式のバックアップです。");
  const body = file.subarray(hStart + len, file.length - 16);
  const tag = file.subarray(file.length - 16);
  const decipher = createDecipheriv("aes-256-gcm", deriveKey(pass, header), Buffer.from(header.iv, "base64"));
  decipher.setAAD(file.subarray(0, hStart + len));
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(body), decipher.final()]);
  } catch {
    throw new BackupDecryptError("復号できません（合言葉が違うか、ファイルが改ざん・破損しています）。");
  }
}
