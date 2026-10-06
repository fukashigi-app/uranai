import { afterEach, describe, expect, it, vi } from "vitest";
import { isFortunePreviewEnabled } from "@/lib/fortune/preview";

describe("開発用プレビューの公開範囲", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("本番（Vercel Production）では設定に関係なく使えない", () => {
    vi.stubEnv("VERCEL_ENV", "production");
    vi.stubEnv("ENABLE_FORTUNE_PREVIEW", "true");
    vi.stubEnv("NODE_ENV", "development");
    expect(isFortunePreviewEnabled()).toBe(false);
  });

  it("本番相当（NODE_ENV=production・Vercel外）でも使えない", () => {
    vi.stubEnv("VERCEL_ENV", "");
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("ENABLE_FORTUNE_PREVIEW", "true");
    expect(isFortunePreviewEnabled()).toBe(false);
  });

  it("Vercel のプレビュー環境は ENABLE_FORTUNE_PREVIEW=true のときだけ", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("VERCEL_ENV", "preview");
    vi.stubEnv("ENABLE_FORTUNE_PREVIEW", "");
    expect(isFortunePreviewEnabled()).toBe(false);
    vi.stubEnv("ENABLE_FORTUNE_PREVIEW", "true");
    expect(isFortunePreviewEnabled()).toBe(true);
  });

  it("手元の開発環境（npm run dev）では使える", () => {
    vi.stubEnv("VERCEL_ENV", "");
    vi.stubEnv("NODE_ENV", "development");
    expect(isFortunePreviewEnabled()).toBe(true);
  });
});
