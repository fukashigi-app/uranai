/**
 * バックアップ・検証・復元テストの E2E（Firestore Emulator の demo- プロジェクトだけで実行。本番には接続しない）。
 *
 *   FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 npm run e2e:backup
 *
 * 確認すること
 *  1. あらゆる型・ID・サブコレクション（親だけのドキュメントを含む）・複数ページのデータをバックアップできる
 *  2. バックアップ中に元のデータが1件も変わらない（読み取り専用）
 *  3. 表示にドキュメントID・値が出ない
 *  4. 検証：改ざん・合言葉違い・説明ファイルとの不一致を検出する
 *  5. 復元は Emulator の demo- プロジェクトだけ。それ以外・空でない復元先は1件も書かずに止まる
 *  6. 復元後に読み直すと、ID・型・値がすべて一致する（整数と小数・NaN・日時・位置・参照・バイナリ・null など）
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonical, exportAll } from "../src/lib/ops/backup/archive";
import { FirestoreReadOnlyReader } from "../src/lib/ops/backup/reader";

const HOST = process.env.FIRESTORE_EMULATOR_HOST;
if (!HOST || !/^(127\.0\.0\.1|localhost):\d+$/.test(HOST)) {
  console.error("FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 を指定して、Firestore Emulator で実行してください。");
  process.exit(2);
}
const RUN = Date.now().toString(36);
const SRC = `demo-bkp-src-${RUN}`;
const DST = `demo-bkp-dst-${RUN}`;
const PASS = "e2e-backup-passphrase-1234567890";
const SECRET_ID = "someone@example.com"; // 表示に出てはいけないドキュメントID
const SECRET_VALUE = "SECRET-FIELD-VALUE-xyz";
let n = 0;
const ok = (m: string) => console.log(`✔ ${++n}. ${m}`);

const root = (p: string) => `projects/${p}/databases/(default)/documents`;
async function commit(project: string, writes: unknown[]) {
  const res = await fetch(`http://${HOST}/v1/${root(project)}:commit`, { method: "POST", headers: { Authorization: "Bearer owner", "content-type": "application/json" }, body: JSON.stringify({ writes }) });
  if (!res.ok) throw new Error(`seed failed ${res.status} ${await res.text()}`);
}
const put = (project: string, path: string, fields: Record<string, unknown>) => ({ update: { name: `${root(project)}/${path}`, fields } });

function cli(args: string[], env: Record<string, string | undefined> = {}): { code: number; out: string } {
  try {
    const out = execFileSync("npx", ["tsx", "scripts/firestore-backup.ts", ...args], { env: { ...process.env, BACKUP_PASSPHRASE: PASS, ...env }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return { code: 0, out };
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string };
    return { code: err.status ?? 1, out: `${err.stdout ?? ""}${err.stderr ?? ""}` };
  }
}

const reader = (project: string) => new FirestoreReadOnlyReader({ baseUrl: `http://${HOST}`, projectId: project, getToken: async () => "owner", pageSize: 300 });
/** 作成・更新時刻まで含めた全内容（読み取り専用の確認用） */
async function snapshot(project: string): Promise<string> {
  const r = await exportAll(reader(project), { projectId: project, databaseId: "(default)", readTime: null, createdAt: "x" });
  return r.docs.map(canonical).sort().join("\n");
}
async function getDoc(project: string, path: string) {
  const res = await fetch(`http://${HOST}/v1/${root(project)}/${path.split("/").map(encodeURIComponent).join("/")}`, { headers: { Authorization: "Bearer owner" } });
  return (await res.json()) as { fields: Record<string, Record<string, unknown>> };
}

async function main() {
  const out = mkdtempSync(join(tmpdir(), "uranai-bkp-"));
  try {
    // ---- 元データ（REST で型を厳密に指定して作る） ----
    const types = {
      int: { integerValue: "42" },
      bigInt: { integerValue: "9007199254740993" }, // JavaScript の数値では表せない整数
      doubleOne: { doubleValue: 1.0 }, // 1.0（小数）。整数の 1 と区別されること
      pi: { doubleValue: 3.14159 },
      nan: { doubleValue: "NaN" },
      inf: { doubleValue: "Infinity" },
      ts: { timestampValue: "2026-10-21T01:02:03.123456Z" },
      geo: { geoPointValue: { latitude: 35.681236, longitude: 139.767125 } },
      ref: { referenceValue: `${root(SRC)}/stores/s1` },
      bytes: { bytesValue: Buffer.from([0, 1, 2, 250, 255]).toString("base64") },
      nul: { nullValue: null },
      bool: { booleanValue: false },
      str: { stringValue: `日本語・絵文字🔮・改行\nあり ${SECRET_VALUE}` },
      emptyMap: { mapValue: {} },
      emptyArr: { arrayValue: {} },
      nested: {
        mapValue: {
          fields: {
            arr: { arrayValue: { values: [{ integerValue: "1" }, { doubleValue: 1.0 }, { mapValue: { fields: { deep: { stringValue: "x" } } } }, { nullValue: null }] } },
            when: { timestampValue: "2020-01-01T00:00:00Z" },
          },
        },
      },
    };
    const writes = [
      put(SRC, "types/t1", types),
      put(SRC, "users/u1", { email: { stringValue: SECRET_ID }, n: { integerValue: "1" } }),
      put(SRC, `userEmails/${SECRET_ID}`, { userId: { stringValue: "u1" } }),
      put(SRC, "users/日本語ID", { a: { stringValue: "unicode id" } }),
      put(SRC, "users/with space+plus=%", { a: { stringValue: "special id" } }),
      put(SRC, "stores/s1", { name: { stringValue: "店" } }),
      put(SRC, "stores/s1/staff/st1", { role: { stringValue: "OWNER" } }),
      put(SRC, "stores/s1/staff/st1/notes/n1", { body: { stringValue: "deep" } }),
      put(SRC, "orphans/ghost/children/c1", { x: { integerValue: "1" } }), // 親の orphans/ghost は存在しない
      put(SRC, "empty/e1", {}),
    ];
    for (let i = 0; i < 650; i++) writes.push(put(SRC, `bulk/d${String(i).padStart(4, "0")}`, { i: { integerValue: String(i) } }));
    for (let i = 0; i < writes.length; i += 300) await commit(SRC, writes.slice(i, i + 300));
    const before = await snapshot(SRC);

    // ---- バックアップ ----
    const b = cli(["backup", "--emulator", SRC, "--out", out]);
    assert.equal(b.code, 0, b.out);
    const files = readdirSync(out);
    const file = join(out, files.find((f) => f.endsWith(".ufbk"))!);
    const manifestFile = file.replace(/\.ufbk$/, ".manifest.json");
    const manifest = JSON.parse(readFileSync(manifestFile, "utf8"));
    assert.equal(manifest.totalDocs, writes.length + 1); // + 親だけのドキュメント orphans/ghost
    assert.deepEqual(Object.keys(manifest.rootCollections).sort(), ["bulk", "empty", "orphans", "stores", "types", "userEmails", "users"]);
    assert.equal(manifest.rootCollections.bulk, 650);
    ok(`全コレクション・サブコレクション（3階層・親だけのドキュメント含む）・複数ページ（650件）をバックアップ：合計 ${manifest.totalDocs}件`);

    assert.equal(await snapshot(SRC), before, "バックアップ中に元のデータが変わった");
    ok("バックアップの前後で元データ（作成・更新時刻まで）が完全に同じ＝書き込みなし");

    const shown = b.out + readFileSync(manifestFile, "utf8");
    for (const s of [SECRET_ID, SECRET_VALUE, "日本語ID", "with space", "st1", "ghost", PASS]) assert.equal(shown.includes(s), false, `表示・説明ファイルに ${s} が出ている`);
    assert.equal(readFileSync(file).includes(Buffer.from(SECRET_VALUE)), false, "暗号化されていない");
    assert.equal(readFileSync(file).includes(Buffer.from("types")), false, "暗号化されていない");
    ok("表示・説明ファイルにドキュメントID・値・合言葉が出ない。バックアップ本体は暗号化されている");

    // ---- 検証 ----
    let v = cli(["verify", file]);
    assert.equal(v.code, 0, v.out);
    assert.match(v.out, /復号・件数・内容のハッシュの確認に成功/);
    const tampered = join(out, "tampered.ufbk");
    const buf = readFileSync(file);
    buf[Math.floor(buf.length / 2)] ^= 0x01;
    writeFileSync(tampered, buf);
    v = cli(["verify", tampered]);
    assert.notEqual(v.code, 0);
    assert.match(v.out, /改ざん|一致しません/);
    v = cli(["verify", file], { BACKUP_PASSPHRASE: "wrong-passphrase-0000000000" });
    assert.notEqual(v.code, 0);
    assert.match(v.out, /合言葉が違う/);
    const copy = join(out, "copy.ufbk");
    copyFileSync(file, copy);
    writeFileSync(copy.replace(/\.ufbk$/, ".manifest.json"), JSON.stringify({ ...manifest, encryptedSha256: "0".repeat(64) }));
    v = cli(["verify", copy]);
    assert.notEqual(v.code, 0);
    assert.match(v.out, /ハッシュとファイルが一致しません/);
    v = cli(["verify", file], { BACKUP_PASSPHRASE: "short" });
    assert.notEqual(v.code, 0);
    ok("検証：正常なら成功。1バイトの改ざん・合言葉違い・説明ファイルとの不一致・短すぎる合言葉はすべて失敗");

    // ---- 復元先の安全確認（1件も書かずに止まる） ----
    let r = cli(["restore-emulator", file, "--project", "uranai-prod"]);
    assert.notEqual(r.code, 0);
    assert.match(r.out, /demo- で始まっていません/);
    r = cli(["restore-emulator", file, "--project", DST], { FIRESTORE_EMULATOR_HOST: "" });
    assert.notEqual(r.code, 0);
    r = cli(["restore-emulator", file, "--project", DST], { FIRESTORE_EMULATOR_HOST: "10.0.0.5:8080" });
    assert.notEqual(r.code, 0);
    assert.equal((await reader(DST).listCollectionIds(null)).length, 0);
    r = cli(["restore-emulator", file, "--project", SRC]); // データのある Emulator プロジェクトには上書きしない
    assert.notEqual(r.code, 0);
    assert.match(r.out, /すでにデータがあります/);
    assert.equal(await snapshot(SRC), before);
    ok("復元は Emulator の空の demo- プロジェクトだけ（本番のID・Emulator 以外・データのある復元先は1件も書かずに停止）");

    // ---- 復元と比較 ----
    r = cli(["restore-emulator", file, "--project", DST]);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /全ドキュメント（ID・型・値）がバックアップと一致/);
    const t = (await getDoc(DST, "types/t1")).fields;
    assert.deepEqual(t.doubleOne, { doubleValue: 1 });
    assert.ok("doubleValue" in t.doubleOne && !("integerValue" in t.doubleOne), "1.0 が整数になった");
    assert.deepEqual(t.bigInt, { integerValue: "9007199254740993" });
    assert.deepEqual(t.nan, { doubleValue: "NaN" });
    assert.deepEqual(t.ts, { timestampValue: "2026-10-21T01:02:03.123456Z" });
    assert.deepEqual(t.geo, types.geo);
    assert.deepEqual(t.bytes, types.bytes);
    assert.deepEqual(t.ref, { referenceValue: `${root(DST)}/stores/s1` });
    assert.equal(canonical(t.nested), canonical(types.nested));
    assert.equal((await getDoc(DST, "stores/s1/staff/st1/notes/n1")).fields.body.stringValue, "deep");
    assert.equal((await getDoc(DST, `userEmails/${SECRET_ID}`)).fields.userId.stringValue, "u1");
    ok("Emulator に復元：ID・型（整数/小数・巨大整数・NaN・日時・位置・参照・バイナリ・入れ子）・サブコレクションがすべて一致");

    assert.equal(await snapshot(SRC), before);
    ok("一連の操作のあとも元データは変わっていない");
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
  console.log("\nBACKUP E2E PASSED");
}

main().catch((e) => {
  console.error("BACKUP E2E FAILED:", e);
  process.exit(1);
});
