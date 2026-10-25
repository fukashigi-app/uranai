import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { diagnosticsAccess, firebaseTargetDiagnostics } from "@/lib/ops/firebase-target-diagnostics";
import { checkProductionEnv } from "@/lib/ops/env-check";

const TOKEN = "diag-unit-token-Zx8Lq2Vm7Rt4Np9Kw3Hy6Bc1";
const EMAIL = "firebase-adminsdk-ab12c@uranai-preview.iam.gserviceaccount.com";
const GOOD = {
  VERCEL_ENV: "preview",
  OPS_DIAGNOSTICS_TOKEN: TOKEN,
  FIREBASE_PROJECT_ID: "uranai-preview",
  PRODUCTION_FIREBASE_PROJECT_ID: "uranai-b6edf",
  FIREBASE_CLIENT_EMAIL: EMAIL,
  STRIPE_TEST_FIREBASE_PROJECT_ID: "uranai-preview",
  FIREBASE_PRIVATE_KEY: "-----BEGIN PRIVATE KEY-----\nSECRETKEYMATERIAL\n-----END PRIVATE KEY-----\n",
};
const ALL_TRUE = { projectIdIsPreview: true, productionProjectIdIsExpected: true, clientEmailBelongsToPreview: true, projectIdMatchesStripeTestProject: true };

describe("Firebase の接続先の判定（true / false だけ）", () => {
  it("正しい Preview の設定ならすべて true", () => {
    expect(firebaseTargetDiagnostics(GOOD)).toEqual(ALL_TRUE);
  });

  it("1. FIREBASE_PROJECT_ID が uranai-preview そのものでなければ false（本番・空白・大文字・未設定）", () => {
    for (const v of ["uranai-b6edf", " uranai-preview", "uranai-preview ", "URANAI-PREVIEW", "uranai-preview2", "", undefined]) {
      expect(firebaseTargetDiagnostics({ ...GOOD, FIREBASE_PROJECT_ID: v }).projectIdIsPreview, String(v)).toBe(false);
    }
  });

  it("2. PRODUCTION_FIREBASE_PROJECT_ID が uranai-b6edf でなければ false", () => {
    for (const v of ["uranai-preview", "uranai-b6edf ", "URANAI-B6EDF", "", undefined]) {
      expect(firebaseTargetDiagnostics({ ...GOOD, PRODUCTION_FIREBASE_PROJECT_ID: v }).productionProjectIdIsExpected, String(v)).toBe(false);
    }
  });

  it("3. FIREBASE_CLIENT_EMAIL が uranai-preview のサービスアカウントでなければ false", () => {
    expect(firebaseTargetDiagnostics({ ...GOOD, FIREBASE_CLIENT_EMAIL: "custom-sa-01@uranai-preview.iam.gserviceaccount.com" }).clientEmailBelongsToPreview).toBe(true);
    for (const v of [
      "firebase-adminsdk-ab12c@uranai-b6edf.iam.gserviceaccount.com",
      "firebase-adminsdk-ab12c@uranai-preview2.iam.gserviceaccount.com",
      "firebase-adminsdk-ab12c@uranai-preview.iam.gserviceaccount.com.evil.example",
      "x@uranai-preview.iam.gserviceaccount.com", // 名前が短すぎる
      "someone@example.com",
      `${EMAIL} `,
      `${EMAIL}\nfirebase-adminsdk-ab12c@uranai-b6edf.iam.gserviceaccount.com`,
      "",
      undefined,
    ]) {
      expect(firebaseTargetDiagnostics({ ...GOOD, FIREBASE_CLIENT_EMAIL: v }).clientEmailBelongsToPreview, String(v)).toBe(false);
    }
  });

  it("4. FIREBASE_PROJECT_ID と STRIPE_TEST_FIREBASE_PROJECT_ID が一致しなければ false（どちらかが未設定・空でも false）", () => {
    expect(firebaseTargetDiagnostics({ ...GOOD, STRIPE_TEST_FIREBASE_PROJECT_ID: "uranai-other" }).projectIdMatchesStripeTestProject).toBe(false);
    expect(firebaseTargetDiagnostics({ ...GOOD, STRIPE_TEST_FIREBASE_PROJECT_ID: undefined }).projectIdMatchesStripeTestProject).toBe(false);
    expect(firebaseTargetDiagnostics({ ...GOOD, FIREBASE_PROJECT_ID: undefined, STRIPE_TEST_FIREBASE_PROJECT_ID: undefined }).projectIdMatchesStripeTestProject).toBe(false);
    expect(firebaseTargetDiagnostics({ ...GOOD, FIREBASE_PROJECT_ID: "", STRIPE_TEST_FIREBASE_PROJECT_ID: "" }).projectIdMatchesStripeTestProject).toBe(false);
    // 一致の判定は値そのもの（両方が同じ別のプロジェクトでも true。uranai-preview かどうかは 1 で判定する）
    expect(firebaseTargetDiagnostics({ ...GOOD, FIREBASE_PROJECT_ID: "uranai-x", STRIPE_TEST_FIREBASE_PROJECT_ID: "uranai-x" })).toMatchObject({ projectIdIsPreview: false, projectIdMatchesStripeTestProject: true });
  });

  it("結果は4つの真偽値だけ（値・長さなどを含まない）", () => {
    const r = firebaseTargetDiagnostics({ ...GOOD, FIREBASE_PROJECT_ID: "uranai-b6edf" });
    expect(Object.keys(r).sort()).toEqual(Object.keys(ALL_TRUE).sort());
    expect(Object.values(r).every((v) => typeof v === "boolean")).toBe(true);
  });
});

describe("診断を使える条件（Preview・診断トークン）", () => {
  const ok = `Bearer ${TOKEN}`;
  it("Preview でトークンが一致するときだけ ok", () => {
    expect(diagnosticsAccess(ok, GOOD)).toBe("ok");
  });
  it("本番・ローカル・Development では常に無効", () => {
    expect(diagnosticsAccess(ok, { ...GOOD, VERCEL_ENV: "production" })).toBe("disabled");
    expect(diagnosticsAccess(ok, { ...GOOD, VERCEL_ENV: undefined })).toBe("disabled");
    expect(diagnosticsAccess(ok, { ...GOOD, VERCEL_ENV: "development" })).toBe("disabled");
  });
  it("トークンが未設定・空・短すぎるときは無効", () => {
    expect(diagnosticsAccess(ok, { ...GOOD, OPS_DIAGNOSTICS_TOKEN: undefined })).toBe("disabled");
    expect(diagnosticsAccess("Bearer ", { ...GOOD, OPS_DIAGNOSTICS_TOKEN: "" })).toBe("disabled");
    expect(diagnosticsAccess("Bearer short", { ...GOOD, OPS_DIAGNOSTICS_TOKEN: "short" })).toBe("disabled");
    expect(diagnosticsAccess(`Bearer ${" ".repeat(40)}`, { ...GOOD, OPS_DIAGNOSTICS_TOKEN: " ".repeat(40) })).toBe("disabled");
  });
  it("ヘッダーが無い・形式が違う・トークンが違うときは unauthorized", () => {
    for (const h of [null, "", TOKEN, `bearer ${TOKEN}`, `Basic ${TOKEN}`, `Bearer ${TOKEN}x`, `Bearer ${TOKEN.slice(0, -1)}`, `Bearer ${TOKEN} extra`]) {
      expect(diagnosticsAccess(h, GOOD), String(h)).toBe("unauthorized");
    }
  });
});

describe("診断 API（/api/ops/firebase-target）", () => {
  beforeEach(() => {
    vi.resetModules();
  });
  afterEach(() => vi.unstubAllEnvs());

  const call = async (env: Record<string, string | undefined>, authorization?: string) => {
    for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v as string);
    const { GET } = await import("@/app/api/ops/firebase-target/route");
    return GET(new Request("https://preview.example/api/ops/firebase-target", { headers: authorization ? { authorization } : {} }));
  };

  it("正しいトークン：4項目の真偽値だけを返す。秘密情報・トークンを含まない。no-store", async () => {
    const r = await call(GOOD, `Bearer ${TOKEN}`);
    expect(r.status).toBe(200);
    expect(r.headers.get("cache-control")).toBe("no-store");
    const text = await r.text();
    const body = JSON.parse(text) as { firebaseTarget: unknown; checkedAt: string };
    expect(Object.keys(body).sort()).toEqual(["checkedAt", "firebaseTarget"]);
    expect(body.firebaseTarget).toEqual(ALL_TRUE);
    for (const secret of [TOKEN, EMAIL, "ab12c", "SECRETKEYMATERIAL", "uranai-preview", "uranai-b6edf"]) expect(text).not.toContain(secret);
  });

  it("設定が誤っていても値は返さず false だけ", async () => {
    const r = await call({ ...GOOD, FIREBASE_PROJECT_ID: "uranai-b6edf", FIREBASE_CLIENT_EMAIL: "firebase-adminsdk-zz99y@uranai-b6edf.iam.gserviceaccount.com" }, `Bearer ${TOKEN}`);
    const text = await r.text();
    expect(JSON.parse(text).firebaseTarget).toEqual({ projectIdIsPreview: false, productionProjectIdIsExpected: true, clientEmailBelongsToPreview: false, projectIdMatchesStripeTestProject: false });
    expect(text).not.toContain("b6edf");
    expect(text).not.toContain("zz99y");
  });

  it("本番・トークン未設定は 404、トークン違いは 401（どちらも no-store・中身なし）", async () => {
    for (const [env, auth, status] of [
      [{ ...GOOD, VERCEL_ENV: "production" }, `Bearer ${TOKEN}`, 404],
      [{ ...GOOD, OPS_DIAGNOSTICS_TOKEN: "" }, `Bearer ${TOKEN}`, 404],
      [GOOD, undefined, 401],
      [GOOD, "Bearer wrong-token-wrong-token-wrong-token", 401],
    ] as const) {
      vi.resetModules();
      const r = await call(env, auth);
      expect(r.status).toBe(status);
      expect(r.headers.get("cache-control")).toBe("no-store");
      expect(await r.text()).not.toMatch(/uranai|true|false/);
      vi.unstubAllEnvs();
    }
  });

  it("Firebase・Firestore を読み込まない（接続しない）：読み込むモジュールを固定する", () => {
    const importsOf = (file: string) => [...readFileSync(path.resolve(__dirname, "..", file), "utf8").matchAll(/^\s*import\s[^;]*?from\s+"([^"]+)"|^\s*import\s+"([^"]+)"|import\(\s*"([^"]+)"\s*\)|require\(\s*"([^"]+)"\s*\)/gm)].map((m) => m[1] ?? m[2] ?? m[3] ?? m[4]).sort();
    // route → 診断のモジュール → node:crypto だけ（この先で Firebase に届く経路が無い）
    expect(importsOf("src/app/api/ops/firebase-target/route.ts")).toEqual(["@/lib/ops/firebase-target-diagnostics", "next/server"]);
    expect(importsOf("src/lib/ops/firebase-target-diagnostics.ts")).toEqual(["node:crypto"]);
  });
});

describe("check:env：本番に診断トークンが残っていたら警告する（値は出さない）", () => {
  it("警告に値を含めない", () => {
    const issues = checkProductionEnv({ OPS_DIAGNOSTICS_TOKEN: TOKEN });
    const found = JSON.stringify(issues);
    expect(found).toContain("OPS_DIAGNOSTICS_TOKEN");
    expect(found).not.toContain(TOKEN);
  });
});
