/**
 * バックアップの「1時点の読み取り（readTime）」の E2E（本番には接続しない）。
 *
 *   npx tsx scripts/e2e-backup-consistency.ts                                   … 模擬 Firestore だけ
 *   FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 npx tsx scripts/e2e-backup-consistency.ts … Emulator の流れも確認
 *
 * 模擬 Firestore（このファイルの中の HTTP サーバー）は、ドキュメントの版を時刻つきで持ち、readTime に従ってその時点の版を返す。
 * さらに、受け取ったすべてのリクエストの readTime を「バックアップ側とは別に」記録する。
 *
 * 確認すること
 *  1. 時刻確認以外のすべてのリクエスト（全ページ・全コレクション・サブコレクション・件数の集計）に、同じ readTime が付いている（模擬側の記録）
 *  2. 取得の途中で追加・更新・削除（新しいコレクション・サブコレクションを含む）があっても、内容は readTime の1時点と完全に一致する
 *     （対照：時点を固定しない読み取りでは、途中の変更が混ざることも確認し、この試験が意味を持つことを示す）
 *  3. 件数の不一致・Date ヘッダーなし・時計のずれ・未来の時刻・有効期限切れ（サーバー側・こちらの時計）で、安全に止まる
 *  4. 新しい形式のバックアップを、オフライン検証ツール（tools/backup-verifier）と backup:verify で確認できる
 *  5. 旧形式（2026-11-06 までのヘッダー）を、引き続き確認できる
 *  6. CLI：本番（--key）での --no-read-time と、--key と --emulator の同時指定を、ネットワークに接続する前に拒否する。
 *     途中で失敗したらファイルを残さない。（Emulator があれば）Emulator の従来どおりの流れ（readTime なし・検証・復元）
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  canonical,
  createConsistentExport,
  exportAll,
  parseAndVerify,
  serialize,
  sha256,
  writeBackupFilesAtomically,
  type BackupDoc,
  type PlainManifest,
} from "../src/lib/ops/backup/archive";
import { decryptBackup, encryptBackup } from "../src/lib/ops/backup/crypto";
import { FirestoreReadOnlyReader } from "../src/lib/ops/backup/reader";
// オフライン検証ツール（読み込むだけ。変更しない）
import { verifyBackup } from "../tools/backup-verifier/verifier-core.mjs";

const PASS = "e2e-consistency-passphrase-0001";
const PROJECT = "demo-consistency";
const ROOT = `projects/${PROJECT}/databases/(default)/documents`;
let n = 0;
const ok = (m: string) => console.log(`✔ ${++n}. ${m}`);

// ---------------------------------------------------------------------------
// 版つきの模擬 Firestore（REST の読み取り API だけ）
// ---------------------------------------------------------------------------
type Fields = Record<string, unknown>;
type Version = { at: number; fields: Fields | null; createTime: number };
type Rec = { method: string; kind: "probe-or-collections" | "collections" | "list" | "count" | "other"; readTime: string | null; status: number };

class VersionedFirestore {
  private versions = new Map<string, Version[]>();
  /** サーバーの時計（こちらの時計 + offset） */
  offsetMs = 0;
  /** Date ヘッダーの出し方 */
  dateMode: { kind: "normal" } | { kind: "absent" } | { kind: "lie"; addMs: number } = { kind: "normal" };
  /** 一覧から取りこぼす（件数の集計には含める）ドキュメント */
  hideFromList = new Set<string>();
  /** 受け取ったリクエストの記録（バックアップ側の記録とは独立） */
  log: Rec[] = [];
  /** list の応答を返したあとに呼ぶ（取得の途中での変更に使う） */
  afterList: ((count: number) => void) | null = null;
  private listCount = 0;
  private server = createServer((req, res) => void this.handle(req, res));
  baseUrl = "";

  now() {
    return Date.now() + this.offsetMs;
  }
  set(path: string, fields: Fields | null, at = this.now()) {
    const vs = this.versions.get(path) ?? [];
    const prev = vs.length ? vs[vs.length - 1] : null;
    vs.push({ at, fields, createTime: prev && prev.fields ? prev.createTime : at });
    this.versions.set(path, vs);
  }
  /** 時刻 t の内容（パス → フィールド。削除済みは含めない） */
  stateAt(t: number): Map<string, Version> {
    const out = new Map<string, Version>();
    for (const [p, vs] of this.versions) {
      let cur: Version | null = null;
      for (const v of vs) if (v.at <= t) cur = v;
      if (cur && cur.fields) out.set(p, cur);
    }
    return out;
  }
  /** 時刻 t の内容を、バックアップの形（BackupDoc の並び替え済み canonical）で返す（比較用） */
  snapshotAt(t: number): string[] {
    const st = this.stateAt(t);
    const lines: string[] = [];
    const parents = new Set<string>();
    for (const p of st.keys()) {
      const segs = p.split("/");
      for (let i = 2; i < segs.length; i += 2) parents.add(segs.slice(0, i).join("/"));
    }
    for (const p of new Set([...st.keys(), ...parents])) {
      const c = p.split("/").slice(0, -1).join("/");
      const v = st.get(p);
      lines.push(canonical(v ? { t: "doc", c, p, f: v.fields, ct: iso(v.createTime), ut: iso(v.at) } : { t: "doc", c, p, missing: true }));
    }
    return lines.sort();
  }
  async start() {
    await new Promise<void>((r) => this.server.listen(0, "127.0.0.1", () => r()));
    this.baseUrl = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }
  stop() {
    return new Promise<void>((r) => this.server.close(() => r()));
  }

  private async handle(req: IncomingMessage, res: ServerResponse) {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
    const u = new URL(req.url ?? "/", "http://x");
    const path = decodeURIComponent(u.pathname);
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (this.dateMode.kind === "normal") headers.date = new Date(this.now()).toUTCString();
    if (this.dateMode.kind === "lie") headers.date = new Date(this.now() + this.dateMode.addMs).toUTCString();
    const send = (status: number, v: unknown, rec: Omit<Rec, "status">) => {
      this.log.push({ ...rec, status });
      res.sendDate = false; // Node が自動で付ける Date ヘッダーを止め、dateMode のとおりにする
      res.writeHead(status, headers);
      res.end(JSON.stringify(v));
    };
    const rt: string | null = req.method === "GET" ? u.searchParams.get("readTime") : (body.readTime ?? null);
    const kind: Rec["kind"] = path.endsWith(":listCollectionIds") ? "collections" : path.endsWith(":runAggregationQuery") ? "count" : req.method === "GET" ? "list" : "other";
    const rec = { method: req.method ?? "", kind, readTime: rt };
    if (!path.startsWith(`/v1/${ROOT}`) || kind === "other") return send(400, { error: { status: "INVALID_ARGUMENT" } }, rec);
    // readTime の扱い（公式：1時間以内のマイクロ秒精度の時刻。未来・1時間より前は受け付けない）
    let t = this.now();
    if (rt !== null) {
      const r = Date.parse(rt);
      if (!Number.isFinite(r) || r > this.now()) return send(400, { error: { status: "INVALID_ARGUMENT", message: "readTime is in the future" } }, rec);
      if (r < this.now() - 60 * 60_000) return send(400, { error: { status: "FAILED_PRECONDITION", message: "readTime too old" } }, rec);
      t = r;
    }
    const st = this.stateAt(t);
    const rel = path.slice(`/v1/${ROOT}`.length).replace(/^\//, "");
    if (kind === "collections") {
      const parent = rel.replace(/:listCollectionIds$/, "");
      const prefix = parent ? `${parent}/` : "";
      const ids = new Set<string>();
      for (const p of st.keys()) if (p.startsWith(prefix)) ids.add(p.slice(prefix.length).split("/")[0]);
      const all = [...ids].sort();
      const start = Number(body.pageToken ?? 0);
      const size = Number(body.pageSize ?? 300);
      return send(200, { collectionIds: all.slice(start, start + size), ...(start + size < all.length ? { nextPageToken: String(start + size) } : {}) }, rec);
    }
    if (kind === "count") {
      const c = body.structuredAggregationQuery.structuredQuery.from[0].collectionId as string;
      const cnt = [...st.keys()].filter((p) => p.split("/").length === 2 && p.startsWith(`${c}/`)).length;
      return send(200, [{ result: { aggregateFields: { n: { integerValue: String(cnt) } } }, readTime: rt ?? iso(t) }], rec);
    }
    // list（showMissing=true：子のある「親だけのドキュメント」も name だけで返す）
    const depth = rel.split("/").length + 1;
    const names = new Set<string>();
    for (const p of st.keys()) {
      if (!p.startsWith(`${rel}/`)) continue;
      const segs = p.split("/");
      if (segs.length >= depth) names.add(segs.slice(0, depth).join("/"));
    }
    const all = [...names].filter((p) => !this.hideFromList.has(p)).sort();
    const start = Number(u.searchParams.get("pageToken") ?? 0);
    const size = Number(u.searchParams.get("pageSize") ?? 300);
    const documents = all.slice(start, start + size).map((p) => {
      const v = st.get(p);
      return v ? { name: `${ROOT}/${p}`, fields: v.fields, createTime: iso(v.createTime), updateTime: iso(v.at) } : { name: `${ROOT}/${p}` };
    });
    send(200, { documents, ...(start + size < all.length ? { nextPageToken: String(start + size) } : {}) }, rec);
    this.listCount += 1;
    this.afterList?.(this.listCount);
  }
}

const iso = (t: number) => new Date(t).toISOString();
const str = (s: string) => ({ v: { stringValue: s } });

/** 元データ：複数ページ・3階層のサブコレクション・親だけのドキュメント */
function seed(fs: VersionedFirestore) {
  const at = fs.now() - 10 * 60_000;
  for (let i = 0; i < 25; i++) fs.set(`bulk/d${String(i).padStart(2, "0")}`, str(`b${i}`), at);
  fs.set("stores/s1", str("store"), at);
  fs.set("stores/s1/staff/st1", str("staff"), at);
  fs.set("stores/s1/staff/st1/notes/n1", str("deep"), at);
  fs.set("stores/s1/staff/st2", str("staff2"), at);
  fs.set("orphans/ghost/kids/k1", str("kid"), at); // orphans/ghost は親だけのドキュメント
  fs.set("users/u1", str("user1"), at);
  fs.set("users/u2", str("user2"), at);
}

type Clocks = { monotonic?: () => number; wallClock?: () => number };
const makeReaderFor = (fs: VersionedFirestore, k: Clocks = {}) => (readTime: string | undefined) =>
  new FirestoreReadOnlyReader({ baseUrl: fs.baseUrl, projectId: PROJECT, getToken: async () => "test", readTime, pageSize: 4, ...k });
/** 単調時計と PC の時計を、実際の時計とは独立にずらせるようにする */
function shiftableClocks() {
  const off = { mono: 0, wall: 0 };
  return { off, monotonic: () => performance.now() + off.mono, wallClock: () => Date.now() + off.wall };
}

async function withServer<T>(fn: (fs: VersionedFirestore) => Promise<T>): Promise<T> {
  const fs = new VersionedFirestore();
  seed(fs);
  await fs.start();
  try {
    return await fn(fs);
  } finally {
    await fs.stop();
  }
}

/** 取得の途中（list の応答の何回目か）で行う変更 */
function mutateDuringExport(fs: VersionedFirestore) {
  fs.afterList = (c) => {
    if (c === 1) {
      fs.set("bulk/a-first", str("added-before-cursor")); // すでに読んだ位置より前に追加
      fs.set("bulk/d20", str("updated")); // まだ読んでいないページの更新
      fs.set("bulk/d21", null); // まだ読んでいないページの削除
      fs.set("bulk/zz-last", str("added-after-cursor"));
    }
    if (c === 3) {
      fs.set("aaa-new/x", str("new collection")); // 新しいトップレベルのコレクション
      fs.set("users/u1/sessions/s1", str("new subcollection")); // 新しいサブコレクション
      fs.set("stores/s1/staff/st1/notes/n1", null); // サブコレクションの削除
      fs.set("orphans/ghost", str("now real")); // 親だけのドキュメントが実体を持つ
      fs.set("users/u2", str("user2-updated"));
      fs.set("users/u3", str("user3-added"));
    }
  };
}

async function backupLines(r: { docs: BackupDoc[] }) {
  return r.docs.map(canonical).sort();
}

function cli(args: string[], env: Record<string, string | undefined> = {}): { code: number; out: string } {
  try {
    const out = execFileSync("npx", ["tsx", "scripts/firestore-backup.ts", ...args], { env: { ...process.env, BACKUP_PASSPHRASE: PASS, ...env }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return { code: 0, out };
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string };
    return { code: err.status ?? 1, out: `${err.stdout ?? ""}${err.stderr ?? ""}` };
  }
}

async function writeBackup(dir: string, name: string, plain: Buffer, header: { createdAt: string; readTime: string | null; projectIdSha256: string; format: string; version: number; consistency?: "read_time" | "none"; finishedAt?: string; countCheck?: "root_collections" }, totals: { totalDocs: number; rootCollections: Record<string, number> }, legacy = false) {
  const encrypted = encryptBackup(plain, PASS);
  const file = join(dir, `${name}.ufbk`);
  const manifestFile = join(dir, `${name}.manifest.json`);
  const manifest: PlainManifest = {
    format: header.format,
    version: header.version,
    createdAt: header.createdAt,
    readTime: header.readTime,
    projectIdSha256: header.projectIdSha256,
    totalDocs: totals.totalDocs,
    rootCollections: totals.rootCollections,
    encryptedFile: `${name}.ufbk`,
    encryptedSha256: sha256(encrypted),
    encryptedBytes: encrypted.length,
    ...(legacy ? {} : { consistency: header.consistency, finishedAt: header.finishedAt, countCheck: header.countCheck }),
  };
  const manifestText = JSON.stringify(manifest, null, 2) + "\n";
  writeBackupFilesAtomically({ file, manifestFile, encrypted, manifestText, verify: (p) => assert.equal(parseAndVerify(decryptBackup(readFileSync(p), PASS)).ok, true) });
  return { file, manifestFile, manifestText, encrypted };
}

async function main() {
  const out = mkdtempSync(join(tmpdir(), "uranai-bkp-consistency-"));
  try {
    // ---- 1・2. 途中の変更があっても1時点。すべてのリクエストに同じ readTime ----
    const good = await withServer(async (fs) => {
      mutateDuringExport(fs);
      const r = await createConsistentExport({ mode: "production", makeReader: makeReaderFor(fs), projectId: PROJECT });
      const rt = r.header.readTime!;
      const probe = fs.log[0];
      const endProbe = fs.log[fs.log.length - 1];
      const rest = fs.log.slice(1, -1);
      assert.equal(probe.kind, "collections");
      assert.equal(probe.readTime, null, "時刻確認に readTime が付いている");
      assert.equal(endProbe.kind, "collections");
      assert.equal(endProbe.readTime, null, "終了時の時刻確認に readTime が付いている");
      assert.ok(rest.length >= 20, `リクエストが少なすぎる: ${rest.length}`);
      assert.deepEqual([...new Set(rest.map((x) => x.readTime))], [rt], "readTime が付いていない、または違う readTime のリクエストがある");
      assert.deepEqual([...new Set(rest.map((x) => x.kind))].sort(), ["collections", "count", "list"]);
      assert.equal(rest.filter((x) => x.kind === "list").length > 8, true, "複数ページ・サブコレクションを読んでいない");
      assert.ok(rest.every((x) => x.status === 200));
      assert.equal(r.reader.requests, rest.length, "バックアップ側の数え方と模擬側の記録の数が違う（時刻確認は別のクライアント）");
      ok(`開始・終了の時刻確認（readTime なし・各1回）以外の ${rest.length}件すべて（一覧・コレクション一覧・件数・全ページ・サブコレクション）に同じ readTime（模擬 Firestore 側の記録で確認）`);

      const got = await backupLines(r);
      assert.deepEqual(got, fs.snapshotAt(Date.parse(rt)), "readTime の時点の内容と一致しない");
      assert.notDeepEqual(got, fs.snapshotAt(fs.now()), "途中の変更が反映されていない＝試験になっていない");
      for (const s of ["added-before-cursor", "added-after-cursor", "updated", "new collection", "new subcollection", "now real", "user2-updated", "user3-added"]) assert.equal(got.join("").includes(s), false, `途中の変更（${s}）が混ざった`);
      assert.ok(got.join("").includes('"p":"bulk/d21"') && got.join("").includes('"p":"stores/s1/staff/st1/notes/n1"'), "途中で削除されたドキュメントが readTime の内容から消えた");
      assert.ok(got.join("").includes('"missing":true,"p":"orphans/ghost"'), "親だけのドキュメントの状態が readTime の時点と違う");
      assert.deepEqual(r.countedRoots, { bulk: 25, orphans: 0, stores: 1, users: 2 });
      assert.equal(r.header.consistency, "read_time");
      assert.equal(r.header.countCheck, "root_collections");
      const age = Date.parse(r.header.finishedAt!) - Date.parse(rt);
      assert.ok(age >= 0 && age < 60 * 60_000);
      ok("取得の途中に追加・更新・削除（新しいコレクション・サブコレクション・親だけのドキュメントの変化）があっても、内容は readTime の1時点と完全に一致。件数の照合も一致");
      return r;
    });

    // 対照：時点を固定しない読み取り（Emulator と同じ方式）では、同じ変更が混ざる
    await withServer(async (fs) => {
      const before = fs.snapshotAt(fs.now());
      mutateDuringExport(fs);
      const r = await exportAll(makeReaderFor(fs)(undefined), { projectId: PROJECT, databaseId: "(default)", readTime: null });
      const got = await backupLines(r);
      assert.notDeepEqual(got, before);
      assert.ok(got.join("").includes("added-after-cursor") || got.join("").includes("updated"));
      assert.ok(fs.log.every((x) => x.readTime === null));
    });
    ok("対照：時点を固定しない読み取りでは、同じ途中の変更が混ざる（＝この試験は readTime の効果を確かめている）");

    // ---- 3. 安全な停止 ----
    await withServer(async (fs) => {
      fs.hideFromList.add("users/u2");
      await assert.rejects(createConsistentExport({ mode: "production", makeReader: makeReaderFor(fs), projectId: PROJECT }), /件数の照合で一致しない.*users（集計 2件・書き出し 1件）/);
    });
    ok("一覧からの取りこぼし（件数の不一致）を検出して失敗する");

    await withServer(async (fs) => {
      fs.dateMode = { kind: "absent" };
      await assert.rejects(createConsistentExport({ mode: "production", makeReader: makeReaderFor(fs), projectId: PROJECT }), /Date ヘッダー/);
      assert.equal(fs.log.length, 1);
      fs.log = [];
      fs.dateMode = { kind: "lie", addMs: 10 * 60_000 };
      await assert.rejects(createConsistentExport({ mode: "production", makeReader: makeReaderFor(fs), projectId: PROJECT }), /約10分遅れて/);
      assert.equal(fs.log.length, 1);
      fs.log = [];
      fs.offsetMs = -8 * 60_000; // サーバーの時計が遅れている（＝こちらが進んでいる）
      fs.dateMode = { kind: "normal" };
      await assert.rejects(createConsistentExport({ mode: "production", makeReader: makeReaderFor(fs), projectId: PROJECT }), /約8分進んで/);
      assert.equal(fs.log.length, 1);
    });
    ok("Date ヘッダーなし・時計のずれ（10分遅れ・8分進み）は、時刻確認の1回だけで止まり、データを読まない");

    await withServer(async (fs) => {
      // こちらの時計が4分ずれていても（許容内）、Firestore の時刻を基準にするので正しく取れる
      const k = shiftableClocks();
      k.off.wall = -4 * 60_000;
      const r = await createConsistentExport({ mode: "production", makeReader: makeReaderFor(fs, k), projectId: PROJECT, ...k });
      assert.ok(Math.abs(Date.parse(r.header.readTime!) - (fs.now() - 2000)) < 5000, "readTime が Firestore の時刻を基準にしていない");
      assert.ok(fs.log.every((x) => x.status === 200));
    });
    ok("こちらの時計が4分遅れていても、readTime は Firestore の時刻（Date ヘッダー）基準で決まり、正しく取れる");

    await withServer(async (fs) => {
      fs.dateMode = { kind: "lie", addMs: 2 * 60_000 }; // Date ヘッダーだけが未来（許容内のずれに見える）
      await assert.rejects(createConsistentExport({ mode: "production", makeReader: makeReaderFor(fs), projectId: PROJECT }), /HTTP 400 INVALID_ARGUMENT/);
      assert.equal(fs.log.filter((x) => x.status === 200).length, 1);
      assert.equal(fs.log.length, 2);
    });
    ok("readTime が Firestore にとって未来になった場合は、Firestore の拒否（400）で止まり、成功扱いにしない");

    await withServer(async (fs) => {
      fs.afterList = (c) => {
        if (c === 2) fs.offsetMs += 61 * 60_000; // 取得の途中で readTime が1時間より古くなる
      };
      await assert.rejects(createConsistentExport({ mode: "production", makeReader: makeReaderFor(fs), projectId: PROJECT }), /HTTP 400 FAILED_PRECONDITION/);
    });
    await withServer(async (fs) => {
      const k = shiftableClocks();
      let calls = 0;
      const monotonic = () => (++calls > 6 ? performance.now() + 51 * 60_000 : performance.now());
      await assert.rejects(createConsistentExport({ mode: "production", makeReader: makeReaderFor(fs, { monotonic, wallClock: k.wallClock }), projectId: PROJECT, monotonic, wallClock: k.wallClock }), /時間がかかりすぎた/);
    });
    ok("有効期限切れ：Firestore 側で readTime が古くなった場合（400）も、単調時計で50分を過ぎた場合も、途中で止まる");

    // ---- 時計が途中で戻る・進む・止まる（Firestore の時計・単調時計・PC の時計を独立に動かす） ----
    await withServer(async (fs) => {
      const k = shiftableClocks();
      fs.afterList = (c) => {
        if (c === 1) {
          fs.offsetMs += 55 * 60_000; // 実際に55分経過（Firestore の時計）
          k.off.mono += 55 * 60_000; // 単調時計も55分進む
          k.off.wall -= 50 * 60_000; // PC の時計だけが（55分進んだあと）50分戻る＝見かけは5分
        }
      };
      await assert.rejects(createConsistentExport({ mode: "production", makeReader: makeReaderFor(fs, k), projectId: PROJECT, ...k }), /時間がかかりすぎた/);
    });
    ok("【再現】PC の時計が途中で50分戻る（実際は55分経過）：修正前は成功していたが、単調時計で経過を測るので中断する");

    await withServer(async (fs) => {
      const k = shiftableClocks();
      fs.afterList = (c) => {
        if (c === 1) k.off.wall -= 50 * 60_000;
        if (c === 2) k.off.wall += 3 * 60 * 60_000;
      };
      const r = await createConsistentExport({ mode: "production", makeReader: makeReaderFor(fs, k), projectId: PROJECT, ...k });
      const age = Date.parse(r.header.finishedAt!) - Date.parse(r.header.readTime!);
      assert.ok(age >= 2_000 && age < 10_000, `finishedAt が PC の時計の影響を受けた: ${age}`);
      assert.ok(Math.abs(Date.parse(r.header.finishedAt!) - fs.now()) < 3_000, "finishedAt が Firestore の時刻と合っていない");
    });
    ok("PC の時計が途中で50分戻り・3時間進んでも、実際の経過が短ければ成功し、finishedAt は Firestore の時刻と合う");

    await withServer(async (fs) => {
      const k = shiftableClocks();
      fs.afterList = (c) => {
        if (c === 2) {
          fs.offsetMs += 40 * 60_000; // スリープ：Firestore の時計と PC の時計は40分進むが、単調時計は進まない
          k.off.wall += 40 * 60_000;
        }
      };
      await assert.rejects(createConsistentExport({ mode: "production", makeReader: makeReaderFor(fs, k), projectId: PROJECT, ...k }), /経過時間を正しく測れませんでした/);
    });
    ok("スリープ（単調時計が進まない）で経過時間を短く見積もった場合も、終了時の時刻確認で検出して中断する");

    // ---- 4. 新しい形式を、オフライン検証ツールと backup:verify で確認 ----
    const plain = serialize(good);
    const g = await writeBackup(out, "uranai-backup-20261108T000000Z", plain, good.header, { totalDocs: good.footer.totalDocs, rootCollections: good.rootCounts });
    const vNew = await verifyBackup({ file: new Uint8Array(g.encrypted), fileName: "uranai-backup-20261108T000000Z.ufbk", manifestText: g.manifestText, passphrase: PASS });
    assert.equal(vNew.ok, true, JSON.stringify(vNew.problems));
    assert.equal(vNew.summary?.readTime, good.header.readTime);
    let v = cli(["verify", g.file]);
    assert.equal(v.code, 0, v.out);
    assert.match(v.out, /整合性: 1時点の読み取り（readTime）・読み取りの終了: .*トップレベルの件数を照合済み/);
    assert.doesNotMatch(v.out, /⚠ このバックアップは読み取りの時点を固定していません/);
    // 説明ファイルの整合性情報を書き換えると、backup:verify は失敗する
    writeFileSync(g.manifestFile, JSON.stringify({ ...JSON.parse(g.manifestText), finishedAt: "2026-01-01T00:00:00.000Z" }));
    v = cli(["verify", g.file]);
    assert.notEqual(v.code, 0);
    assert.match(v.out, /finishedAt が、バックアップの中身と一致しません/);
    ok("新しい形式（版は 1 のまま）を、オフライン検証ツール（verifier-core）と backup:verify で確認できる。説明ファイルとの不一致も検出");

    // ---- 5. 旧形式（2026-11-06 までのヘッダー：consistency・finishedAt・countCheck なし） ----
    const legacyHeader = { ...good.header };
    delete legacyHeader.consistency;
    delete legacyHeader.finishedAt;
    delete legacyHeader.countCheck;
    const lp = serialize({ header: legacyHeader, docs: good.docs, footer: good.footer });
    const l = await writeBackup(out, "uranai-backup-20261106T001724Z", lp, legacyHeader, { totalDocs: good.footer.totalDocs, rootCollections: good.rootCounts }, true);
    assert.equal(Object.keys(JSON.parse(l.manifestText)).includes("consistency"), false);
    assert.equal((await verifyBackup({ file: new Uint8Array(l.encrypted), manifestText: l.manifestText, passphrase: PASS })).ok, true);
    v = cli(["verify", l.file]);
    assert.equal(v.code, 0, v.out);
    assert.match(v.out, /旧形式：終了時刻の記録なし/);
    const nullHeader = { ...legacyHeader, readTime: null };
    const np = serialize({ header: nullHeader, docs: good.docs, footer: good.footer });
    const nl = await writeBackup(out, "uranai-backup-20261020T000000Z", np, nullHeader, { totalDocs: good.footer.totalDocs, rootCollections: good.rootCounts }, true);
    v = cli(["verify", nl.file]);
    assert.equal(v.code, 0, v.out);
    assert.match(v.out, /⚠ このバックアップは読み取りの時点を固定していません/);
    ok("旧形式（readTime あり／なし）のバックアップを、backup:verify とオフライン検証ツールで引き続き確認できる（readTime なしは警告のみ）");

    // ---- 6. CLI ----
    const before = readdirSync(out).length;
    let c = cli(["backup", "--key", join(out, "no-such-key.json"), "--no-read-time", "--out", out]);
    assert.equal(c.code, 2, c.out);
    assert.match(c.out, /本番のバックアップでは --no-read-time は使えません/);
    assert.doesNotMatch(c.out, /鍵ファイルが見つかりません/, "鍵ファイルを読む前に拒否していない");
    c = cli(["backup", "--key", join(out, "no-such-key.json"), "--emulator", "demo-x", "--out", out]);
    assert.equal(c.code, 2, c.out);
    assert.match(c.out, /同時に指定できません/);
    c = cli(["backup", "--key", join(out, "no-such-key.json"), "--no-read-time", "--estimate"]);
    assert.equal(c.code, 2, c.out);
    ok("CLI：本番（--key）の --no-read-time と、--key と --emulator の同時指定を、鍵ファイルを読む前（ネットワークに接続する前）に拒否");

    const failDir = mkdtempSync(join(tmpdir(), "uranai-bkp-fail-"));
    try {
      c = cli(["backup", "--emulator", "demo-unreachable", "--out", failDir], { FIRESTORE_EMULATOR_HOST: "127.0.0.1:9" });
      assert.notEqual(c.code, 0, c.out);
      assert.deepEqual(readdirSync(failDir), [], "失敗したのにファイルが残っている");
    } finally {
      rmSync(failDir, { recursive: true, force: true });
    }
    assert.equal(readdirSync(out).length, before);
    ok("CLI：読み取りに失敗したら、バックアップ・説明ファイル・.partial を1つも残さない（書き出し後の確認の失敗は単体テストで確認）");

    const HOST = process.env.FIRESTORE_EMULATOR_HOST;
    if (HOST && /^(127\.0\.0\.1|localhost):\d+$/.test(HOST)) {
      const RUN = Date.now().toString(36);
      const SRC = `demo-bkpc-src-${RUN}`;
      const DST = `demo-bkpc-dst-${RUN}`;
      const root = `projects/${SRC}/databases/(default)/documents`;
      const writes = [
        ...Array.from({ length: 320 }, (_, i) => ({ update: { name: `${root}/bulk/d${i}`, fields: str(`b${i}`) } })),
        { update: { name: `${root}/stores/s1`, fields: str("store") } },
        { update: { name: `${root}/stores/s1/staff/st1`, fields: str("staff") } },
        { update: { name: `${root}/orphans/ghost/kids/k1`, fields: str("kid") } },
      ];
      for (let i = 0; i < writes.length; i += 300) {
        const res = await fetch(`http://${HOST}/v1/${root}:commit`, { method: "POST", headers: { Authorization: "Bearer owner", "content-type": "application/json" }, body: JSON.stringify({ writes: writes.slice(i, i + 300) }) });
        assert.ok(res.ok, `seed ${res.status}`);
      }
      const edir = mkdtempSync(join(tmpdir(), "uranai-bkp-emu-"));
      try {
        c = cli(["backup", "--emulator", SRC, "--out", edir]);
        assert.equal(c.code, 0, c.out);
        assert.match(c.out, /件数の照合: トップレベルの 3コレクションで一致/);
        const files = readdirSync(edir).sort();
        assert.equal(files.length, 2, files.join());
        assert.ok(files.every((f) => !f.endsWith(".partial")));
        const m = JSON.parse(readFileSync(join(edir, files.find((f) => f.endsWith(".manifest.json"))!), "utf8")) as PlainManifest;
        assert.equal(m.readTime, null);
        assert.equal(m.consistency, "none");
        assert.equal(m.countCheck, "root_collections");
        assert.equal(m.totalDocs, 324); // + 親だけのドキュメント orphans/ghost
        const file = join(edir, files.find((f) => f.endsWith(".ufbk"))!);
        v = cli(["verify", file]);
        assert.equal(v.code, 0, v.out);
        assert.match(v.out, /整合性: 時点の固定なし（Emulator）/);
        const vr = await verifyBackup({ file: new Uint8Array(readFileSync(file)), manifestText: readFileSync(file.replace(/\.ufbk$/, ".manifest.json"), "utf8"), passphrase: PASS });
        assert.equal(vr.ok, true, JSON.stringify(vr.problems));
        const r = cli(["restore-emulator", file, "--project", DST]);
        assert.equal(r.code, 0, r.out);
        assert.match(r.out, /全ドキュメント（ID・型・値）がバックアップと一致/);
        // Emulator では、従来どおり --no-read-time を付けても動く（もともと readTime を使わない）
        const edir2 = mkdtempSync(join(tmpdir(), "uranai-bkp-emu2-"));
        try {
          c = cli(["backup", "--emulator", SRC, "--no-read-time", "--out", edir2]);
          assert.equal(c.code, 0, c.out);
        } finally {
          rmSync(edir2, { recursive: true, force: true });
        }
      } finally {
        rmSync(edir, { recursive: true, force: true });
      }
      ok("Emulator：従来どおり readTime なしで作成（consistency: none・件数の照合あり）→ backup:verify・オフライン検証ツール・Emulator への復元がすべて成功");
    } else {
      console.log("（FIRESTORE_EMULATOR_HOST が無いため、Emulator の流れは省略）");
    }
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
  console.log("\nBACKUP CONSISTENCY E2E PASSED");
}

main().catch((e) => {
  console.error("BACKUP CONSISTENCY E2E FAILED:", e);
  process.exit(1);
});
