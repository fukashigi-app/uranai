/**
 * Firestore のバックアップ（読み取り専用）・検証・Emulator への復元テスト。
 *
 *   npm run backup:firestore -- --key <読み取り専用サービスアカウントの鍵JSON>   … 本番のバックアップを作成
 *   npm run backup:firestore -- --key <鍵JSON> --estimate                        … 件数の見積もりだけ（読み取り回数の目安）
 *   npm run backup:verify -- backups/uranai-backup-XXXX.ufbk                      … 復号・件数・ハッシュの確認
 *   npm run backup:restore-emulator -- backups/uranai-backup-XXXX.ufbk --project demo-restore-test
 *                                                                                  … Emulator にだけ復元して元と比較
 * 合言葉は環境変数 BACKUP_PASSPHRASE、または画面での入力（表示されない）で渡す。
 * 表示するのはトップレベルのコレクション名と件数だけ。ドキュメントID・フィールドの値・鍵は表示しない。
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { canonical, createConsistentExport, exportAll, parseAndVerify, serialize, sha256, writeBackupFilesAtomically, type BackupDoc, type PlainManifest } from "../src/lib/ops/backup/archive";
import { assertPassphrase, decryptBackup, encryptBackup, MIN_PASSPHRASE_LENGTH } from "../src/lib/ops/backup/crypto";
import { FirestoreReadOnlyReader } from "../src/lib/ops/backup/reader";
import { assertEmulatorTarget, restoreToEmulator, rewriteReferences } from "../src/lib/ops/backup/restore-emulator";
import { HiddenLineBuffer, isInsideDir, toGitRelativePath } from "../src/lib/ops/backup/cli-safety";

const args = process.argv.slice(2);
const cmd = args[0];
const opt = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const flag = (name: string) => args.includes(name);
/** 値を取るオプション（この直後の引数はファイル名として扱わない） */
const VALUE_OPTS = new Set(["--key", "--out", "--emulator", "--project"]);
const positional = () => args.slice(1).find((a, i, arr) => !a.startsWith("--") && !(i > 0 && VALUE_OPTS.has(arr[i - 1])));

function fail(msg: string, code = 1): never {
  console.error(`✘ ${msg}`);
  process.exit(code);
}

/** Git に上がらない場所か（リポジトリの外、または .gitignore 済み）。判定できないときは安全側（上がる）として扱う */
function isSafeFromGit(path: string): boolean {
  try {
    const top = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    const abs = resolve(path);
    if (!isInsideDir(top, abs)) return true;
    execFileSync("git", ["check-ignore", "-q", "--", toGitRelativePath(top, abs)], { cwd: top, stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

async function askHidden(question: string): Promise<string> {
  if (!process.stdin.isTTY) {
    // Git Bash（mintty）などでは入力を隠せない
    if (process.stdout.isTTY) console.error("⚠ この画面では入力した合言葉が表示されることがあります。Windows では PowerShell か Windows Terminal で実行してください。");
    process.stdout.write(question);
    const rl = createInterface({ input: process.stdin });
    for await (const line of rl) {
      rl.close();
      return line;
    }
    return "";
  }
  return new Promise((res) => {
    process.stdout.write(question);
    const stdin = process.stdin;
    const buf = new HiddenLineBuffer();
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    const onData = (chunk: string) => {
      const state = buf.feed(chunk);
      if (state.status === "pending") return;
      stdin.setRawMode(false);
      stdin.pause();
      stdin.off("data", onData);
      process.stdout.write("\n");
      if (state.status === "interrupt") process.exit(130);
      res(state.value);
    };
    stdin.on("data", onData);
  });
}

async function passphrase(confirm: boolean): Promise<string> {
  let p = process.env.BACKUP_PASSPHRASE;
  if (!p) {
    p = await askHidden(`バックアップの合言葉（${MIN_PASSPHRASE_LENGTH}文字以上・表示されません）: `);
    if (confirm && (await askHidden("もう一度入力してください: ")) !== p) fail("合言葉が一致しません。");
  }
  try {
    assertPassphrase(p);
  } catch (e) {
    fail((e as Error).message);
  }
  return p!;
}

/** 本番：読み取り専用サービスアカウントの鍵から、アクセストークンを取得する。makeReader(readTime) で読み取りクライアントを作る */
async function productionReader(keyPath: string) {
  if (process.env.FIRESTORE_EMULATOR_HOST) fail("FIRESTORE_EMULATOR_HOST が設定されています。本番のバックアップでは外してから実行してください。");
  if (!existsSync(keyPath)) fail("鍵ファイルが見つかりません。");
  if (!isSafeFromGit(keyPath)) fail("鍵ファイルが Git の管理対象の場所にあります。リポジトリの外（例：ホームフォルダの専用フォルダ）に移してください。");
  let key: { project_id?: string; client_email?: string; private_key?: string; type?: string };
  try {
    key = JSON.parse(readFileSync(keyPath, "utf8"));
  } catch {
    fail("鍵ファイルを読み込めません（サービスアカウントの JSON か確認してください）。");
  }
  if (key!.type !== "service_account" || !key!.project_id || !key!.client_email || !key!.private_key) fail("サービスアカウントの鍵 JSON ではありません。");
  const { cert } = await import("firebase-admin/app");
  const credential = cert({ projectId: key!.project_id, clientEmail: key!.client_email, privateKey: key!.private_key });
  let token: { value: string; exp: number } | null = null;
  const getToken = async () => {
    if (!token || Date.now() > token.exp - 60_000) {
      const t = await credential.getAccessToken();
      token = { value: t.access_token, exp: Date.now() + t.expires_in * 1000 };
    }
    return token.value;
  };
  const projectId = key!.project_id!;
  return { projectId, makeReader: (readTime: string | undefined) => new FirestoreReadOnlyReader({ baseUrl: "https://firestore.googleapis.com", projectId, getToken, readTime }) };
}

/** Emulator（テスト用）：demo- のプロジェクトだけ */
function emulatorReader(projectId: string) {
  const host = process.env.FIRESTORE_EMULATOR_HOST;
  let base: string;
  try {
    base = assertEmulatorTarget({ emulatorHost: host, projectId });
  } catch {
    fail("--emulator で使えるのは、Firestore Emulator（FIRESTORE_EMULATOR_HOST）の demo- で始まるプロジェクトだけです。本番は --key を使ってください。");
  }
  // Emulator は readTime（時点を指定した読み取り）に対応していないため使わない
  const make = () => new FirestoreReadOnlyReader({ baseUrl: base, projectId, getToken: async () => "owner" });
  return { projectId, reader: make(), makeReader: (readTime: string | undefined) => (readTime === undefined ? make() : fail("Emulator では読み取りの時点（readTime）を使えません。")) };
}

function stamp(d = new Date()) {
  return d.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
}

async function cmdBackup() {
  const keyPath = opt("--key");
  const emu = opt("--emulator");
  // 本番（--key）か Emulator（--emulator）かを、ネットワークに接続する前にはっきりさせる
  if (keyPath && emu) fail("--key（本番）と --emulator（テスト）は同時に指定できません。どちらか一方だけを指定してください。", 2);
  if (!keyPath && !emu) fail("--key <鍵JSON>（本番）または --emulator <demo-プロジェクトID>（テスト）を指定してください。", 2);
  // 本番は必ず「1時点の内容」（readTime）で全件を読む。時点を固定しない読み取りは本番では選べない
  if (keyPath && flag("--no-read-time")) fail("本番のバックアップでは --no-read-time は使えません（読み取り中の変更が混ざるのを防ぐため、時点の指定は必須です）。--no-read-time を外して実行してください。", 2);
  const mode = keyPath ? "production" : "emulator";
  const { projectId, makeReader } = keyPath ? await productionReader(keyPath) : emulatorReader(emu!);

  if (flag("--estimate")) {
    // 見積もりは件数の目安だけなので、時点は固定しない
    const reader = makeReader(undefined);
    const ids = await reader.listCollectionIds(null);
    let total = 0;
    console.log("トップレベルのコレクションと件数（サブコレクションは含みません）:");
    for (const id of ids) {
      const n = await reader.countCollection(id);
      total += n;
      console.log(`  ${id}: ${n}件`);
    }
    console.log(`合計 ${total}件。バックアップ1回の読み取り回数の目安: 約 ${total * 2 + ids.length * 2 + 10} 回（Spark の無料枠は1日5万回）`);
    return;
  }

  const outDir = opt("--out") ?? "backups";
  mkdirSync(outDir, { recursive: true });
  if (!isSafeFromGit(join(outDir, "x.ufbk"))) fail(`保存先 ${outDir} が Git の管理対象です。.gitignore に追加するか、リポジトリの外を指定してください。`);
  // 合言葉の入力は時刻の確認より前に済ませる（入力に時間がかかっても readTime の有効期限を使わない）
  const pass = await passphrase(true);

  console.log(mode === "production" ? "Firestore の時刻を確認しています…" : "読み取りを開始します（Emulator・時点の指定なし）…");
  const result = await createConsistentExport({
    mode,
    makeReader,
    projectId,
    onReadTime: ({ readTime, skewMs }) => {
      if (readTime) console.log(`読み取りを開始します（時点: ${readTime}・このパソコンの時計とのずれ 約${Math.round((skewMs ?? 0) / 1000)}秒）…`);
    },
    onProgress: (p) => process.stdout.write(`\r  ${p.collections}コレクション・${p.docs}件`),
  });
  process.stdout.write("\n");
  const encrypted = encryptBackup(serialize(result), pass);
  const name = `uranai-backup-${stamp(new Date(result.header.createdAt))}`;
  const file = join(outDir, `${name}.ufbk`);
  const manifestFile = join(outDir, `${name}.manifest.json`);
  const manifest: PlainManifest = {
    format: result.header.format,
    version: result.header.version,
    createdAt: result.header.createdAt,
    readTime: result.header.readTime,
    projectIdSha256: result.header.projectIdSha256,
    totalDocs: result.footer.totalDocs,
    rootCollections: result.rootCounts,
    encryptedFile: basename(file),
    encryptedSha256: sha256(encrypted),
    encryptedBytes: encrypted.length,
    consistency: result.header.consistency,
    finishedAt: result.header.finishedAt,
    countCheck: result.header.countCheck,
  };
  // .partial の名前で書き、同じ合言葉で読み戻して確認できてから正式な名前にする（失敗したら何も残さない）
  writeBackupFilesAtomically({
    file,
    manifestFile,
    encrypted,
    manifestText: JSON.stringify(manifest, null, 2) + "\n",
    verify: (partial) => {
      const raw = readFileSync(partial);
      if (sha256(raw) !== manifest.encryptedSha256) throw new Error("書き出したバックアップの確認に失敗しました: ファイルのハッシュが一致しません。");
      const check = parseAndVerify(decryptBackup(raw, pass));
      if (!check.ok) throw new Error(`書き出したバックアップの確認に失敗しました: ${check.problems.join(" / ")}`);
    },
  });
  console.log("トップレベルのコレクション（件数）:");
  for (const [k, v] of Object.entries(result.rootCounts)) console.log(`  ${k}: ${v}件`);
  console.log(`合計 ${result.footer.totalDocs}件（うちサブコレクションの親だけのドキュメント ${result.footer.missingDocs}件）・コレクション ${Object.keys(result.footer.collections).length}個・リクエスト ${result.reader.requests}回`);
  console.log(`件数の照合: トップレベルの ${Object.keys(result.countedRoots).length}コレクションで一致（${result.header.readTime ? "同じ時点の集計と比較" : "Emulator・時点の指定なし"}。サブコレクションは照合の対象外）`);
  if (result.header.readTime) console.log(`読み取りの時点: ${result.header.readTime}・終了: ${result.header.finishedAt}（Firestore の時刻・推定）`);
  else console.log("⚠ 時点を固定していないバックアップです（Emulator のテスト用）。");
  console.log(`✔ 作成しました: ${file}（${encrypted.length.toLocaleString()} バイト・暗号化済み）`);
  console.log(`  説明ファイル: ${manifestFile}`);
}

function loadAndVerify(file: string, pass: string) {
  if (!existsSync(file)) fail("バックアップファイルが見つかりません。");
  const raw = readFileSync(file);
  const problems: string[] = [];
  const manifestPath = file.replace(/\.ufbk$/, ".manifest.json");
  let m: PlainManifest | null = null;
  if (existsSync(manifestPath)) {
    m = JSON.parse(readFileSync(manifestPath, "utf8")) as PlainManifest;
    if (m.encryptedSha256 !== sha256(raw)) problems.push("説明ファイルに記録したハッシュとファイルが一致しません（ファイルが変わっています）。");
  } else console.log("⚠ 説明ファイル（.manifest.json）が見つからないため、ファイル全体のハッシュ照合は省略します。");
  let report;
  try {
    report = parseAndVerify(decryptBackup(raw, pass));
  } catch (e) {
    fail((e as Error).message);
  }
  const h = report!.header;
  if (m && h) {
    // 説明ファイルの時点・整合性の記録が中身と同じか（新しい項目は、どちらかにあれば比べる）
    if (m.createdAt !== h.createdAt || (m.readTime ?? null) !== h.readTime) problems.push("説明ファイルの作成日時・読み取りの時点が、バックアップの中身と一致しません。");
    for (const k of ["consistency", "finishedAt", "countCheck"] as const) if ((m[k] ?? null) !== (h[k] ?? null)) problems.push(`説明ファイルの ${k} が、バックアップの中身と一致しません。`);
  }
  return { report: report!, problems: [...problems, ...report!.problems] };
}

async function cmdVerify() {
  const file = positional();
  if (!file) fail("確認するバックアップファイルを指定してください。", 2);
  const { report, problems } = loadAndVerify(file!, await passphrase(false));
  const roots: Record<string, number> = {};
  for (const d of report.docs) if (!d.c.includes("/")) roots[d.c] = (roots[d.c] ?? 0) + 1;
  const h = report.header;
  console.log(`作成日時: ${h?.createdAt}・読み取り時点: ${h?.readTime ?? "（固定なし）"}`);
  const kind = h?.consistency === "read_time" ? "1時点の読み取り（readTime）" : h?.consistency === "none" ? "時点の固定なし（Emulator）" : h?.readTime ? "1時点の読み取り（readTime・旧形式：終了時刻の記録なし）" : "時点の固定なし（旧形式）";
  console.log(`整合性: ${kind}${h?.finishedAt ? `・読み取りの終了: ${h.finishedAt}` : ""}${h?.countCheck === "root_collections" ? "・トップレベルの件数を照合済み" : ""}`);
  for (const w of report.warnings) console.log(`⚠ ${w}`);
  for (const [k, v] of Object.entries(roots).sort()) console.log(`  ${k}: ${v}件`);
  console.log(`合計 ${report.docs.length}件・コレクション ${report.collectionCount}個`);
  for (const need of ["users", "stores"]) if (!(need in roots)) console.log(`⚠ 「${need}」コレクションが含まれていません（本番のバックアップなら通常は含まれます）。`);
  if (problems.length) fail(`確認に失敗しました:\n  - ${problems.join("\n  - ")}`);
  console.log("✔ 復号・件数・内容のハッシュの確認に成功しました。");
}

/** Emulator から読み直して、バックアップと同じか比べる（作成・更新時刻は除く） */
async function compareWithEmulator(docs: BackupDoc[], projectId: string): Promise<string[]> {
  const { reader } = emulatorReader(projectId);
  const restored = await exportAll(reader, { projectId, databaseId: "(default)", readTime: null });
  // 参照（referenceValue）はプロジェクト部分を除いて比べる（復元先のプロジェクトに付け替えているため）
  const root = `projects/${projectId}/databases/(default)/documents`;
  const key = (d: BackupDoc) => (d.missing ? `${d.p}\u0000missing` : `${d.p}\u0000${canonical(rewriteReferences(d.f ?? {}, root))}`);
  const a = new Set(docs.map(key));
  const b = new Set(restored.docs.map(key));
  const diffs: string[] = [];
  let onlyA = 0;
  let onlyB = 0;
  for (const k of a) if (!b.has(k)) onlyA++;
  for (const k of b) if (!a.has(k)) onlyB++;
  if (onlyA) diffs.push(`バックアップにあって復元先に無い（または内容が違う）ドキュメント: ${onlyA}件`);
  if (onlyB) diffs.push(`復元先にだけある（または内容が違う）ドキュメント: ${onlyB}件`);
  return diffs;
}

async function cmdRestoreEmulator() {
  const file = positional();
  const projectId = opt("--project");
  if (!file || !projectId) fail("バックアップファイルと --project <demo-で始まるプロジェクトID> を指定してください。", 2);
  // 1件も書き込む前に、復元先が Emulator の demo- プロジェクトであることを確認
  try {
    assertEmulatorTarget({ emulatorHost: process.env.FIRESTORE_EMULATOR_HOST, projectId: projectId! });
  } catch (e) {
    fail((e as Error).message);
  }
  const { report, problems } = loadAndVerify(file!, await passphrase(false));
  if (problems.length) fail(`バックアップの確認に失敗したため、復元しません:\n  - ${problems.join("\n  - ")}`);
  const pre = await emulatorReader(projectId!).reader.listCollectionIds(null);
  if (pre.length && !flag("--allow-nonempty")) fail("復元先の Emulator プロジェクトにすでにデータがあります。空のプロジェクトIDを指定してください。");
  const r = await restoreToEmulator(report.docs, { emulatorHost: process.env.FIRESTORE_EMULATOR_HOST, projectId: projectId! });
  console.log(`Emulator（${projectId}）に ${r.written}件を書き込みました（親だけのドキュメント ${r.skippedMissing}件は、サブコレクションの復元で自動的に現れます）。`);
  const diffs = await compareWithEmulator(report.docs, projectId!);
  if (diffs.length) fail(`復元結果がバックアップと一致しません:\n  - ${diffs.join("\n  - ")}`);
  console.log("✔ 復元先を読み直して、全ドキュメント（ID・型・値）がバックアップと一致することを確認しました。");
}

const commands: Record<string, () => Promise<void>> = { backup: cmdBackup, verify: cmdVerify, "restore-emulator": cmdRestoreEmulator };
if (!commands[cmd]) fail("使い方: backup | verify | restore-emulator（詳しくは docs/firestore-backup.md）", 2);
commands[cmd]().then(
  () => process.exit(0),
  (e) => {
    // ドキュメントのパスや鍵を含まないよう、メッセージだけを表示する
    console.error(`✘ ${(e as Error).message}`);
    process.exit(1);
  },
);
