/**
 * バックアップの中身（暗号化する前）の作成・読み込み・検証。
 *
 * 形式: gzip 圧縮した NDJSON（1行1レコード）
 *   {"t":"header", format, version, createdAt, readTime, projectIdSha256, databaseId}
 *   {"t":"doc", c: コレクションのパス, p: ドキュメントのパス, f: フィールド（Firestore の型付き JSON のまま）, ct, ut}
 *   {"t":"doc", c, p, missing: true}   … フィールドの無い「親だけのドキュメント」（サブコレクションのため）
 *   {"t":"footer", collections: { <コレクションのパス>: { count, sha256 } }, totalDocs, missingDocs}
 * パスは root（…/documents/）からの相対パスで保存し、別のプロジェクト（Emulator）へも復元できるようにする。
 */
import { createHash } from "node:crypto";
import { gunzipSync, gzipSync } from "node:zlib";
import type { FirestoreReadOnlyReader, RestDocument } from "./reader";

export const BACKUP_FORMAT = "uranai-firestore-backup";
export const BACKUP_VERSION = 1;

export type BackupHeader = { t: "header"; format: string; version: number; createdAt: string; readTime: string | null; projectIdSha256: string; databaseId: string };
export type BackupDoc = { t: "doc"; c: string; p: string; f?: Record<string, unknown>; ct?: string; ut?: string; missing?: true };
export type BackupFooter = { t: "footer"; collections: Record<string, { count: number; sha256: string }>; totalDocs: number; missingDocs: number };

/** キーを並べ替えた JSON（ハッシュと比較に使う。同じ内容なら必ず同じ文字列になる） */
export function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object") {
    return `{${Object.keys(v as object)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v);
}

export const sha256 = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");

export type ExportProgress = { collections: number; docs: number };

/**
 * 全コレクション・サブコレクションを読み取り、レコードの配列を返す（読み取りのみ）。
 * @param deadline この時刻を過ぎたら中断（readTime の有効期限1時間より前に終える）
 */
export async function exportAll(
  reader: FirestoreReadOnlyReader,
  meta: { projectId: string; databaseId: string; readTime: string | null; createdAt?: string },
  opts: { deadline?: number; onProgress?: (p: ExportProgress) => void } = {},
): Promise<{ header: BackupHeader; docs: BackupDoc[]; footer: BackupFooter; rootCounts: Record<string, number> }> {
  const header: BackupHeader = {
    t: "header",
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    createdAt: meta.createdAt ?? new Date().toISOString(),
    readTime: meta.readTime,
    projectIdSha256: sha256(meta.projectId),
    databaseId: meta.databaseId,
  };
  const docs: BackupDoc[] = [];
  const hashes = new Map<string, { count: number; h: ReturnType<typeof createHash> }>();
  const rootCounts: Record<string, number> = {};
  let missing = 0;
  const progress = { collections: 0, docs: 0 };

  const walk = async (collectionPath: string) => {
    progress.collections += 1;
    const entry = { count: 0, h: createHash("sha256") };
    hashes.set(collectionPath, entry);
    for await (const d of reader.listDocuments(collectionPath)) {
      if (opts.deadline && Date.now() > opts.deadline) throw new Error("読み取りに時間がかかりすぎたため中断しました（readTime の有効期限）。もう一度実行してください。");
      const rec = toRecord(reader, collectionPath, d);
      docs.push(rec);
      entry.count += 1;
      entry.h.update(canonical(rec) + "\n");
      if (rec.missing) missing += 1;
      if (!collectionPath.includes("/")) rootCounts[collectionPath] = (rootCounts[collectionPath] ?? 0) + 1;
      progress.docs += 1;
      if (progress.docs % 200 === 0) opts.onProgress?.(progress);
      for (const sub of await reader.listCollectionIds(rec.p)) await walk(`${rec.p}/${sub}`);
    }
    if (!collectionPath.includes("/")) rootCounts[collectionPath] ??= 0;
  };

  for (const id of await reader.listCollectionIds(null)) await walk(id);
  opts.onProgress?.(progress);
  const collections: BackupFooter["collections"] = {};
  for (const [path, e] of hashes) collections[path] = { count: e.count, sha256: e.h.digest("hex") };
  return { header, docs, footer: { t: "footer", collections, totalDocs: docs.length, missingDocs: missing }, rootCounts };
}

function toRecord(reader: FirestoreReadOnlyReader, collectionPath: string, d: RestDocument): BackupDoc {
  const p = reader.relativePath(d.name);
  // showMissing で返る「親だけのドキュメント」は createTime を持たない
  if (!d.createTime && !d.fields) return { t: "doc", c: collectionPath, p, missing: true };
  return { t: "doc", c: collectionPath, p, f: d.fields ?? {}, ct: d.createTime, ut: d.updateTime };
}

export function serialize(b: { header: BackupHeader; docs: BackupDoc[]; footer: BackupFooter }): Buffer {
  const lines = [canonical(b.header), ...b.docs.map(canonical), canonical(b.footer)];
  return gzipSync(Buffer.from(lines.join("\n") + "\n", "utf8"), { level: 9 });
}

export type VerifyReport = { ok: boolean; problems: string[]; header?: BackupHeader; footer?: BackupFooter; docs: BackupDoc[]; collectionCount: number };

/** 復号済みの中身を読み込み、件数・ハッシュ・形式を確認する */
export function parseAndVerify(plainGz: Buffer): VerifyReport {
  const problems: string[] = [];
  let text: string;
  try {
    text = gunzipSync(plainGz).toString("utf8");
  } catch {
    return { ok: false, problems: ["圧縮データを展開できません。"], docs: [], collectionCount: 0 };
  }
  const lines = text.split("\n").filter((l) => l !== "");
  let header: BackupHeader | undefined;
  let footer: BackupFooter | undefined;
  const docs: BackupDoc[] = [];
  const hashes = new Map<string, { count: number; h: ReturnType<typeof createHash> }>();
  lines.forEach((line, i) => {
    let rec: { t?: string };
    try {
      rec = JSON.parse(line);
    } catch {
      problems.push(`${i + 1}行目が JSON として読めません。`);
      return;
    }
    if (rec.t === "header") header = rec as BackupHeader;
    else if (rec.t === "footer") footer = rec as BackupFooter;
    else if (rec.t === "doc") {
      const d = rec as BackupDoc;
      if (typeof d.c !== "string" || typeof d.p !== "string" || !d.p.startsWith(`${d.c}/`) || (!d.missing && (typeof d.f !== "object" || d.f === null))) {
        problems.push(`${i + 1}行目のドキュメントの形式が正しくありません。`);
        return;
      }
      docs.push(d);
      const e = hashes.get(d.c) ?? { count: 0, h: createHash("sha256") };
      e.count += 1;
      e.h.update(canonical(d) + "\n");
      hashes.set(d.c, e);
    } else problems.push(`${i + 1}行目の種類が不明です。`);
  });
  if (!header || header.format !== BACKUP_FORMAT) problems.push("ヘッダーがありません（このツールのバックアップではない可能性）。");
  else if (header.version !== BACKUP_VERSION) problems.push("対応していない版のバックアップです。");
  if (!footer) problems.push("末尾の確認情報がありません（途中で切れている可能性）。");
  else {
    if (footer.totalDocs !== docs.length) problems.push("ドキュメントの総数が一致しません。");
    for (const [path, exp] of Object.entries(footer.collections)) {
      const got = hashes.get(path);
      const count = got?.count ?? 0;
      const digest = got ? got.h.digest("hex") : sha256("");
      if (count !== exp.count) problems.push(`コレクション「${path.split("/")[0]}」系の件数が一致しません。`);
      else if (count > 0 && digest !== exp.sha256) problems.push(`コレクション「${path.split("/")[0]}」系の内容のハッシュが一致しません。`);
    }
    for (const path of hashes.keys()) if (!(path in footer.collections)) problems.push(`記録に無いコレクションのデータがあります（${path.split("/")[0]} 系）。`);
  }
  return { ok: problems.length === 0, problems, header, footer, docs, collectionCount: footer ? Object.keys(footer.collections).length : 0 };
}

/** 平文で横に置く説明ファイル（中身の詳細やドキュメントIDは含めない） */
export type PlainManifest = {
  format: string;
  version: number;
  createdAt: string;
  readTime: string | null;
  projectIdSha256: string;
  totalDocs: number;
  rootCollections: Record<string, number>;
  encryptedFile: string;
  encryptedSha256: string;
  encryptedBytes: number;
};
