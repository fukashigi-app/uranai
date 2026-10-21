import path from "node:path";
import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { canonical, parseAndVerify, serialize, sha256, type BackupDoc } from "@/lib/ops/backup/archive";
import { HiddenLineBuffer, isInsideDir, toGitRelativePath } from "@/lib/ops/backup/cli-safety";
import { decryptBackup, encryptBackup } from "@/lib/ops/backup/crypto";
import { FirestoreReadOnlyReader, isAllowedReadRequest, ReadOnlyViolationError } from "@/lib/ops/backup/reader";
import { assertEmulatorTarget, restoreToEmulator, rewriteReferences } from "@/lib/ops/backup/restore-emulator";

const PASS = "unit-test-passphrase-123456";
const header = { t: "header" as const, format: "uranai-firestore-backup", version: 1, createdAt: "2026-10-21T00:00:00Z", readTime: null, projectIdSha256: sha256("p"), databaseId: "(default)" };
const docs: BackupDoc[] = [
  { t: "doc", c: "users", p: "users/u1", f: { n: { integerValue: "1" }, d: { doubleValue: 1 } }, ct: "a", ut: "b" },
  { t: "doc", c: "orphans", p: "orphans/x", missing: true },
  { t: "doc", c: "orphans/x/kids", p: "orphans/x/kids/k1", f: {} },
];
function footerFor(ds: BackupDoc[]) {
  const collections: Record<string, { count: number; sha256: string }> = {};
  for (const c of new Set(ds.map((d) => d.c))) {
    const lines = ds.filter((d) => d.c === c).map((d) => canonical(d) + "\n").join("");
    collections[c] = { count: ds.filter((d) => d.c === c).length, sha256: sha256(lines) };
  }
  return { t: "footer" as const, collections, totalDocs: ds.length, missingDocs: ds.filter((d) => d.missing).length };
}

describe("バックアップの読み取り専用クライアント", () => {
  it("読み取りの API（一覧・コレクション一覧・件数）だけを許可し、書き込み系は拒否する", () => {
    const base = "/v1/projects/p/databases/(default)/documents";
    expect(isAllowedReadRequest("GET", `${base}/users?pageSize=300&readTime=2026-10-21T00%3A00%3A00Z`)).toBe(true);
    expect(isAllowedReadRequest("POST", `${base}:listCollectionIds`)).toBe(true);
    expect(isAllowedReadRequest("POST", `${base}/users/u1:listCollectionIds`)).toBe(true);
    expect(isAllowedReadRequest("POST", `${base}:runAggregationQuery`)).toBe(true);
    for (const [m, p] of [
      ["POST", `${base}:commit`],
      ["POST", `${base}:batchWrite`],
      ["POST", `${base}:beginTransaction`],
      ["PATCH", `${base}/users/u1`],
      ["DELETE", `${base}/users/u1`],
      ["POST", `${base}/users`],
      ["GET", `${base}:exportDocuments`],
      ["GET", "/v1/other"],
    ]) {
      expect(isAllowedReadRequest(m, p), `${m} ${p}`).toBe(false);
    }
  });

  it("許可されていない操作は送信前に例外になる（ネットワークに出ない）", async () => {
    let called = 0;
    const r = new FirestoreReadOnlyReader({ baseUrl: "http://x", projectId: "p", getToken: async () => "t", fetchImpl: (async () => { called++; return new Response("{}"); }) as typeof fetch });
    await expect((r as unknown as { request: (m: string, p: string) => Promise<unknown> }).request("POST", "/v1/projects/p/databases/(default)/documents:commit")).rejects.toBeInstanceOf(ReadOnlyViolationError);
    expect(called).toBe(0);
  });

  it("失敗時のメッセージに応答本文（ドキュメントのパスなど）を含めない", async () => {
    const body = JSON.stringify({ error: { status: "PERMISSION_DENIED", message: "users/secret-id is denied" } });
    const r = new FirestoreReadOnlyReader({ baseUrl: "http://x", projectId: "p", getToken: async () => "t", fetchImpl: (async () => new Response(body, { status: 403 })) as typeof fetch });
    await expect(r.listCollectionIds(null)).rejects.toThrow(/HTTP 403 PERMISSION_DENIED/);
    await expect(r.listCollectionIds(null)).rejects.not.toThrow(/secret-id/);
  });
});

describe("暗号化・完全性の確認", () => {
  it("暗号化して復号すると元に戻る。合言葉違い・1バイトの改ざん・ヘッダーの書き換えは失敗", () => {
    const plain = serialize({ header, docs, footer: footerFor(docs) });
    const enc = encryptBackup(plain, PASS);
    expect(decryptBackup(enc, PASS).equals(plain)).toBe(true);
    expect(() => decryptBackup(enc, "another-passphrase-0000")).toThrow(/合言葉が違う/);
    const t = Buffer.from(enc);
    t[t.length - 40] ^= 1;
    expect(() => decryptBackup(t, PASS)).toThrow();
    const h = Buffer.from(enc);
    h[10] ^= 1; // ヘッダー部分
    expect(() => decryptBackup(h, PASS)).toThrow();
    expect(() => encryptBackup(plain, "short")).toThrow(/16文字以上/);
    expect(enc.includes(Buffer.from("users"))).toBe(false);
  });

  it("中身の検証：件数・コレクションごとのハッシュの不一致や欠けを検出する", () => {
    expect(parseAndVerify(serialize({ header, docs, footer: footerFor(docs) })).ok).toBe(true);
    // 1件の値を書き換え
    const altered = docs.map((d) => (d.p === "users/u1" ? { ...d, f: { n: { integerValue: "2" } } } : d));
    const bad = parseAndVerify(serialize({ header, docs: altered, footer: footerFor(docs) }));
    expect(bad.ok).toBe(false);
    expect(bad.problems.join()).toMatch(/ハッシュが一致しません/);
    // 1件の欠け
    expect(parseAndVerify(serialize({ header, docs: docs.slice(1), footer: footerFor(docs) })).ok).toBe(false);
    // 末尾の確認情報が無い（途中で切れた）
    expect(parseAndVerify(gzipSync(Buffer.from([canonical(header), ...docs.map(canonical)].join("\n")))).problems.join()).toMatch(/末尾/);
  });
});

describe("Emulator 専用の復元", () => {
  const ENV = { FIRESTORE_EMULATOR_HOST: "127.0.0.1:8080" };
  it("Emulator（localhost）の demo- プロジェクト以外には復元しない", () => {
    expect(assertEmulatorTarget({ emulatorHost: "127.0.0.1:8080", projectId: "demo-restore" }, ENV)).toBe("http://127.0.0.1:8080");
    expect(() => assertEmulatorTarget({ emulatorHost: "127.0.0.1:8080", projectId: "uranai-prod" }, ENV)).toThrow(/demo-/);
    expect(() => assertEmulatorTarget({ emulatorHost: "firestore.googleapis.com", projectId: "demo-x" }, { FIRESTORE_EMULATOR_HOST: "firestore.googleapis.com" })).toThrow(/localhost/);
    expect(() => assertEmulatorTarget({ emulatorHost: "127.0.0.1:8080", projectId: "demo-x" }, {})).toThrow(/FIRESTORE_EMULATOR_HOST/);
    expect(() => assertEmulatorTarget({ emulatorHost: "127.0.0.1:9999", projectId: "demo-x" }, ENV)).toThrow(/一致しません/);
  });

  it("安全確認に失敗したら1件も送信しない", async () => {
    let called = 0;
    const f = (async () => { called++; return new Response("{}"); }) as typeof fetch;
    await expect(restoreToEmulator(docs, { emulatorHost: "127.0.0.1:8080", projectId: "uranai-prod" }, { fetchImpl: f })).rejects.toThrow();
    expect(called).toBe(0);
  });

  it("参照（referenceValue）は復元先のプロジェクトに付け替える（入れ子も）", () => {
    const v = { a: { referenceValue: "projects/prod/databases/(default)/documents/stores/s1" }, b: { arrayValue: { values: [{ referenceValue: "projects/prod/databases/(default)/documents/x/y" }] } }, c: { stringValue: "projects/prod/databases/(default)/documents/z" } };
    expect(rewriteReferences(v, "projects/demo-r/databases/(default)/documents")).toEqual({
      a: { referenceValue: "projects/demo-r/databases/(default)/documents/stores/s1" },
      b: { arrayValue: { values: [{ referenceValue: "projects/demo-r/databases/(default)/documents/x/y" }] } },
      c: { stringValue: "projects/prod/databases/(default)/documents/z" }, // 文字列は変えない
    });
  });
});

describe("Windows を含む OS の違いへの対応", () => {
  it("鍵ファイルがリポジトリの中かを、Windows の区切り文字（/ と \\）や大文字・小文字の違いがあっても正しく判定する", () => {
    const w = path.win32;
    const top = "C:/Users/me/uranai"; // Windows の git rev-parse --show-toplevel の形式
    expect(isInsideDir(top, "C:\\Users\\me\\uranai\\key.json", w)).toBe(true);
    expect(isInsideDir(top, "c:\\users\\ME\\Uranai\\sub\\key.json", w)).toBe(true);
    expect(isInsideDir(top, "C:\\Users\\me\\uranai", w)).toBe(true);
    expect(isInsideDir(top, "C:\\Users\\me\\uranai-secrets\\key.json", w)).toBe(false); // 名前が似ている別フォルダ
    expect(isInsideDir(top, "C:\\Users\\me\\key.json", w)).toBe(false);
    expect(isInsideDir(top, "D:\\uranai\\key.json", w)).toBe(false); // 別のドライブ
    expect(toGitRelativePath(top, "C:\\Users\\me\\uranai\\backups\\a.ufbk", w)).toBe("backups/a.ufbk");
    const p = path.posix;
    expect(isInsideDir("/home/me/uranai", "/home/me/uranai/key.json", p)).toBe(true);
    expect(isInsideDir("/home/me/uranai", "/home/me/uranai-secrets/key.json", p)).toBe(false);
    expect(isInsideDir("/home/me/uranai", "/home/me/uranai/../key.json", p)).toBe(false);
  });

  it("合言葉の入力：貼り付け（改行付き・1回で届く）・Enter・Backspace・Ctrl+C を正しく扱う", () => {
    const type = (...chunks: string[]) => {
      const b = new HiddenLineBuffer();
      for (const c of chunks) {
        const s = b.feed(c);
        if (s.status !== "pending") return s;
      }
      return { status: "pending" as const };
    };
    // パスワード管理アプリからの貼り付け（末尾の改行まで1回で届く）
    expect(type("correct-horse-battery\r")).toEqual({ status: "done", value: "correct-horse-battery" });
    expect(type("correct-horse-battery\r\n")).toEqual({ status: "done", value: "correct-horse-battery" });
    expect(type("abc\n")).toEqual({ status: "done", value: "abc" });
    // 1文字ずつ入力
    expect(type("a", "b", "c", "\r")).toEqual({ status: "done", value: "abc" });
    // Backspace（Mac・Linux は \x7f、Windows は \b）。空のときに押しても問題ない
    expect(type("abd\u007fc\r")).toEqual({ status: "done", value: "abc" });
    expect(type("abd", "\b", "c", "\r")).toEqual({ status: "done", value: "abc" });
    expect(type("\u007f\bab\r")).toEqual({ status: "done", value: "ab" });
    // 日本語・絵文字（サロゲートペア）も1文字として消す
    expect(type("あい🐱\u007f\r")).toEqual({ status: "done", value: "あい" });
    // 貼り付けの開始・終了の印（ブラケットペースト）や矢印キーは合言葉に含めない
    expect(type("\u001b[200~pasted-value\u001b[201~\r")).toEqual({ status: "done", value: "pasted-value" });
    expect(type("ab\u001b[D\u001b[Cc\r")).toEqual({ status: "done", value: "abc" });
    // Tab などの制御文字は無視
    expect(type("a\tb\r")).toEqual({ status: "done", value: "ab" });
    // Ctrl+C で中断
    expect(type("abc\u0003")).toEqual({ status: "interrupt" });
    // Enter より後ろの文字は使わない
    expect(type("abc\rdef\r")).toEqual({ status: "done", value: "abc" });
    // Enter が来るまでは確定しない
    expect(type("abc")).toEqual({ status: "pending" });
  });
});
