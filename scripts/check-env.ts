/**
 * 本番の環境変数の「形式」を確認する（値は一切表示しない）。
 *
 *   1) vercel env pull .env.production.check --environment=production   （あなたのパソコンで実行）
 *   2) npm run check:env                       … 形式だけを確認（ネットワーク接続なし）
 *      npm run check:env -- --ping             … さらに本番 Firestore に「読み取りだけ」で接続できるか確認
 *      npm run check:env -- path/to/file       … 別のファイルを確認
 *   3) 終わったら .env.production.check を削除する
 *
 * 表示するのは変数名と判定・説明だけ。秘密鍵・パスワードなどの値は表示しない。
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { parse } from "dotenv";
import { checkProductionEnv, summarize, type CheckResult } from "../src/lib/ops/env-check";

const MARK: Record<CheckResult["level"], string> = { ok: "✔", warn: "⚠", error: "✘", unknown: "？" };

function isGitIgnored(path: string): boolean {
  try {
    execFileSync("git", ["check-ignore", "-q", path], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/** 本番 Firestore に読み取りだけで接続できるか（コレクション一覧を取得するだけ。書き込みはしない） */
async function ping(env: Record<string, string>): Promise<string> {
  const { cert, initializeApp, deleteApp } = await import("firebase-admin/app");
  const { getFirestore } = await import("firebase-admin/firestore");
  const { normalizePrivateKey } = await import("../src/lib/firestore/private-key");
  const app = initializeApp(
    { credential: cert({ projectId: env.FIREBASE_PROJECT_ID, clientEmail: env.FIREBASE_CLIENT_EMAIL, privateKey: normalizePrivateKey(env.FIREBASE_PRIVATE_KEY ?? "") }), projectId: env.FIREBASE_PROJECT_ID },
    `check-env-${Date.now()}`,
  );
  try {
    const cols = await Promise.race([
      getFirestore(app).listCollections(),
      new Promise<never>((_, rej) => setTimeout(() => rej(Object.assign(new Error("timeout"), { code: "timeout" })), 20_000)),
    ]);
    return `✔ 本番 Firestore に読み取りで接続できました（トップレベルのコレクション数: ${cols.length}）`;
  } catch (e) {
    const code = (e as { code?: unknown }).code ?? (e as Error).name;
    return `✘ 本番 Firestore に接続できませんでした（エラーの種類: ${String(code)}）。秘密鍵・メールアドレス・プロジェクトIDの組み合わせを確認してください。`;
  } finally {
    await deleteApp(app).catch(() => {});
  }
}

async function main() {
  const args = process.argv.slice(2);
  const file = args.find((a) => !a.startsWith("--")) ?? ".env.production.check";
  if (!existsSync(file)) {
    console.error(`ファイルが見つかりません: ${file}\n先に「vercel env pull ${file} --environment=production」を実行してください。`);
    process.exit(2);
  }
  if (!isGitIgnored(file)) {
    console.error(`このファイルは Git の管理対象外（.gitignore）になっていません。秘密の値を GitHub に上げないよう、.env で始まる名前にするか .gitignore に追加してから実行してください: ${file}`);
    process.exit(2);
  }
  const env = parse(readFileSync(file));
  const results = checkProductionEnv(env);
  console.log(`本番の環境変数の確認（${Object.keys(env).length}件の変数を読み込みました。値は表示しません）\n`);
  for (const x of results) console.log(`${MARK[x.level]} ${x.key}: ${x.message}`);
  const s = summarize(results);
  console.log(`\n結果: 正常 ${s.ok}・注意 ${s.warn}・エラー ${s.error}・確認できない ${s.unknown}`);
  if (args.includes("--ping")) {
    if (s.error && results.some((x) => x.key.startsWith("FIREBASE_") && x.level === "error")) console.log("\nFirebase の設定にエラーがあるため、接続確認は行いません。");
    else console.log(`\n${await ping(env)}`);
  }
  console.log(`\n確認が終わったら ${file} を削除してください（秘密の値が含まれています）。`);
  process.exit(s.error ? 1 : 0);
}

main().catch((e) => {
  // 値を含む可能性のある詳細は出さない
  console.error("確認中にエラーが発生しました:", (e as Error).name);
  process.exit(2);
});
