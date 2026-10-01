import type { PoolConfig } from "pg";

/**
 * 接続設定。ローカル以外（Neon / Supabase / Vercel Postgres など）は TLS 接続にする。
 * pg の新しい版は URL の sslmode=require を証明書の完全検証として扱い、プーラー経由で失敗することがあるため、
 * sslmode は URL から外して ssl オプションで明示する。
 */
export function poolConfig(url: string, max = 5): PoolConfig {
  const u = new URL(url);
  const local = ["localhost", "127.0.0.1", "::1", ""].includes(u.hostname) || u.searchParams.get("sslmode") === "disable";
  u.searchParams.delete("sslmode");
  return {
    connectionString: u.toString(),
    max,
    ssl: local ? undefined : { rejectUnauthorized: false },
  };
}
