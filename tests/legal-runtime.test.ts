/**
 * 法務・運営者情報のページ（特定商取引法に基づく表記・利用規約・プライバシーポリシー）の Cloud Run 対応。
 *  - 運営者情報（OPERATOR_*）を実行時の環境変数から読み、ビルド時の値で静的なページに固定しない（force-dynamic）
 *  - 未設定・仮の値・形式の誤りは従来どおり（表示に使わず、既定の屋号・問い合わせ先と請求時開示の表示）
 *  - Firestore に接続しない
 * 値はすべて架空のテスト用（実在の個人情報ではない）。応答・ログには値を出さない。
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({ calls: 0 }));
vi.mock("@/lib/firestore/admin", async (orig) => ({
  ...(await orig<typeof import("@/lib/firestore/admin")>()),
  fsdb: () => {
    db.calls++;
    throw new Error("Firestore must not be used by legal pages");
  },
}));

const OP_KEYS = ["OPERATOR_TRADE_NAME", "OPERATOR_EMAIL", "OPERATOR_OWNER_NAME", "OPERATOR_ADDRESS", "OPERATOR_PHONE", "NEXT_PUBLIC_OPERATOR_NAME", "NEXT_PUBLIC_OPERATOR_EMAIL", "NEXT_PUBLIC_OPERATOR_REPRESENTATIVE", "NEXT_PUBLIC_OPERATOR_ADDRESS", "NEXT_PUBLIC_OPERATOR_PHONE"];
const saved: Record<string, string | undefined> = {};
beforeEach(() => {
  for (const k of OP_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  db.calls = 0;
});
afterEach(() => {
  for (const k of OP_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

const PAGES = [
  ["/commercial-transaction", () => import("@/app/commercial-transaction/page")],
  ["/terms", () => import("@/app/terms/page")],
  ["/privacy", () => import("@/app/privacy/page")],
] as const;

const A = { OPERATOR_TRADE_NAME: "テスト屋号アルファ", OPERATOR_EMAIL: "alpha@koyomi-unit-test.invalid" };
const B = { OPERATOR_TRADE_NAME: "テスト屋号ベータ", OPERATOR_EMAIL: "beta@koyomi-unit-test.invalid" };

async function render(load: (typeof PAGES)[number][1]) {
  const mod = await load();
  return renderToStaticMarkup(createElement(mod.default));
}

describe("実行時の生成（ビルド時の値に固定しない）", () => {
  it("3ページとも force-dynamic（ビルドで静的なページにしない・キャッシュした古い表示を出さない）", async () => {
    for (const [path, load] of PAGES) expect((await load()).dynamic, path).toBe("force-dynamic");
  });

  it("実行時の OPERATOR_* が反映され、値を変えれば次の表示から変わる（読み込み時の値を保持しない）", async () => {
    const { OPERATOR_DEFAULTS } = await import("@/config/operator");
    for (const [path, load] of PAGES) {
      Object.assign(process.env, A);
      const first = await render(load);
      expect(first, path).toContain(A.OPERATOR_TRADE_NAME);
      Object.assign(process.env, B);
      const second = await render(load);
      expect(second, path).toContain(B.OPERATOR_TRADE_NAME);
      expect(second, path).not.toContain(A.OPERATOR_TRADE_NAME);
      for (const k of OP_KEYS) delete process.env[k];
      const third = await render(load);
      expect(third, path).toContain(OPERATOR_DEFAULTS.tradeName);
      expect(third, path).not.toContain(B.OPERATOR_TRADE_NAME);
    }
  });

  it("特商法の表記：問い合わせ先は実行時の値。氏名・所在地・電話番号は実行時に設定されていても表示しない（架空の値で確認）", async () => {
    Object.assign(process.env, A, { OPERATOR_OWNER_NAME: "試験 太郎", OPERATOR_ADDRESS: "架空県テスト市1-2-3", OPERATOR_PHONE: "000-0000-0000" });
    for (const [path, load] of PAGES) {
      const html = await render(load);
      for (const v of ["試験 太郎", "架空県テスト市1-2-3", "000-0000-0000"]) expect(html, `${path} ${v}`).not.toContain(v);
    }
    const html = await render(PAGES[0][1]);
    expect(html).toContain(A.OPERATOR_EMAIL);
    expect(html).toContain("表示を省略しております");
  });
});

describe("未設定・不正な値（従来どおり）", () => {
  it("未設定：既定の屋号・問い合わせ先を表示し、氏名・所在地・電話番号は請求時開示の表示", async () => {
    const { OPERATOR_DEFAULTS } = await import("@/config/operator");
    const html = await render(PAGES[0][1]);
    expect(html).toContain(OPERATOR_DEFAULTS.tradeName);
    expect(html).toContain(OPERATOR_DEFAULTS.email);
    expect(html).toMatch(/請求/);
  });

  it("仮の値・形式の誤りは表示に使わない（既定の値を表示する）", async () => {
    const { OPERATOR_DEFAULTS } = await import("@/config/operator");
    Object.assign(process.env, { OPERATOR_TRADE_NAME: "【屋号を設定してください】", OPERATOR_EMAIL: "info@example.com", OPERATOR_PHONE: "電話番号" });
    for (const [path, load] of PAGES) {
      const html = await render(load);
      expect(html, path).not.toContain("屋号を設定してください");
      expect(html, path).not.toContain("info@example.com");
      expect(html, path).toContain(OPERATOR_DEFAULTS.tradeName);
    }
  });
});

describe("Firestore に接続しない", () => {
  it("3ページの表示で Firestore を使わない", async () => {
    Object.assign(process.env, A);
    for (const [, load] of PAGES) await render(load);
    expect(db.calls).toBe(0);
  });
});
