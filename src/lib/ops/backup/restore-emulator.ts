/**
 * バックアップを Firestore Emulator にだけ復元する（復元テスト用）。本番への復元処理は作らない。
 *
 * 次のすべてを満たさないと、1件も書き込まずに停止する。
 *  - 接続先のホストが localhost / 127.0.0.1 / ::1（パソコンの中の Emulator）
 *  - 環境変数 FIRESTORE_EMULATOR_HOST が設定され、接続先と同じ
 *  - 復元先のプロジェクトIDが demo- で始まる（Emulator 専用の ID。本番のプロジェクトには使えない）
 * 値は Firestore の型付き JSON のまま書き戻すので、型・ドキュメントIDが元と同じになる。
 */
import type { BackupDoc } from "./archive";

export class UnsafeRestoreTargetError extends Error {
  constructor(reason: string) {
    super(`復元を中止しました: ${reason}（復元できるのは Firestore Emulator の demo- プロジェクトだけです）`);
    this.name = "UnsafeRestoreTargetError";
  }
}

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

export function assertEmulatorTarget(target: { emulatorHost: string | undefined; projectId: string }, env: Record<string, string | undefined> = process.env): string {
  const host = target.emulatorHost?.trim();
  if (!host) throw new UnsafeRestoreTargetError("Emulator の接続先が指定されていません");
  if (!env.FIRESTORE_EMULATOR_HOST || env.FIRESTORE_EMULATOR_HOST.trim() !== host) throw new UnsafeRestoreTargetError("FIRESTORE_EMULATOR_HOST が設定されていないか、接続先と一致しません");
  let url: URL;
  try {
    url = new URL(`http://${host}`);
  } catch {
    throw new UnsafeRestoreTargetError("接続先の形式が正しくありません");
  }
  if (!LOCAL_HOSTS.has(url.hostname)) throw new UnsafeRestoreTargetError("接続先がこのパソコンの中（localhost）ではありません");
  if (!/^demo-[a-z0-9-]+$/.test(target.projectId)) throw new UnsafeRestoreTargetError("復元先のプロジェクトIDが demo- で始まっていません");
  return `http://${url.host}`;
}

const REF_PREFIX = /^projects\/[^/]+\/databases\/[^/]+\/documents\//;

/**
 * ドキュメントへの参照（referenceValue）は「projects/<プロジェクト>/…」の形で保存されている。
 * 別のプロジェクトへ復元するときは、参照先を復元先のプロジェクトに付け替える（参照しているパスは同じ）。
 */
export function rewriteReferences(value: unknown, toRoot: string): unknown {
  if (Array.isArray(value)) return value.map((v) => rewriteReferences(v, toRoot));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = k === "referenceValue" && typeof v === "string" && REF_PREFIX.test(v) ? v.replace(REF_PREFIX, `${toRoot}/`) : rewriteReferences(v, toRoot);
    }
    return out;
  }
  return value;
}

export async function restoreToEmulator(
  docs: BackupDoc[],
  target: { emulatorHost: string | undefined; projectId: string },
  opts: { batchSize?: number; fetchImpl?: typeof fetch } = {},
): Promise<{ written: number; skippedMissing: number }> {
  const base = assertEmulatorTarget(target);
  const f = opts.fetchImpl ?? fetch;
  const root = `projects/${target.projectId}/databases/(default)/documents`;
  const writable = docs.filter((d) => !d.missing);
  const size = opts.batchSize ?? 200;
  for (let i = 0; i < writable.length; i += size) {
    const writes = writable.slice(i, i + size).map((d) => ({ update: { name: `${root}/${d.p}`, fields: rewriteReferences(d.f ?? {}, root) } }));
    const res = await f(`${base}/v1/${root.split("/").map(encodeURIComponent).join("/")}:commit`, {
      method: "POST",
      headers: { Authorization: "Bearer owner", "content-type": "application/json" },
      body: JSON.stringify({ writes }),
    });
    if (!res.ok) throw new Error(`Emulator への書き込みに失敗しました（HTTP ${res.status}）`);
  }
  return { written: writable.length, skippedMissing: docs.length - writable.length };
}
