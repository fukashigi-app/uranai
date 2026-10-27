import { spawn } from "node:child_process";
import { createServer, type Server } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrationDecision } from "@/lib/db/migration-guard";

// PostgreSQL のマイグレーション（scripts/migrate.ts。Vercel のビルドの vercel-build でも実行される）を、
// Vercel の Preview では DATABASE_URL があっても実行しないこと。本物のデータベースには接続しない
// （接続先はこのテストが localhost に開く TCP の受け口だけ。接続が来たかどうかで、マイグレーションを始めたかを確かめる）
const PROD_LIKE_URL = "postgres://prod_user:PROD_SECRET_PASSWORD@db.production.example.com:5432/uranai?sslmode=require";

describe("マイグレーションを実行してよいか（判定）", () => {
  it("Vercel の Preview では、本番の DATABASE_URL が誤って登録されていても実行しない", () => {
    expect(migrationDecision({ VERCEL_ENV: "preview", DATABASE_URL: PROD_LIKE_URL })).toEqual({ run: false, reason: "vercel_preview" });
    expect(migrationDecision({ VERCEL_ENV: " Preview ", DATABASE_URL: PROD_LIKE_URL })).toEqual({ run: false, reason: "vercel_preview" });
    expect(migrationDecision({ VERCEL_ENV: "preview" })).toEqual({ run: false, reason: "vercel_preview" });
  });

  it("Preview 以外は以前どおり（DATABASE_URL があれば実行、無ければスキップ）", () => {
    expect(migrationDecision({ VERCEL_ENV: "production", DATABASE_URL: PROD_LIKE_URL })).toEqual({ run: true });
    expect(migrationDecision({ DATABASE_URL: "postgres://postgres@localhost:5432/uranai" })).toEqual({ run: true }); // ローカルの開発
    expect(migrationDecision({ VERCEL_ENV: "development", DATABASE_URL: "postgres://x@localhost/db" })).toEqual({ run: true });
    expect(migrationDecision({ VERCEL_ENV: "production" })).toEqual({ run: false, reason: "no_database_url" });
    expect(migrationDecision({})).toEqual({ run: false, reason: "no_database_url" });
    expect(migrationDecision({ DATABASE_URL: "" })).toEqual({ run: false, reason: "no_database_url" });
  });
});

describe("scripts/migrate.ts を実際に実行（localhost の受け口で、データベースへの接続の有無を確かめる）", () => {
  let server: Server;
  let port = 0;
  let connections = 0;
  beforeAll(async () => {
    server = createServer((sock) => {
      connections++;
      sock.destroy(); // PostgreSQL ではないので、すぐに切る（実行した場合はマイグレーションが接続エラーで失敗する）
    });
    await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
    port = (server.address() as { port: number }).port;
  });
  afterAll(() => new Promise<void>((ok) => server.close(() => ok())));

  function run(env: Record<string, string>): Promise<{ code: number | null; out: string }> {
    return new Promise((resolve) => {
      const base = { ...process.env };
      for (const k of ["VERCEL_ENV", "DATABASE_URL", "VERCEL", "VERCEL_URL"]) delete base[k];
      const child = spawn("node_modules/.bin/tsx", ["scripts/migrate.ts"], { env: { ...base, ...env }, stdio: ["ignore", "pipe", "pipe"] });
      let out = "";
      child.stdout.on("data", (d) => (out += d));
      child.stderr.on("data", (d) => (out += d));
      const t = setTimeout(() => child.kill("SIGKILL"), 60_000);
      child.on("exit", (code) => {
        clearTimeout(t);
        resolve({ code, out });
      });
    });
  }
  const url = (pass: string) => `postgres://prod_user:${pass}@127.0.0.1:${port}/uranai`;

  it("Preview：本番らしい DATABASE_URL があっても接続せずにスキップする（理由だけをログに出し、接続先・パスワードは出さない）", async () => {
    const before = connections;
    const r = await run({ VERCEL_ENV: "preview", DATABASE_URL: url("PREVIEW_MUST_NOT_LEAK_PASSWORD") });
    expect(r.code).toBe(0);
    expect(connections).toBe(before);
    expect(r.out).toContain("[migrate] Vercel Preview (VERCEL_ENV=preview); skipping migrations");
    expect(r.out).not.toContain("PREVIEW_MUST_NOT_LEAK_PASSWORD");
    expect(r.out).not.toContain("prod_user");
    expect(r.out).not.toContain(`127.0.0.1:${port}`);
  }, 90_000);

  it("本番（VERCEL_ENV=production）：以前どおりマイグレーションを始める（接続する）", async () => {
    const before = connections;
    const r = await run({ VERCEL_ENV: "production", DATABASE_URL: url("x") });
    expect(connections).toBeGreaterThan(before);
    expect(r.code).toBe(1); // 受け口は PostgreSQL ではないので失敗する（実行を始めたことの確認）
  }, 90_000);

  it("ローカルの開発（VERCEL_ENV なし）：以前どおりマイグレーションを始める", async () => {
    const before = connections;
    await run({ DATABASE_URL: url("x") });
    expect(connections).toBeGreaterThan(before);
  }, 90_000);

  it("DATABASE_URL が無ければ、以前どおりスキップする", async () => {
    const before = connections;
    const r = await run({ DATABASE_URL: "" });
    expect(r.code).toBe(0);
    expect(connections).toBe(before);
    expect(r.out).toContain("[migrate] DATABASE_URL is not set; skipping migrations");
  }, 90_000);
});
