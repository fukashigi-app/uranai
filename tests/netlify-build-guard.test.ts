/**
 * Netlify のビルドでの、本番と Sandbox の環境変数の取り違えの検出（lib/ops/netlify-build-guard.ts・next.config.ts）。
 *  - 正しい本番・Sandbox の設定だけ通す。取り違え・想定外の CONTEXT／ブランチ・VERCEL_ENV の誤りは停止
 *  - Netlify 以外（Vercel・Cloud Run・ローカル）は従来どおり何もしない。CONTEXT だけでは Netlify とみなさず、すり抜けもさせない
 *  - エラーに値（秘密・ブランチ名・プロジェクトID）を含めない
 * 外部には接続しない。キーはすべて短い仮の値。
 */
import { PHASE_DEVELOPMENT_SERVER, PHASE_PRODUCTION_BUILD, PHASE_PRODUCTION_SERVER } from "next/constants";
import { describe, expect, it } from "vitest";
import { assertNetlifyBuildEnv, checkNetlifyBuildEnv, type NetlifyBuildIssue } from "@/lib/ops/netlify-build-guard";

type Env = Record<string, string | undefined>;

const PROD: Env = {
  NETLIFY: "true",
  CONTEXT: "production",
  BRANCH: "netlify/production",
  VERCEL_ENV: "production",
  FIREBASE_PROJECT_ID: "uranai-b6edf",
  PRODUCTION_FIREBASE_PROJECT_ID: "uranai-b6edf",
  SITE_STATUS: "development",
  STRIPE_NEW_CHECKOUT: "off",
};
const SANDBOX: Env = {
  NETLIFY: "true",
  CONTEXT: "branch-deploy",
  BRANCH: "netlify/sandbox",
  VERCEL_ENV: "preview",
  VERCEL_GIT_COMMIT_REF: "preview/stripe-sandbox-v2",
  FIREBASE_PROJECT_ID: "uranai-stripe-sandbox-v2",
  PRODUCTION_FIREBASE_PROJECT_ID: "uranai-b6edf",
  STRIPE_SECRET_KEY: "sk_test_x-unit-dummy",
  SITE_STATUS: "development",
};

const issuesOf = (e: Env): NetlifyBuildIssue[] => {
  const r = checkNetlifyBuildEnv(e);
  return r.kind === "blocked" ? r.issues : [];
};
const expectBlocked = (e: Env, issue: NetlifyBuildIssue) => {
  const r = checkNetlifyBuildEnv(e);
  expect(r.kind, JSON.stringify(Object.keys(e))).toBe("blocked");
  expect(issuesOf(e)).toContain(issue);
};

describe("正しい設定は通す", () => {
  it("本番：Live のキーがまだ無くても、開発モードなら通す", () => {
    expect(checkNetlifyBuildEnv(PROD)).toEqual({ kind: "ok", target: "production" });
  });
  it("本番：Live のキーがあれば、公開中（open）でも通す", () => {
    expect(checkNetlifyBuildEnv({ ...PROD, STRIPE_SECRET_KEY: "sk_live_x-unit-dummy", SITE_STATUS: "open", STRIPE_LIVE_CHECKOUT: "on" })).toEqual({ kind: "ok", target: "production" });
    expect(checkNetlifyBuildEnv({ ...PROD, STRIPE_SECRET_KEY: "rk_live_x-unit-dummy" }).kind).toBe("ok");
  });
  it("Sandbox：テスト用のキーでも、キー無しでも通す", () => {
    expect(checkNetlifyBuildEnv(SANDBOX)).toEqual({ kind: "ok", target: "sandbox" });
    expect(checkNetlifyBuildEnv({ ...SANDBOX, STRIPE_SECRET_KEY: undefined }).kind).toBe("ok");
  });
  it("assertNetlifyBuildEnv は正しい設定では例外を出さない", () => {
    expect(() => assertNetlifyBuildEnv(PROD)).not.toThrow();
    expect(() => assertNetlifyBuildEnv(SANDBOX)).not.toThrow();
  });
});

describe("本番と Sandbox の取り違え", () => {
  it("本番の CONTEXT に Sandbox の値一式：停止", () => {
    const e = { ...SANDBOX, CONTEXT: "production" };
    expect(issuesOf(e)).toEqual(expect.arrayContaining(["context_branch_mismatch", "vercel_env_unexpected", "firebase_project_is_sandbox", "stripe_test_key_in_production"]));
  });
  it("Sandbox の CONTEXT に本番の値一式：停止", () => {
    const e = { ...PROD, CONTEXT: "branch-deploy", STRIPE_SECRET_KEY: "sk_live_x-unit-dummy", STRIPE_LIVE_CHECKOUT: "on" };
    expect(issuesOf(e)).toEqual(expect.arrayContaining(["context_branch_mismatch", "vercel_env_unexpected", "firebase_project_is_production", "stripe_live_key_in_sandbox", "stripe_live_checkout_in_sandbox"]));
  });
  it("本番：Sandbox 用・旧 Preview 用・その他の Firebase プロジェクト、PRODUCTION_FIREBASE_PROJECT_ID の誤り：停止", () => {
    expectBlocked({ ...PROD, FIREBASE_PROJECT_ID: "uranai-stripe-sandbox-v2" }, "firebase_project_is_sandbox");
    expectBlocked({ ...PROD, FIREBASE_PROJECT_ID: "uranai-preview" }, "firebase_project_is_sandbox");
    expectBlocked({ ...PROD, FIREBASE_PROJECT_ID: "other-project" }, "firebase_project_not_production");
    expectBlocked({ ...PROD, FIREBASE_PROJECT_ID: undefined }, "firebase_project_not_production");
    expectBlocked({ ...PROD, FIREBASE_PROJECT_ID: " uranai-b6edf" }, "firebase_project_not_production");
    expectBlocked({ ...PROD, PRODUCTION_FIREBASE_PROJECT_ID: undefined }, "production_project_id_unexpected");
    expectBlocked({ ...PROD, PRODUCTION_FIREBASE_PROJECT_ID: "uranai-stripe-sandbox-v2" }, "production_project_id_unexpected");
  });
  it("Sandbox：本番の Firebase（大文字・空白の違いも）・その他のプロジェクト・PRODUCTION_FIREBASE_PROJECT_ID の誤り：停止", () => {
    expectBlocked({ ...SANDBOX, FIREBASE_PROJECT_ID: "uranai-b6edf" }, "firebase_project_is_production");
    expectBlocked({ ...SANDBOX, FIREBASE_PROJECT_ID: " URANAI-B6EDF " }, "firebase_project_is_production");
    expectBlocked({ ...SANDBOX, FIREBASE_PROJECT_ID: "uranai-preview" }, "firebase_project_not_sandbox");
    expectBlocked({ ...SANDBOX, FIREBASE_PROJECT_ID: undefined }, "firebase_project_not_sandbox");
    expectBlocked({ ...SANDBOX, PRODUCTION_FIREBASE_PROJECT_ID: "uranai-stripe-sandbox-v2" }, "production_project_id_unexpected");
  });
});

describe("Stripe", () => {
  it("本番にテスト用のキー（sk_test・rk_test）：停止", () => {
    expectBlocked({ ...PROD, STRIPE_SECRET_KEY: "sk_test_x-unit-dummy" }, "stripe_test_key_in_production");
    expectBlocked({ ...PROD, STRIPE_SECRET_KEY: " rk_test_x-unit-dummy" }, "stripe_test_key_in_production");
  });
  it("Sandbox に Live のキー（sk_live・rk_live）・STRIPE_LIVE_CHECKOUT=on：停止", () => {
    expectBlocked({ ...SANDBOX, STRIPE_SECRET_KEY: "sk_live_x-unit-dummy" }, "stripe_live_key_in_sandbox");
    expectBlocked({ ...SANDBOX, STRIPE_SECRET_KEY: "rk_live_x-unit-dummy" }, "stripe_live_key_in_sandbox");
    expectBlocked({ ...SANDBOX, STRIPE_LIVE_CHECKOUT: "on" }, "stripe_live_checkout_in_sandbox");
    expectBlocked({ ...SANDBOX, STRIPE_LIVE_CHECKOUT: " ON " }, "stripe_live_checkout_in_sandbox");
  });
  it("本番で Live のキーが無いのは開発モードだけ。キー無しで STRIPE_LIVE_CHECKOUT=on は停止", () => {
    for (const s of ["open", "coming_soon", undefined, "Development"]) expectBlocked({ ...PROD, SITE_STATUS: s }, "stripe_live_key_missing_outside_development");
    expectBlocked({ ...PROD, STRIPE_LIVE_CHECKOUT: "on" }, "stripe_live_checkout_without_live_key");
  });
  it("形式の不明なキー：停止", () => {
    expectBlocked({ ...PROD, STRIPE_SECRET_KEY: "pk_live_x-unit-dummy" }, "stripe_key_format_unknown");
    expectBlocked({ ...SANDBOX, STRIPE_SECRET_KEY: "whsec_x-unit-dummy" }, "stripe_key_format_unknown");
  });
});

describe("想定外の Netlify の環境", () => {
  it("想定外のブランチ（main・別の netlify/ ブランチ・大文字の違い・空）：停止", () => {
    for (const b of ["main", "netlify/ipdiag", "Netlify/production", "netlify/production/x", "", undefined]) {
      expectBlocked({ ...PROD, BRANCH: b }, "branch_not_allowed");
      expectBlocked({ ...SANDBOX, BRANCH: b }, "branch_not_allowed");
    }
  });
  it("Deploy Preview・dev・想定外の CONTEXT・CONTEXT 無し：停止", () => {
    expectBlocked({ ...SANDBOX, CONTEXT: "deploy-preview" }, "context_not_allowed");
    expectBlocked({ ...PROD, CONTEXT: "deploy-preview" }, "context_not_allowed");
    expectBlocked({ ...SANDBOX, CONTEXT: "dev" }, "context_not_allowed");
    expectBlocked({ ...PROD, CONTEXT: "Production" }, "context_not_allowed");
    expectBlocked({ ...PROD, CONTEXT: undefined }, "context_missing");
    expectBlocked({ ...PROD, CONTEXT: "" }, "context_missing");
  });
  it("本番扱いは production だけ・Sandbox 扱いは branch-deploy だけ（CONTEXT と BRANCH の不一致は停止）", () => {
    expectBlocked({ ...PROD, BRANCH: "netlify/sandbox" }, "context_branch_mismatch");
    expectBlocked({ ...SANDBOX, BRANCH: "netlify/production" }, "context_branch_mismatch");
  });
  it("VERCEL_ENV が無い・想定外：停止", () => {
    expectBlocked({ ...PROD, VERCEL_ENV: undefined }, "vercel_env_missing");
    expectBlocked({ ...SANDBOX, VERCEL_ENV: "" }, "vercel_env_missing");
    for (const v of ["preview", "development", "Production", " production"]) expectBlocked({ ...PROD, VERCEL_ENV: v }, "vercel_env_unexpected");
    for (const v of ["production", "development", "Preview"]) expectBlocked({ ...SANDBOX, VERCEL_ENV: v }, "vercel_env_unexpected");
  });
  it("Netlify のビルドに VERCEL がある：停止（Vercel の目印ですり抜けない）", () => {
    expectBlocked({ ...PROD, VERCEL: "1" }, "vercel_marker_on_netlify");
  });
});

describe("Netlify 以外は従来どおり・CONTEXT だけでは信用しない", () => {
  it("NETLIFY も CONTEXT も無い（Vercel・Cloud Run・ローカル）：何もしない", () => {
    expect(checkNetlifyBuildEnv({})).toEqual({ kind: "not_netlify" });
    // Vercel の本番・Preview のビルド
    expect(checkNetlifyBuildEnv({ VERCEL: "1", VERCEL_ENV: "production", FIREBASE_PROJECT_ID: "uranai-b6edf", STRIPE_SECRET_KEY: "sk_test_x-unit-dummy" }).kind).toBe("not_netlify");
    expect(checkNetlifyBuildEnv({ VERCEL: "1", VERCEL_ENV: "preview", VERCEL_GIT_COMMIT_REF: "preview/stripe-sandbox-v2" }).kind).toBe("not_netlify");
    // Cloud Run（ビルドに Netlify・Vercel の変数は無い。BRANCH などがあっても関係しない）
    expect(checkNetlifyBuildEnv({ VERCEL_ENV: "production", FIREBASE_PROJECT_ID: "uranai-b6edf", BRANCH: "main" }).kind).toBe("not_netlify");
    expect(() => assertNetlifyBuildEnv({})).not.toThrow();
  });
  it("Vercel のビルドに CONTEXT という変数があっても、従来どおり何もしない", () => {
    expect(checkNetlifyBuildEnv({ VERCEL: "1", CONTEXT: "production" }).kind).toBe("not_netlify");
  });
  it("NETLIFY=true でない環境の CONTEXT（出どころ不明）：停止（Netlify の判定をすり抜けない）", () => {
    expect(checkNetlifyBuildEnv({ CONTEXT: "production", BRANCH: "netlify/production" })).toEqual({ kind: "blocked", target: "unknown", issues: ["context_without_netlify"] });
    // NETLIFY が true 以外の値
    expectBlocked({ ...PROD, NETLIFY: "1" }, "context_without_netlify");
  });
  it("NETLIFY=true なら CONTEXT が無くても判定を省略しない", () => {
    expect(checkNetlifyBuildEnv({ NETLIFY: "true" }).kind).toBe("blocked");
  });
});

describe("エラーに値を含めない", () => {
  it("秘密・ブランチ名・プロジェクトID の値はメッセージに出ない。変数の名前だけ", () => {
    const secrets = ["sk_live_LEAKCHECK777", "rk_test_LEAKCHECK888", "netlify/LEAKBRANCH", "leak-project-999", "LEAKCONTEXT", "LEAKENV"];
    const cases: Env[] = [
      { ...SANDBOX, STRIPE_SECRET_KEY: secrets[0] },
      { ...PROD, STRIPE_SECRET_KEY: secrets[1], BRANCH: secrets[2], FIREBASE_PROJECT_ID: secrets[3], VERCEL_ENV: secrets[5] },
      { ...PROD, CONTEXT: secrets[4], STRIPE_SECRET_KEY: secrets[1] },
    ];
    for (const e of cases) {
      let msg = "";
      try {
        assertNetlifyBuildEnv(e);
      } catch (err) {
        msg = (err as Error).message;
      }
      expect(msg).toContain("[netlify-build-guard]");
      for (const s of secrets) expect(msg).not.toContain(s);
    }
  });
  it("副作用が無い（受け取った環境変数を書き換えない）", () => {
    const e = { ...PROD, STRIPE_SECRET_KEY: "sk_test_x-unit-dummy" };
    const copy = { ...e };
    checkNetlifyBuildEnv(e);
    expect(e).toEqual(copy);
  });
});

describe("next.config.ts からの呼び出し", () => {
  const withEnv = async (env: Env, fn: () => Promise<void>) => {
    const keys = ["NETLIFY", "CONTEXT", "BRANCH", "VERCEL", ...Object.keys(PROD), ...Object.keys(SANDBOX)];
    const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
    for (const k of keys) delete process.env[k];
    Object.assign(process.env, env);
    try {
      await fn();
    } finally {
      for (const k of keys) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
      }
    }
  };

  it("本番ビルドで誤りがあれば例外（ビルド停止）。正しい設定・Netlify 以外なら従来の設定を返す", async () => {
    const config = (await import("../next.config")).default;
    await withEnv({ ...PROD, FIREBASE_PROJECT_ID: "uranai-stripe-sandbox-v2" }, async () => {
      expect(() => config(PHASE_PRODUCTION_BUILD)).toThrow(/netlify-build-guard/);
    });
    await withEnv(PROD, async () => {
      expect(typeof config(PHASE_PRODUCTION_BUILD).headers).toBe("function");
    });
    await withEnv({}, async () => {
      const c = config(PHASE_PRODUCTION_BUILD);
      expect(c.poweredByHeader).toBe(false);
      expect((await c.headers!()).length).toBe(2);
    });
  });

  it("開発サーバー・実行時（next start）には判定しない", async () => {
    const config = (await import("../next.config")).default;
    await withEnv({ NETLIFY: "true" }, async () => {
      expect(() => config(PHASE_DEVELOPMENT_SERVER)).not.toThrow();
      expect(() => config(PHASE_PRODUCTION_SERVER)).not.toThrow();
    });
  });
});
