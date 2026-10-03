import { afterEach, describe, expect, it } from "vitest";
import { checkSetupToken, parseSetupInput, setupTokenRequired } from "@/lib/auth/setup-input";

function form(v: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, val] of Object.entries(v)) fd.set(k, val);
  return fd;
}

const valid = { name: "", email: " Owner@Example.com ", password: "Abcdefgh12", passwordConfirm: "Abcdefgh12", token: "" };

describe("初回の運営アカウント作成: 入力チェック", () => {
  it("正しい入力を受け付け、メールは小文字化・名前は既定値", () => {
    const r = parseSetupInput(form(valid));
    expect(r).toEqual({ ok: true, data: { name: "運営管理者", email: "owner@example.com", password: "Abcdefgh12", token: "" } });
  });

  it("既存のパスワードルール（10文字以上・英字と数字）を適用する", () => {
    for (const pw of ["short1A", "abcdefghijk", "12345678901"]) {
      const r = parseSetupInput(form({ ...valid, password: pw, passwordConfirm: pw }));
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.errors.password).toBeTruthy();
    }
  });

  it("確認用パスワードの不一致・不正なメールを拒否する", () => {
    const a = parseSetupInput(form({ ...valid, passwordConfirm: "Abcdefgh13" }));
    expect(!a.ok && a.errors.passwordConfirm).toBeTruthy();
    const b = parseSetupInput(form({ ...valid, email: "not-an-email" }));
    expect(!b.ok && b.errors.email).toBeTruthy();
  });

  it("項目が欠けていても例外にならない", () => {
    expect(parseSetupInput(new FormData()).ok).toBe(false);
  });
});

describe("セットアップキー（ADMIN_SETUP_TOKEN）", () => {
  afterEach(() => {
    delete process.env.ADMIN_SETUP_TOKEN;
  });

  it("未設定なら不要", () => {
    expect(setupTokenRequired()).toBe(false);
    expect(checkSetupToken("")).toBe(true);
  });

  it("設定時は一致した場合だけ通す", () => {
    process.env.ADMIN_SETUP_TOKEN = "s3cret-setup-key";
    expect(setupTokenRequired()).toBe(true);
    expect(checkSetupToken("s3cret-setup-key")).toBe(true);
    expect(checkSetupToken(" s3cret-setup-key ")).toBe(true);
    expect(checkSetupToken("wrong")).toBe(false);
    expect(checkSetupToken("")).toBe(false);
  });
});
