/**
 * バックアップの中身（暗号化する前）の作成・読み込み・検証。
 *
 * 形式: gzip 圧縮した NDJSON（1行1レコード）
 *   {"t":"header", format, version, createdAt, readTime, projectIdSha256, databaseId, consistency?, finishedAt?, countCheck?}
 *     consistency: "read_time"（全件を readTime の1時点で読んだ）/ "none"（時点を固定していない＝Emulator）
 *     finishedAt: 読み取りを終えた時刻（本番は Firestore の時刻に換算した推定値）。countCheck: 件数を照合した範囲
 *     （consistency・finishedAt・countCheck は 2026-11 に追加。無い旧形式も読める。版は 1 のまま）
 *   {"t":"doc", c: コレクションのパス, p: ドキュメントのパス, f: フィールド（Firestore の型付き JSON のまま）, ct, ut}
 *   {"t":"doc", c, p, missing: true}   … フィールドの無い「親だけのドキュメント」（サブコレクションのため）
 *   {"t":"footer", collections: { <コレクションのパス>: { count, sha256 } }, totalDocs, missingDocs}
 * パスは root（…/documents/）からの相対パスで保存し、別のプロジェクト（Emulator）へも復元できるようにする。
 */
import { createHash } from "node:crypto";
import { existsSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { gunzipSync, gzipSync } from "node:zlib";
import type { FirestoreReadOnlyReader, RestDocument, ServerTimeProbe } from "./reader";

export const BACKUP_FORMAT = "uranai-firestore-backup";
export const BACKUP_VERSION = 1;

export type BackupConsistency = "read_time" | "none";
/** 件数を照合した範囲（トップレベルのコレクションだけ。サブコレクションは照合しない） */
export type BackupCountCheck = "root_collections";
export type BackupHeader = {
  t: "header";
  format: string;
  version: number;
  createdAt: string;
  readTime: string | null;
  projectIdSha256: string;
  databaseId: string;
  consistency?: BackupConsistency;
  finishedAt?: string;
  countCheck?: BackupCountCheck;
};
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
  opts: { deadline?: number; onProgress?: (p: ExportProgress) => void; now?: () => number } = {},
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
      if (opts.deadline && (opts.now ?? Date.now)() > opts.deadline) throw new Error("読み取りに時間がかかりすぎたため中断しました（readTime の有効期限）。もう一度実行してください。");
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

export type VerifyReport = {
  ok: boolean;
  problems: string[];
  /** 失敗ではないが知っておくべきこと（時点を固定していないバックアップなど） */
  warnings: string[];
  header?: BackupHeader;
  footer?: BackupFooter;
  docs: BackupDoc[];
  collectionCount: number;
};

/** 復号済みの中身を読み込み、件数・ハッシュ・形式を確認する */
export function parseAndVerify(plainGz: Buffer): VerifyReport {
  const problems: string[] = [];
  let text: string;
  try {
    text = gunzipSync(plainGz).toString("utf8");
  } catch {
    return { ok: false, problems: ["圧縮データを展開できません。"], warnings: [], docs: [], collectionCount: 0 };
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
  const warnings: string[] = [];
  if (header && header.format === BACKUP_FORMAT) checkConsistency(header, problems, warnings);
  return { ok: problems.length === 0, problems, warnings, header, footer, docs, collectionCount: footer ? Object.keys(footer.collections).length : 0 };
}

const HOUR_MS = 60 * 60_000;
const isIso = (v: unknown): v is string => typeof v === "string" && Number.isFinite(Date.parse(v));

/**
 * ヘッダーの整合性情報の確認。
 * - consistency が無い旧形式（2026-11-06 までのもの）も受け付ける：readTime があれば1時点の読み取り、null なら警告。
 * - consistency が "read_time" なら readTime 必須。finishedAt があれば readTime 以後・1時間未満であること。
 */
function checkConsistency(h: BackupHeader, problems: string[], warnings: string[]) {
  if (h.readTime !== null && !isIso(h.readTime)) problems.push("読み取りの時点（readTime）の形式が正しくありません。");
  if (h.consistency !== undefined && h.consistency !== "read_time" && h.consistency !== "none") problems.push("整合性の種類（consistency）が不明です。");
  if (h.consistency === "read_time" && h.readTime === null) problems.push("1時点の読み取りと記録されていますが、読み取りの時点（readTime）がありません。");
  if (h.consistency === "none" && h.readTime !== null) problems.push("時点を固定していないと記録されていますが、読み取りの時点（readTime）があります。");
  if (h.countCheck !== undefined && h.countCheck !== "root_collections") problems.push("件数の照合の範囲（countCheck）が不明です。");
  if (h.finishedAt !== undefined) {
    if (!isIso(h.finishedAt)) problems.push("読み取りの終了時刻（finishedAt）の形式が正しくありません。");
    else if (isIso(h.readTime)) {
      const d = Date.parse(h.finishedAt) - Date.parse(h.readTime);
      if (d < 0) problems.push("読み取りの終了時刻が、読み取りの時点より前になっています。");
      else if (d >= HOUR_MS) problems.push("読み取りの終了時刻が、読み取りの時点から1時間以上あとです（readTime の有効期限を過ぎています）。");
    }
  }
  if (h.readTime === null) warnings.push("このバックアップは読み取りの時点を固定していません（Emulator のテスト用、または以前の --no-read-time）。読み取り中の変更が混ざっている可能性があります。");
}

// ---------------------------------------------------------------------------
// 1時点の読み取り（readTime）の決定と、全体の取得（本番は readTime 必須）
// ---------------------------------------------------------------------------

/** readTime は Firestore の時刻でこの分だけ前にする（Date ヘッダーの秒の切り捨てと、こちらの処理の遅れの分） */
export const READ_TIME_MARGIN_MS = 2_000;
/** 時刻確認の往復がこれより遅いときは、時刻を決められないとして止める */
export const MAX_PROBE_RTT_MS = 10_000;
/** こちらの時計と Firestore の時刻のずれがこれより大きいときは止める（時計の設定の誤り） */
export const MAX_CLOCK_SKEW_MS = 5 * 60_000;
/** 読み取りに使える時間（readTime は1時間以内でなければならないため、余裕を持って50分） */
export const READ_BUDGET_MS = 50 * 60_000;

export class BackupConsistencyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BackupConsistencyError";
  }
}

export type ReadTimeDecision = {
  /** すべての読み取りに付ける時点（Firestore の時刻） */
  readTime: string;
  /** 単調時計で、この値を過ぎたら中断する */
  deadline: number;
  /** 単調時計の値 → Firestore の時刻（推定。Date ヘッダーは秒単位のため最大で 1秒＋往復時間 だけ遅れ側にずれる） */
  toServerTime: (mono: number) => number;
  /** PC の時計（壁時計）と Firestore の時刻のずれ（推定。正なら PC が遅れている）。診断用 */
  skewMs: number;
  rttMs: number;
};

/**
 * 時刻確認の結果から readTime を決める（こちらの時計の値は使わない）。
 * - Date ヘッダーの時刻 D は「応答を作った時刻の秒の切り捨て」なので、Firestore の現在時刻は必ず D 以上。
 *   readTime = D − 2秒 とすれば、こちらの時計がずれていても未来の時刻にならない。
 * - readTime の古さ（Firestore の現在時刻 − readTime）は、送信からの経過時間 + 3秒（2秒の余裕 + 1秒の切り捨て）以下。
 *   送信から50分で打ち切るので、1時間の有効期限内に必ず収まる。
 * - 経過時間・往復時間・期限は単調時計（sentAt / receivedAt）で測る。PC の時計を合わせ直しても戻らない。
 *   PC の時計（wallAtReceived）は、ずれが大きすぎないかの診断だけに使う。
 */
export function decideReadTime(p: ServerTimeProbe): ReadTimeDecision {
  if (p.serverDate === null) {
    throw new BackupConsistencyError("Firestore の応答に時刻（Date ヘッダー）が無いため、読み取りの時点を安全に決められません。開始しませんでした。プロキシやセキュリティソフトが応答を書き換えていないか確認してください。");
  }
  const rtt = p.receivedAt - p.sentAt;
  if (!(rtt >= 0)) throw new BackupConsistencyError("こちらの時計が処理の途中で戻ったため、読み取りの時点を安全に決められません。開始しませんでした。もう一度実行してください。");
  if (rtt > MAX_PROBE_RTT_MS) {
    throw new BackupConsistencyError(`Firestore の応答が遅すぎる（${Math.round(rtt / 1000)}秒）ため、時刻を正確に確認できません。開始しませんでした。ネットワークの状態を確認して、もう一度実行してください。`);
  }
  // Firestore の時刻は [D, D + 1秒) の間に応答が作られ、それは送信から受信の間。こちらの時計の中間点と比べる
  const skew = p.serverDate + 500 - (p.wallAtReceived - rtt / 2);
  if (Math.abs(skew) > MAX_CLOCK_SKEW_MS) {
    const min = Math.round(Math.abs(skew) / 60_000);
    throw new BackupConsistencyError(
      `このパソコンの時計が Firestore の時刻より約${min}分${skew > 0 ? "遅れて" : "進んで"}います（許容は${MAX_CLOCK_SKEW_MS / 60_000}分）。開始しませんでした。パソコンの日付と時刻の設定で「時刻を自動的に設定する」をオンにしてから、もう一度実行してください。`,
    );
  }
  return {
    readTime: new Date(p.serverDate - READ_TIME_MARGIN_MS).toISOString(),
    deadline: p.sentAt + READ_BUDGET_MS,
    toServerTime: (local) => p.serverDate! + (local - p.receivedAt),
    skewMs: skew,
    rttMs: rtt,
  };
}

/** 終了時の時刻確認で、単調時計による推定と Firestore の時刻の差として許す余裕（ミリ秒。秒の切り捨て・往復時間に加える分） */
export const END_CHECK_SLACK_MS = 2_000;

/**
 * 終了時の時刻確認。単調時計で測った経過時間が、Firestore の時刻の進みと合っているか、readTime が有効期限内かを確かめる。
 * 単調時計は OS のスリープ中に進まないことがある（環境による）ため、その場合に経過時間を短く見積もったまま成功しないようにする。
 * Firestore の時刻 S(m) について、D1 ≤ S(r1) ≤ D1 + 1秒 + rtt1、D2 ≤ S(r2) ≤ D2 + 1秒 + rtt2 なので、
 * 単調時計が正しければ推定 E = D1 + (r2 − r1) と D2 の差は 1秒 + 往復時間 以内に収まる。
 */
export function checkEndTime(d: ReadTimeDecision, start: ServerTimeProbe, end: ServerTimeProbe): void {
  if (end.serverDate === null) throw new BackupConsistencyError("終了時の確認で Firestore の応答に時刻（Date ヘッダー）が無かったため、読み取りの時点の有効期限を確かめられません。バックアップは作成していません。もう一度実行してください。");
  const rtt = end.receivedAt - end.sentAt;
  if (!(rtt >= 0) || rtt > MAX_PROBE_RTT_MS) throw new BackupConsistencyError("終了時の確認で Firestore の応答が遅すぎたため、時刻を正確に確認できません。バックアップは作成していません。もう一度実行してください。");
  const estimate = d.toServerTime(end.receivedAt);
  const tolerance = 1_000 + Math.max(d.rttMs, rtt) + END_CHECK_SLACK_MS;
  if (Math.abs(end.serverDate - estimate) > tolerance) {
    throw new BackupConsistencyError(
      `経過時間を正しく測れませんでした（Firestore の時刻では約${Math.round((end.serverDate - start.serverDate!) / 60_000)}分経過、このパソコンの計測では約${Math.round((end.receivedAt - start.receivedAt) / 60_000)}分）。途中でパソコンがスリープした可能性があります。バックアップは作成していません。スリープしない設定にして、もう一度実行してください。`,
    );
  }
  // Firestore の時刻の上限（D2 + 1秒 + 往復時間）で、readTime がまだ1時間以内か
  if (end.serverDate + 1_000 + rtt - Date.parse(d.readTime) >= HOUR_MS) throw new BackupConsistencyError("読み取りに時間がかかりすぎたため中断しました（readTime の有効期限1時間に間に合わない可能性）。バックアップは作成していません。もう一度実行してください。");
}

/** createConsistentExport が使う読み取りの操作（FirestoreReadOnlyReader が満たす） */
export type BackupReader = Pick<FirestoreReadOnlyReader, "listCollectionIds" | "listDocuments" | "countCollection" | "relativePath" | "probeServerTime" | "readTime" | "requests">;

export type ConsistentExportResult = Awaited<ReturnType<typeof exportAll>> & {
  reader: BackupReader;
  /** トップレベルのコレクションごとの件数（同じ readTime の集計。親だけのドキュメントは含まない） */
  countedRoots: Record<string, number>;
};

/**
 * 全件の取得（本番は1時点の読み取り）。件数の照合と終了時刻の確認まで行い、どれかが失敗したら例外にする（成功扱いにしない）。
 *  - mode "production": Firestore の時刻から readTime を決め、すべてのリクエストに同じ readTime を付ける（必須。外せない）。
 *  - mode "emulator": Emulator は readTime に対応していないため付けない（consistency: "none" と記録する）。
 *  - 件数の照合：トップレベルの各コレクションについて、同じ readTime の件数の集計（1,000件ごとに読み取り1回）と、
 *    書き出したドキュメント（親だけのドキュメントを除く）の数を比べる。サブコレクションは照合しない（読み取りを増やさないため）。
 *    照合は readTime の代わりではなく、取りこぼしを見つけるための補助の検査。
 */
export async function createConsistentExport(o: {
  mode: "production" | "emulator";
  /** readTime を付けた（emulator では付けない）読み取りクライアントを作る */
  makeReader: (readTime: string | undefined) => BackupReader;
  projectId: string;
  databaseId?: string;
  /** 経過時間・期限の計測に使う単調時計（既定は performance.now()）。読み取りクライアントにも同じ時計を渡すこと */
  monotonic?: () => number;
  /** 実際の日時（壁時計。既定は Date.now）。createdAt（ファイル名）だけに使い、期限・整合性の判定には使わない */
  wallClock?: () => number;
  onProgress?: (p: ExportProgress) => void;
  onReadTime?: (d: { readTime: string | null; skewMs: number | null }) => void;
}): Promise<ConsistentExportResult> {
  const now = o.monotonic ?? (() => performance.now());
  const wall = o.wallClock ?? Date.now;
  let decision: ReadTimeDecision | null = null;
  let startProbe: ServerTimeProbe | null = null;
  let reader: BackupReader;
  // 時刻確認は readTime を付けないクライアントで行う（このときはまだ時点が決まっていない）
  const probeReader = o.mode === "production" ? o.makeReader(undefined) : null;
  if (o.mode === "production") {
    startProbe = await probeReader!.probeServerTime();
    decision = decideReadTime(startProbe);
    reader = o.makeReader(decision.readTime);
    if (reader.readTime !== decision.readTime) throw new BackupConsistencyError("読み取りの時点（readTime）を読み取りに設定できませんでした。開始しませんでした。");
  } else {
    reader = o.makeReader(undefined);
    if (reader.readTime !== undefined) throw new BackupConsistencyError("Emulator では読み取りの時点（readTime）を使いません。");
  }
  o.onReadTime?.({ readTime: decision?.readTime ?? null, skewMs: decision?.skewMs ?? null });
  const startedAt = now();
  const deadline = decision?.deadline ?? startedAt + READ_BUDGET_MS;
  const expired = () => new BackupConsistencyError("読み取りに時間がかかりすぎたため中断しました（readTime の有効期限1時間に間に合わない可能性）。バックアップは作成していません。もう一度実行してください。");

  const result = await exportAll(reader as FirestoreReadOnlyReader, { projectId: o.projectId, databaseId: o.databaseId ?? "(default)", readTime: decision?.readTime ?? null, createdAt: new Date(wall()).toISOString() }, { deadline, onProgress: o.onProgress, now });
  if (now() > deadline) throw expired();

  // 件数の照合（同じ readTime）
  const exported: Record<string, number> = {};
  for (const d of result.docs) if (!d.missing && !d.c.includes("/")) exported[d.c] = (exported[d.c] ?? 0) + 1;
  const countedRoots: Record<string, number> = {};
  const mismatched: string[] = [];
  for (const id of Object.keys(result.rootCounts).sort()) {
    if (now() > deadline) throw expired();
    countedRoots[id] = await reader.countCollection(id);
    if (countedRoots[id] !== (exported[id] ?? 0)) mismatched.push(`${id}（集計 ${countedRoots[id]}件・書き出し ${exported[id] ?? 0}件）`);
  }
  if (mismatched.length) throw new BackupConsistencyError(`件数の照合で一致しないコレクションがあります: ${mismatched.join("、")}。バックアップは作成していません。もう一度実行してください。続く場合は報告してください。`);

  const end = now();
  if (end > deadline) throw expired();
  if (decision) {
    // 終了時の時刻確認（読み取り1回）：単調時計の経過時間が Firestore の時刻の進みと合っているか（スリープ対策）と有効期限
    checkEndTime(decision, startProbe!, await probeReader!.probeServerTime());
    if (now() > deadline) throw expired();
  }
  result.header.consistency = decision ? "read_time" : "none";
  // 本番：Firestore の時刻（開始時の Date ヘッダー）＋ 単調時計の経過時間。Emulator：壁時計（参考の記録）
  result.header.finishedAt = new Date(decision ? decision.toServerTime(end) : wall()).toISOString();
  result.header.countCheck = "root_collections";
  if (decision) {
    // 記録する前に、終了時刻と readTime の関係を確かめる（検証ツールでも同じ確認をする）
    const age = Date.parse(result.header.finishedAt) - Date.parse(decision.readTime);
    if (age < 0 || age >= HOUR_MS) throw expired();
  }
  return { ...result, reader, countedRoots };
}

/**
 * 暗号化済みのバックアップと説明ファイルを、途中の状態を残さずに書き出す。
 * まず「.partial」の名前で書き、verify（読み戻しての確認）が通ってから正式な名前に変える。
 * 失敗したときは .partial を消し、正式な名前のファイルは作らない。
 */
export function writeBackupFilesAtomically(o: { file: string; manifestFile: string; encrypted: Buffer; manifestText: string; verify: (partialFile: string) => void }) {
  const tmp = `${o.file}.partial`;
  const tmpManifest = `${o.manifestFile}.partial`;
  if (existsSync(o.file) || existsSync(o.manifestFile)) throw new Error("同じ名前のバックアップがすでにあります。1秒以上待ってから、もう一度実行してください。");
  try {
    writeFileSync(tmp, o.encrypted, { mode: 0o600 });
    writeFileSync(tmpManifest, o.manifestText, { mode: 0o600 });
    o.verify(tmp);
    renameSync(tmp, o.file);
    renameSync(tmpManifest, o.manifestFile);
  } catch (e) {
    rmSync(tmp, { force: true });
    rmSync(tmpManifest, { force: true });
    // 本体だけ正式な名前になった直後に失敗した場合も、成功に見えないよう本体を消す
    if (existsSync(o.file) && !existsSync(o.manifestFile)) rmSync(o.file, { force: true });
    throw e;
  }
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
  /** 以下は 2026-11 に追加（無い旧形式も読める） */
  consistency?: BackupConsistency;
  finishedAt?: string;
  countCheck?: BackupCountCheck;
};
