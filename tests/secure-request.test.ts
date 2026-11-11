/**
 * isSecureRequest（無料の占いの Cookie の Secure 属性。lib/services/test-store.ts）。
 *  - TRUSTED_ORIGIN_SOURCE=app-url（Cloud Run 用）：検証済みの APP_URL だけで判定し、X-Forwarded-Proto・リクエストの URL を使わない
 *  - 未設定（Vercel）：従来どおり X-Forwarded-Proto の先頭 → 無ければリクエストの URL
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isSecureRequest } from "@/lib/services/test-store";

const APP = "https://uranai-sandbox-123456789012.asia-northeast1.run.app";
const KEYS = ["TRUSTED_ORIGIN_SOURCE", "APP_URL", "VERCEL_ENV", "VERCEL_PROJECT_PRODUCTION_URL", "VERCEL_URL", "VERCEL_BRANCH_URL"] as const;
const saved: Record<string, string | undefined> = {};
beforeEach(() => {
  for (const k of KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
});
afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

const req = (url: string, headers: Record<string, string> = {}) => new Request(url, { method: "POST", headers });

/** 変更前の isSecureRequest（比較用にそのまま写したもの） */
const legacy = (r: Request) => (r.headers.get("x-forwarded-proto")?.split(",")[0]?.trim() ?? new URL(r.url).protocol.replace(":", "")) === "https";

describe("TRUSTED_ORIGIN_SOURCE=app-url：APP_URL だけで判定する", () => {
  beforeEach(() => {
    process.env.TRUSTED_ORIGIN_SOURCE = "app-url";
    process.env.APP_URL = APP;
  });

  it("1. X-Forwarded-Proto があっても使わない（http と偽っても、https を名乗っても Secure）", () => {
    for (const p of ["http", "https", "http, https", "javascript", ""]) {
      expect(isSecureRequest(req("http://127.0.0.1:8080/api/fortune", { "x-forwarded-proto": p })), p).toBe(true);
    }
  });

  it("2. ヘッダーが無く、コンテナが受けたリクエストの URL が http でも Secure", () => {
    expect(isSecureRequest(req("http://127.0.0.1:8080/api/fortune"))).toBe(true);
    expect(isSecureRequest(req(`${APP}/api/fortune`))).toBe(true);
  });

  it("3. APP_URL が未設定・不正なら例外（http として扱わない）", () => {
    for (const u of [undefined, "", "not a url", "https://", `${APP}/path`, "https://user:pass@uranai.example.jp"]) {
      if (u === undefined) delete process.env.APP_URL;
      else process.env.APP_URL = u;
      expect(() => isSecureRequest(req("https://uranai.example.jp/api/fortune", { "x-forwarded-proto": "https" })), String(u)).toThrow(/Trusted origin is misconfigured/);
    }
  });

  it("4. APP_URL が http なら例外（http として扱わない）", () => {
    process.env.APP_URL = "http://uranai-sandbox.example";
    expect(() => isSecureRequest(req("http://uranai-sandbox.example/api/fortune", { "x-forwarded-proto": "http" }))).toThrow(/Trusted origin is misconfigured/);
  });

  it("想定外の TRUSTED_ORIGIN_SOURCE も例外（従来の判定に黙って戻さない）", () => {
    process.env.TRUSTED_ORIGIN_SOURCE = "APP-URL";
    expect(() => isSecureRequest(req("https://x.example/", { "x-forwarded-proto": "https" }))).toThrow(/Trusted origin is misconfigured/);
  });
});

describe("未設定（Vercel）：変更前と同じ結果", () => {
  it("5. X-Forwarded-Proto: https → Secure（リクエストの URL が http でも）", () => {
    const r = req("http://localhost:3000/api/fortune", { "x-forwarded-proto": "https" });
    expect(isSecureRequest(r)).toBe(true);
    expect(isSecureRequest(r)).toBe(legacy(r));
  });

  it("6. X-Forwarded-Proto: http → Secure なし（リクエストの URL が https でも）。カンマ区切りは先頭を使う", () => {
    for (const [p, want] of [["http", false], ["http, https", false], ["https, http", true], [" https ", true], ["HTTPS", false]] as const) {
      const r = req("https://uranai.vercel.app/api/fortune", { "x-forwarded-proto": p });
      expect(isSecureRequest(r), p).toBe(want);
      expect(isSecureRequest(r), p).toBe(legacy(r));
    }
  });

  it("7. ヘッダーが無い → リクエストの URL のプロトコル", () => {
    for (const [u, want] of [["https://uranai.vercel.app/api/fortune", true], ["http://localhost:3000/api/fortune", false]] as const) {
      const r = req(u);
      expect(isSecureRequest(r), u).toBe(want);
      expect(isSecureRequest(r), u).toBe(legacy(r));
    }
  });

  it("空の TRUSTED_ORIGIN_SOURCE も未設定と同じ（APP_URL を見ない）", () => {
    process.env.TRUSTED_ORIGIN_SOURCE = "  ";
    process.env.APP_URL = "not a url";
    const r = req("http://localhost:3000/api/fortune", { "x-forwarded-proto": "https" });
    expect(isSecureRequest(r)).toBe(legacy(r));
  });
});
