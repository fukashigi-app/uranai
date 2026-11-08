import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import {
  BackupConsistencyError,
  canonical,
  createConsistentExport,
  decideReadTime,
  parseAndVerify,
  serialize,
  sha256,
  writeBackupFilesAtomically,
  type BackupDoc,
  type BackupHeader,
} from "@/lib/ops/backup/archive";
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

// ---------------------------------------------------------------------------
// F3: 1時点の読み取り（readTime）の強化
// ---------------------------------------------------------------------------

/** 模擬 Firestore（固定データ）。リクエストごとの readTime を、バックアップ側とは別に記録する */
function fakeFirestore(
  opts: {
    /** Date ヘッダー（null なら付けない。関数なら応答ごとに決める） */
    date?: string | null | (() => string | null);
    docs?: Record<string, Record<string, unknown> | null>;
    countAdjust?: Record<string, number>;
    /** Firestore の時計（指定すると、未来・1時間より前の readTime を 400 で拒否する） */
    serverNow?: () => number;
    /** 応答の直前に呼ぶ（時計を進める・戻すのに使う）。kind と、その種類の何回目か */
    onRequest?: (kind: string, n: number) => void;
  } = {},
) {
  const ROOT = "projects/p/databases/(default)/documents";
  // null は「親だけのドキュメント」
  const docs = opts.docs ?? { "a/1": { v: { integerValue: "1" } }, "a/2": {}, "a/2/sub/x": { s: { stringValue: "x" } }, "b/ghost": null, "b/ghost/kids/k": {} };
  const log: { kind: string; readTime: string | null }[] = [];
  const counts: Record<string, number> = {};
  const exists = (p: string) => p in docs && docs[p] !== null;
  const allPaths = () => Object.keys(docs);
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    const u = new URL(url);
    const path = decodeURIComponent(u.pathname).replace(`/v1/${ROOT}`, "");
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    const headers: Record<string, string> = { "content-type": "application/json" };
    const kindOf = path.endsWith(":listCollectionIds") ? (body.pageSize === 1 && !body.readTime ? "probe" : "listCollectionIds") : path.endsWith(":runAggregationQuery") ? "count" : "list";
    counts[kindOf] = (counts[kindOf] ?? 0) + 1;
    opts.onRequest?.(kindOf, counts[kindOf]);
    const date = typeof opts.date === "function" ? opts.date() : opts.date;
    if (date !== null) headers.date = date ?? new Date(opts.serverNow?.() ?? Date.now()).toUTCString();
    const json = (v: unknown) => new Response(JSON.stringify(v), { headers });
    const rt0: string | null = u.searchParams.get("readTime") ?? body.readTime ?? null;
    if (rt0 && opts.serverNow) {
      const t = Date.parse(rt0);
      if (t > opts.serverNow()) return new Response(JSON.stringify({ error: { status: "INVALID_ARGUMENT" } }), { status: 400, headers });
      if (t < opts.serverNow() - 60 * 60_000) return new Response(JSON.stringify({ error: { status: "FAILED_PRECONDITION" } }), { status: 400, headers });
    }
    const page = <T,>(all: T[], size: number, token: string | null | undefined) => {
      const start = Number(token ?? 0);
      const next = start + size < all.length ? String(start + size) : undefined;
      return { items: all.slice(start, start + size), next };
    };
    if (path.endsWith(":listCollectionIds")) {
      log.push({ kind: "listCollectionIds", readTime: body.readTime ?? null });
      const parent = path.replace(/:listCollectionIds$/, "").replace(/^\//, "");
      const prefix = parent ? `${parent}/` : "";
      const ids = new Set<string>();
      for (const p of allPaths()) if (p.startsWith(prefix) && exists(p)) ids.add(p.slice(prefix.length).split("/")[0]);
      const pg = page([...ids].sort(), body.pageSize ?? 300, body.pageToken);
      return json({ collectionIds: pg.items, nextPageToken: pg.next });
    }
    if (path.endsWith(":runAggregationQuery")) {
      log.push({ kind: "count", readTime: body.readTime ?? null });
      const c = body.structuredAggregationQuery.structuredQuery.from[0].collectionId as string;
      const n = allPaths().filter((p) => p.split("/").length === 2 && p.startsWith(`${c}/`) && exists(p)).length + (opts.countAdjust?.[c] ?? 0);
      return json([{ result: { aggregateFields: { n: { integerValue: String(n) } } }, readTime: body.readTime }]);
    }
    log.push({ kind: "list", readTime: u.searchParams.get("readTime") });
    const coll = path.replace(/^\//, "");
    const depth = coll.split("/").length + 1;
    const names = new Set<string>();
    for (const p of allPaths()) {
      if (!p.startsWith(`${coll}/`)) continue;
      const segs = p.split("/");
      if (segs.length === depth && exists(p)) names.add(p);
      else if (segs.length > depth && exists(p)) names.add(segs.slice(0, depth).join("/"));
    }
    const documents = [...names].sort().map((p) => (exists(p) ? { name: `${ROOT}/${p}`, fields: docs[p], createTime: "2026-11-01T00:00:00Z", updateTime: "2026-11-01T00:00:00Z" } : { name: `${ROOT}/${p}` }));
    const pg = page(documents, Number(u.searchParams.get("pageSize") ?? 300), u.searchParams.get("pageToken"));
    return json({ documents: pg.items, nextPageToken: pg.next });
  }) as typeof fetch;
  return { fetchImpl, log };
}

/**
 * 独立して進めたり戻したりできる3つの時計：
 *  server … Firestore の時計（Date ヘッダーと readTime の拒否に使う）
 *  wall   … PC の時計（Date.now の代わり）
 *  mono   … 単調時計（performance.now の代わり）
 */
function clocks(start = Date.parse("2026-11-08T03:00:10.400Z")) {
  const c = { server: start, wall: start, mono: 1_000_000 };
  return {
    c,
    /** 実際に時間が経つ（3つとも進む） */
    pass(ms: number) {
      c.server += ms;
      c.wall += ms;
      c.mono += ms;
    },
    serverNow: () => c.server,
    wall: () => c.wall,
    mono: () => c.mono,
  };
}
const ROOT_URL = "http://x";
const mkClocked = (f: ReturnType<typeof fakeFirestore>, k: ReturnType<typeof clocks>) => (readTime: string | undefined) =>
  new FirestoreReadOnlyReader({ baseUrl: ROOT_URL, projectId: "p", getToken: async () => "t", fetchImpl: f.fetchImpl, readTime, pageSize: 1, monotonic: k.mono, wallClock: k.wall });
const runClocked = (f: ReturnType<typeof fakeFirestore>, k: ReturnType<typeof clocks>) => createConsistentExport({ mode: "production", makeReader: mkClocked(f, k), projectId: "p", monotonic: k.mono, wallClock: k.wall });

describe("F3: readTime の決め方（Firestore の時刻を基準にする）", () => {
  const D = Date.parse("2026-11-08T03:00:10Z");
  const M = 5_000_000; // 単調時計の値（壁時計とは無関係な値）
  it("readTime は Date ヘッダーの時刻 − 2秒。期限は単調時計で送信から50分。PC の時計が ±4分ずれていても同じ結果", () => {
    for (const wallOffset of [0, 4 * 60_000, -4 * 60_000]) {
      const d = decideReadTime({ serverDate: D, sentAt: M, receivedAt: M + 300, wallAtReceived: D + 300 + wallOffset });
      expect(d.readTime).toBe("2026-11-08T03:00:08.000Z");
      expect(d.deadline).toBe(M + 50 * 60_000);
      expect(d.toServerTime(M + 300 + 60_000)).toBe(D + 60_000); // 単調時計で1分後 → Firestore の時刻で1分後
      // 打ち切り時点でも readTime の古さは 50分 + 3秒 + 往復 以下 < 1時間
      expect(d.toServerTime(d.deadline) + 1000 + 300 - Date.parse(d.readTime)).toBeLessThan(60 * 60_000);
    }
  });
  it("PC の時計のずれが5分を超える・Date ヘッダーが無い・往復が10秒を超える・単調時計が戻ったときは開始しない（原因がわかる文言）", () => {
    expect(() => decideReadTime({ serverDate: D, sentAt: M, receivedAt: M + 100, wallAtReceived: D - 6 * 60_000 })).toThrow(/約6分遅れて/);
    expect(() => decideReadTime({ serverDate: D, sentAt: M, receivedAt: M + 100, wallAtReceived: D + 7 * 60_000 })).toThrow(/約7分進んで/);
    expect(() => decideReadTime({ serverDate: null, sentAt: M, receivedAt: M + 100, wallAtReceived: D })).toThrow(/Date ヘッダー/);
    expect(() => decideReadTime({ serverDate: D, sentAt: M, receivedAt: M + 10_001, wallAtReceived: D })).toThrow(/応答が遅すぎる（10秒）/);
    expect(decideReadTime({ serverDate: D, sentAt: M, receivedAt: M + 10_000, wallAtReceived: D + 5_000 }).rttMs).toBe(10_000);
    expect(() => decideReadTime({ serverDate: D, sentAt: M, receivedAt: M - 1, wallAtReceived: D })).toThrow(/時計が処理の途中で戻った/);
    expect(() => decideReadTime({ serverDate: null, sentAt: M, receivedAt: M, wallAtReceived: D })).toThrow(BackupConsistencyError);
    // 往復時間は単調時計で測る：PC の時計が往復の間に大きく動いても関係しない
    expect(decideReadTime({ serverDate: D, sentAt: M, receivedAt: M + 200, wallAtReceived: D + 200 }).rttMs).toBe(200);
  });
  it("時刻確認は readTime を付けずに1回だけ読む。Date ヘッダーは HTTP の形式だけを受け付け、欠落・不正な値は null", async () => {
    const f = fakeFirestore({ date: "Sun, 08 Nov 2026 03:00:10 GMT" });
    const r = new FirestoreReadOnlyReader({ baseUrl: ROOT_URL, projectId: "p", getToken: async () => "t", fetchImpl: f.fetchImpl, readTime: "2026-11-08T03:00:00.000Z" });
    expect((await r.probeServerTime()).serverDate).toBe(D);
    expect(f.log).toEqual([{ kind: "listCollectionIds", readTime: null }]);
    for (const bad of [null, "", "garbage", "2026-11-08T03:00:10Z", "Sun, 08 Nov 2026 03:00:10 +0900", "Xxx, 99 Foo 2026 03:00:10 GMT"]) {
      const p = await new FirestoreReadOnlyReader({ baseUrl: ROOT_URL, projectId: "p", getToken: async () => "t", fetchImpl: fakeFirestore({ date: bad }).fetchImpl }).probeServerTime();
      expect(p.serverDate, String(bad)).toBeNull();
    }
  });
});

describe("F3: 1時点の全件取得（createConsistentExport）", () => {
  const mk = (f: ReturnType<typeof fakeFirestore>) => (readTime: string | undefined) => new FirestoreReadOnlyReader({ baseUrl: ROOT_URL, projectId: "p", getToken: async () => "t", fetchImpl: f.fetchImpl, readTime, pageSize: 1 });

  it("本番：開始・終了の時刻確認以外のすべてのリクエスト（全ページ・全コレクション・サブコレクション・件数）に同じ readTime が付く（模擬側の記録で確認）", async () => {
    const f = fakeFirestore();
    const r = await createConsistentExport({ mode: "production", makeReader: mk(f), projectId: "p" });
    const probe = f.log[0];
    const endProbe = f.log[f.log.length - 1];
    const rest = f.log.slice(1, -1);
    expect(probe).toEqual({ kind: "listCollectionIds", readTime: null });
    expect(endProbe).toEqual({ kind: "listCollectionIds", readTime: null });
    expect(rest.length).toBeGreaterThan(8);
    expect(new Set(rest.map((x) => x.readTime))).toEqual(new Set([r.header.readTime]));
    expect(new Set(rest.map((x) => x.kind))).toEqual(new Set(["listCollectionIds", "list", "count"]));
    expect(r.header.consistency).toBe("read_time");
    expect(r.header.countCheck).toBe("root_collections");
    const age = Date.parse(r.header.finishedAt!) - Date.parse(r.header.readTime!);
    expect(age).toBeGreaterThanOrEqual(0);
    expect(age).toBeLessThan(60 * 60_000);
    expect(r.countedRoots).toEqual({ a: 2, b: 0 }); // 親だけのドキュメント b/ghost は集計に含まれない
    expect(r.rootCounts).toEqual({ a: 2, b: 1 });
    expect(r.reader.requests).toBe(rest.length);
    expect(parseAndVerify(serialize(r))).toMatchObject({ ok: true, warnings: [] });
  });

  it("Emulator：readTime を1回も付けず、consistency: none と記録し、検証では警告が出る", async () => {
    const f = fakeFirestore();
    const r = await createConsistentExport({ mode: "emulator", makeReader: mk(f), projectId: "p" });
    expect(f.log.every((x) => x.readTime === null)).toBe(true);
    expect(r.header).toMatchObject({ consistency: "none", readTime: null, countCheck: "root_collections" });
    const v = parseAndVerify(serialize(r));
    expect(v.ok).toBe(true);
    expect(v.warnings.join()).toMatch(/時点を固定していません/);
  });

  it("件数の照合で不一致なら失敗（成功扱いにしない）", async () => {
    await expect(createConsistentExport({ mode: "production", makeReader: mk(fakeFirestore({ countAdjust: { a: 1 } })), projectId: "p" })).rejects.toThrow(/件数の照合で一致しない.*a（集計 3件・書き出し 2件）/);
  });

  it("読み取りクライアントが readTime を受け取らない（設定の誤り）なら開始しない。Emulator で readTime を付けたら止める", async () => {
    const f = fakeFirestore();
    await expect(createConsistentExport({ mode: "production", makeReader: () => mk(f)(undefined), projectId: "p" })).rejects.toThrow(/設定できませんでした/);
    await expect(createConsistentExport({ mode: "emulator", makeReader: () => mk(f)("2026-11-08T00:00:00Z"), projectId: "p" })).rejects.toThrow(/Emulator では/);
  });

  it("Date ヘッダーが無い・PC の時計のずれが大きいときは、データを1件も読まずに止まる", async () => {
    let f = fakeFirestore({ date: null });
    await expect(createConsistentExport({ mode: "production", makeReader: mk(f), projectId: "p" })).rejects.toThrow(/Date ヘッダー/);
    expect(f.log).toHaveLength(1);
    f = fakeFirestore({ date: new Date(Date.now() + 10 * 60_000).toUTCString() });
    await expect(createConsistentExport({ mode: "production", makeReader: mk(f), projectId: "p" })).rejects.toThrow(/進んで|遅れて/);
    expect(f.log).toHaveLength(1);
  });
});

describe("F3: 時計が途中で進む・戻る（壁時計・単調時計・Firestore の時計を独立に動かす）", () => {
  it("【再現】PC の時計が途中で50分戻る（実際は55分経過）：修正前は成功していた → 単調時計で55分経過を検出して中断する", async () => {
    const k = clocks();
    const f = fakeFirestore({ serverNow: k.serverNow, onRequest: (kind, n) => {
      if (kind === "list" && n === 1) {
        k.pass(55 * 60_000);
        k.c.wall -= 50 * 60_000; // PC の時計だけが50分戻る（NTP の補正など）
      }
    } });
    await expect(runClocked(f, k)).rejects.toThrow(/時間がかかりすぎた/);
  });

  it("PC の時計が途中で50分戻っても、実際の経過が短ければ成功し、finishedAt は Firestore の時刻＋単調時計の経過時間（PC の時計の影響を受けない）", async () => {
    const k = clocks();
    let probeMono = 0;
    let serverDateAtProbe = 0;
    const f = fakeFirestore({ serverNow: k.serverNow, onRequest: (kind, n) => {
      if (kind === "probe" && n === 1) {
        serverDateAtProbe = Math.floor(k.c.server / 1000) * 1000;
        k.pass(120); // 往復の分
        probeMono = k.c.mono; // 受信時の単調時計
      }
      if (kind === "list") k.pass(10_000);
      if (kind === "list" && n === 2) k.c.wall -= 50 * 60_000;
    } });
    const r = await runClocked(f, k);
    // finishedAt = 開始時の Date ヘッダー + (終了時の単調時計 − 開始時の受信時の単調時計)
    const lists = f.log.filter((x) => x.kind === "list").length;
    expect(lists).toBeGreaterThan(3);
    const elapsed = lists * 10_000; // 単調時計の経過（リスト以外では時計を進めていない）
    expect(Date.parse(r.header.finishedAt!)).toBe(serverDateAtProbe + elapsed);
    expect(probeMono).toBeGreaterThan(0);
    expect(Date.parse(r.header.finishedAt!) - Date.parse(r.header.readTime!)).toBe(elapsed + 2_000);
  });

  it("PC の時計が途中で2時間進んでも、期限・finishedAt に影響しない（成功）。createdAt は PC の時計（開始時）", async () => {
    const k = clocks();
    const wallAtStart = k.c.wall;
    const f = fakeFirestore({ serverNow: k.serverNow, onRequest: (kind, n) => {
      if (kind === "list" && n === 1) k.c.wall += 2 * 60 * 60_000;
    } });
    const r = await runClocked(f, k);
    expect(Date.parse(r.header.finishedAt!) - Date.parse(r.header.readTime!)).toBeLessThan(5_000);
    expect(Date.parse(r.header.createdAt)).toBe(wallAtStart);
  });

  it("単調時計で50分を超えたら、取得の途中・件数照合の前・終了時のどこでも中断する", async () => {
    // 正常時の単調時計の読み出し回数を数え、開始の時刻確認（最初の2回）より後のあらゆる位置で50分を超えさせる
    let total = 0;
    {
      const k = clocks();
      const f = fakeFirestore({ serverNow: k.serverNow });
      const mono = () => (++total, k.c.mono);
      await createConsistentExport({ mode: "production", makeReader: (rt) => new FirestoreReadOnlyReader({ baseUrl: ROOT_URL, projectId: "p", getToken: async () => "t", fetchImpl: f.fetchImpl, readTime: rt, pageSize: 1, monotonic: mono, wallClock: k.wall }), projectId: "p", monotonic: mono, wallClock: k.wall });
    }
    expect(total).toBeGreaterThan(6);
    for (let jumpAt = 3; jumpAt <= total; jumpAt++) {
      const k = clocks();
      let calls = 0;
      const mono = () => (++calls === jumpAt ? (k.c.mono += 50 * 60_000 + 1) : k.c.mono);
      const f = fakeFirestore({ serverNow: k.serverNow });
      const p = createConsistentExport({ mode: "production", makeReader: (rt) => new FirestoreReadOnlyReader({ baseUrl: ROOT_URL, projectId: "p", getToken: async () => "t", fetchImpl: f.fetchImpl, readTime: rt, pageSize: 1, monotonic: mono, wallClock: k.wall }), projectId: "p", monotonic: mono, wallClock: k.wall });
      await expect(p, `jumpAt=${jumpAt}`).rejects.toThrow(/時間がかかりすぎた|応答が遅すぎた|経過時間を正しく測れません/);
    }
  });

  it("スリープなどで単調時計が進まなかった（Firestore の時刻は40分経過）：終了時の時刻確認で検出して中断する", async () => {
    const k = clocks();
    const f = fakeFirestore({ serverNow: k.serverNow, onRequest: (kind, n) => {
      if (kind === "list" && n === 2) {
        k.c.server += 40 * 60_000; // Firestore の時刻と PC の時計は進むが、単調時計は進まない
        k.c.wall += 40 * 60_000;
      }
    } });
    await expect(runClocked(f, k)).rejects.toThrow(/経過時間を正しく測れませんでした.*約40分経過.*約0分/);
  });

  it("スリープが長く readTime が1時間より古くなった場合は、Firestore の拒否（400）で中断する", async () => {
    const k = clocks();
    const f = fakeFirestore({ serverNow: k.serverNow, onRequest: (kind, n) => {
      if (kind === "list" && n === 2) k.c.server += 61 * 60_000;
    } });
    await expect(runClocked(f, k)).rejects.toThrow(/HTTP 400 FAILED_PRECONDITION/);
  });

  it("Firestore が readTime を未来として拒否したら中断する（Date ヘッダーだけが進んでいる場合）", async () => {
    const k = clocks();
    const f = fakeFirestore({ serverNow: k.serverNow, date: () => new Date(k.c.server + 90_000).toUTCString() });
    k.c.wall += 90_000; // PC の時計は Date ヘッダーと合っている（ずれの診断は通る）
    await expect(runClocked(f, k)).rejects.toThrow(/HTTP 400 INVALID_ARGUMENT/);
  });

  it("開始・終了の時刻確認で往復が10秒を超えたら中断する（単調時計で測る）", async () => {
    let k = clocks();
    let f = fakeFirestore({ serverNow: k.serverNow, onRequest: (kind, n) => {
      if (kind === "probe" && n === 1) k.pass(10_001);
    } });
    await expect(runClocked(f, k)).rejects.toThrow(/応答が遅すぎる（10秒）/);
    expect(f.log).toHaveLength(1);
    const k2 = clocks();
    k = k2;
    f = fakeFirestore({ serverNow: k2.serverNow, onRequest: (kind, n) => {
      if (kind === "probe" && n === 2) k2.pass(10_001);
    } });
    await expect(runClocked(f, k2)).rejects.toThrow(/終了時の確認で Firestore の応答が遅すぎた/);
  });

  it("終了時の時刻確認で Date ヘッダーが欠落・不正なら中断する", async () => {
    for (const bad of [null, "garbage"]) {
      const k = clocks();
      let probes = 0;
      const f = fakeFirestore({ serverNow: k.serverNow, onRequest: (kind) => void (kind === "probe" && probes++), date: () => (probes >= 2 ? bad : new Date(k.c.server).toUTCString()) });
      await expect(runClocked(f, k), String(bad)).rejects.toThrow(/終了時の確認で Firestore の応答に時刻（Date ヘッダー）が無かった/);
    }
  });
});

describe("F3: 整合性情報の検証と後方互換", () => {
  const h = (extra: Partial<BackupHeader>) => serialize({ header: { ...header, ...extra } as BackupHeader, docs, footer: footerFor(docs) });
  it("旧形式（consistency なし）：readTime ありは問題なし・null は警告だけ（どちらも検証は成功）", () => {
    expect(parseAndVerify(h({ readTime: "2026-11-06T00:17:22.000Z" }))).toMatchObject({ ok: true, warnings: [] });
    const v = parseAndVerify(h({ readTime: null }));
    expect(v.ok).toBe(true);
    expect(v.warnings).toHaveLength(1);
  });
  it("新形式：記録の矛盾（readTime なしの read_time・終了が時点より前・1時間以上あと・不明な値）は失敗", () => {
    const rt = "2026-11-08T03:00:08.000Z";
    expect(parseAndVerify(h({ readTime: rt, consistency: "read_time", finishedAt: "2026-11-08T03:10:00.000Z", countCheck: "root_collections" })).ok).toBe(true);
    for (const bad of [
      { readTime: null, consistency: "read_time" as const },
      { readTime: rt, consistency: "none" as const },
      { readTime: rt, consistency: "read_time" as const, finishedAt: "2026-11-08T03:00:07.000Z" },
      { readTime: rt, consistency: "read_time" as const, finishedAt: "2026-11-08T04:00:08.000Z" },
      { readTime: rt, consistency: "read_time" as const, finishedAt: "not-a-date" },
      { readTime: "yesterday" },
      { readTime: rt, consistency: "other" as unknown as "none" },
      { readTime: rt, countCheck: "all" as unknown as "root_collections" },
    ]) {
      expect(parseAndVerify(h(bad)).ok, JSON.stringify(bad)).toBe(false);
    }
  });
});

describe("F3: 途中で失敗したらファイルを残さない", () => {
  it("読み戻しの確認に失敗したら .partial も正式な名前のファイルも残らない。成功したら正式な2ファイルだけになる", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "uranai-atomic-"));
    try {
      const file = path.join(dir, "b.ufbk");
      const manifestFile = path.join(dir, "b.manifest.json");
      expect(() =>
        writeBackupFilesAtomically({ file, manifestFile, encrypted: Buffer.from("x"), manifestText: "{}", verify: () => { throw new Error("verify failed"); } }),
      ).toThrow(/verify failed/);
      expect(readdirSync(dir)).toEqual([]);
      writeBackupFilesAtomically({ file, manifestFile, encrypted: Buffer.from("x"), manifestText: "{}", verify: (p) => expect(p.endsWith(".partial")).toBe(true) });
      expect(readdirSync(dir).sort()).toEqual(["b.manifest.json", "b.ufbk"]);
      // 同じ名前があるときは上書きしない
      expect(() => writeBackupFilesAtomically({ file, manifestFile, encrypted: Buffer.from("y"), manifestText: "{}", verify: () => {} })).toThrow(/すでにあります/);
      expect(existsSync(`${file}.partial`)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
