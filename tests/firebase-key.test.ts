import { describe, expect, it } from "vitest";
import { createPrivateKey, generateKeyPairSync } from "node:crypto";
import { normalizePrivateKey } from "@/lib/firestore/admin";

// サービスアカウントJSONの private_key と同じ形式（PKCS#8 PEM）の鍵をテスト用に生成（実際の鍵ではない）
const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const escaped = pem.replace(/\n/g, "\\n"); // JSON ファイル内の表記（\n）

const valid = (k: string) => {
  createPrivateKey(normalizePrivateKey(k)); // 解析できなければ例外
  return true;
};

describe("FIREBASE_PRIVATE_KEY の登録形式", () => {
  it("JSON の値をそのまま貼った形式（\\n 表記）", () => expect(valid(escaped)).toBe(true));
  it("実際の改行を含む形式", () => expect(valid(pem)).toBe(true));
  it("前後のダブルクォートごと貼ってしまった場合", () => expect(valid(`"${escaped}"`)).toBe(true));
  it("前後に空白・改行が入った場合", () => expect(valid(`  ${escaped}\n`)).toBe(true));
  it("変換結果は BEGIN/END 行を含む PEM", () => {
    const n = normalizePrivateKey(escaped);
    expect(n.startsWith("-----BEGIN PRIVATE KEY-----\n")).toBe(true);
    expect(n.trim().endsWith("-----END PRIVATE KEY-----")).toBe(true);
  });
});
