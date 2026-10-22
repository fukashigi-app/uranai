import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dangerousConfigReasons, isDevModeLiveKeyConflict, isSessionSecretStrong, livePaymentKeyNames, pausedMessage, productionConfigIssues, serviceStopReason, siteStatus } from "@/lib/env";
import { bindingFor, decodeFreeSession, DEV_TTL_MS, encodeFreeSession, type TestSession } from "@/lib/services/free-session-token";
import { classifyProbeResponse, describeProtection, getProtectionStatus, isVercelLoginRedirect, PROBE_MARKER } from "@/lib/services/vercel-protection";

const SECRET = "unit-test-session-secret-Qx7v2Lr9Tm4Kp8Zw";

// ---- 開発モードのログイン状態・Cookie の差し替え（実際のデータベース・ログインには接続しない） ----
const auth = vi.hoisted(() => ({
  user: null as null | { id: string; email: string; name: string; role: "OPERATOR" | "STORE" },
  sessionHash: null as string | null,
  fail: false,
}));
const jar = vi.hoisted(() => new Map<string, string>());
const limiter = vi.hoisted(() => ({ allow: true, fail: false, keys: [] as string[] }));

vi.mock("@/lib/auth/session", () => ({
  currentSessionHash: async () => {
    if (auth.fail) throw new Error("db down");
    return auth.sessionHash;
  },
  getSessionUser: async () => {
    if (auth.fail) throw new Error("db down");
    return auth.user;
  },
}));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (k: string) => (jar.has(k) ? { name: k, value: jar.get(k)! } : undefined),
    set: (k: string, v: string) => void jar.set(k, v),
  }),
}));
// 登録済みの店舗（Emulator・データベースには接続しない）。realstore01 = 稼働中、paused01 = 休止中、それ以外 = 未登録
const storeDb = vi.hoisted(() => ({ fail: false }));
vi.mock("@/lib/services/checkout", () => ({
  findActiveStoreByCode: async (code: string) => {
    if (storeDb.fail) throw new Error("db down");
    if (code === "realstore01") return { id: "s-1", name: "実店舗A", status: "ACTIVE", storeCode: code };
    if (code === "paused01") return { id: "s-2", name: "休止店舗", status: "SUSPENDED", storeCode: code };
    return null;
  },
}));
vi.mock("@/lib/security/rate-limit", () => ({
  rateLimit: async (key: string) => {
    limiter.keys.push(key);
    if (limiter.fail) throw new Error("db down");
    return limiter.allow;
  },
}));

const OPERATOR = { id: "op-1", email: "op@example.com", name: "運営", role: "OPERATOR" as const };
const STORE_USER = { id: "st-1", email: "st@example.com", name: "店舗", role: "STORE" as const };
const DEV_ENV = { SITE_STATUS: "development", SESSION_SECRET: SECRET, FIREBASE_PROJECT_ID: "demo-unit", VERCEL_ENV: "production" };
const ALL_KEYS = ["SITE_STATUS", "SESSION_SECRET", "FIREBASE_PROJECT_ID", "VERCEL_ENV", "ENABLE_TEST_PAYMENT", "PAYMENT_PROVIDER", "PAYJP_SECRET_KEY", "PAYJP_PUBLIC_KEY", "STRIPE_SECRET_KEY", "DATABASE_URL", "DB_PROVIDER", "FIRESTORE_EMULATOR_HOST"];

async function load(env: Record<string, string>) {
  for (const k of ALL_KEYS) vi.stubEnv(k, env[k]);
  vi.resetModules();
  return import("@/lib/services/test-store");
}

function session(over: Partial<TestSession> = {}): TestSession {
  return { v: 1, id: "abc", storeCode: "test", storeName: "テスト店舗", type: "ZODIAC", status: "ready", exp: Date.now() + 60_000, ...over };
}

beforeEach(() => {
  auth.user = null;
  auth.sessionHash = null;
  auth.fail = false;
  jar.clear();
  storeDb.fail = false;
  limiter.allow = true;
  limiter.fail = false;
  limiter.keys = [];
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe("SITE_STATUS=development の判定", () => {
  it("development を正式な値として扱い、open・coming_soon・不明な値の動作は変えない", () => {
    expect(siteStatus({ SITE_STATUS: "development" })).toEqual({ status: "development", unknown: false });
    expect(siteStatus({ SITE_STATUS: " Development " })).toEqual({ status: "development", unknown: false });
    expect(siteStatus({})).toEqual({ status: "open", unknown: false });
    expect(siteStatus({ SITE_STATUS: "coming_soon" })).toEqual({ status: "coming_soon", unknown: false });
    expect(siteStatus({ SITE_STATUS: "dev" })).toEqual({ status: "coming_soon", unknown: true }); // 打ち間違いは準備中
    expect(serviceStopReason({ SITE_STATUS: "development" })).toBe("development");
    expect(serviceStopReason({ SITE_STATUS: "coming_soon" })).toBe("coming_soon");
    expect(serviceStopReason({ VERCEL_ENV: "production" })).toBeNull();
  });

  it("危険な設定は開発モードより優先して停止する（本番の ENABLE_TEST_PAYMENT=true・mock・開発モードでの本番用決済キー）", () => {
    expect(serviceStopReason({ VERCEL_ENV: "production", SITE_STATUS: "development", ENABLE_TEST_PAYMENT: "true" })).toBe("dangerous_config");
    expect(serviceStopReason({ VERCEL_ENV: "production", SITE_STATUS: "development", PAYMENT_PROVIDER: "mock" })).toBe("dangerous_config");
    for (const [k, v] of [
      ["PAYJP_SECRET_KEY", "sk_live_x"],
      ["PAYJP_PUBLIC_KEY", "pk_live_x"],
      ["STRIPE_SECRET_KEY", "sk_live_x"],
      ["STRIPE_SECRET_KEY", "rk_live_x"],
      ["STRIPE_PUBLISHABLE_KEY", "pk_live_x"],
    ]) {
      // 本番以外（ローカル）でも、開発モードに本番用の決済キーがあれば止める
      expect(serviceStopReason({ SITE_STATUS: "development", [k]: v }), k).toBe("dangerous_config");
      expect(isDevModeLiveKeyConflict({ SITE_STATUS: "development", [k]: v }), k).toBe(true);
    }
    // テスト用のキーは止めない（決済の API は開発モードでどのみち停止）。公開中の本番用キーは開発モードの判定に関係しない
    expect(serviceStopReason({ SITE_STATUS: "development", PAYJP_SECRET_KEY: "sk_test_x" })).toBe("development");
    expect(isDevModeLiveKeyConflict({ SITE_STATUS: "open", PAYJP_SECRET_KEY: "sk_live_x" })).toBe(false);
    expect(livePaymentKeyNames({ PAYJP_SECRET_KEY: "sk_live_x", STRIPE_SECRET_KEY: "sk_test_x" })).toEqual(["PAYJP_SECRET_KEY"]);
    const issues = productionConfigIssues({ VERCEL_ENV: "production", CRON_SECRET: "x".repeat(32), SITE_STATUS: "development", STRIPE_SECRET_KEY: "sk_live_secretvalue" });
    expect(issues.filter((i) => i.level === "error").map((i) => i.key)).toEqual(["SITE_STATUS"]);
    expect(JSON.stringify(issues)).not.toContain("secretvalue"); // 値は出さない
    expect(productionConfigIssues({ VERCEL_ENV: "production", CRON_SECRET: "x".repeat(32), SITE_STATUS: "development" })).toEqual([]);
  });

  it("SESSION_SECRET の安全性：未設定・短い・同じ文字の繰り返し・よくある仮の値は不可", () => {
    expect(isSessionSecretStrong({ SESSION_SECRET: SECRET })).toBe(true);
    expect(isSessionSecretStrong({})).toBe(false);
    expect(isSessionSecretStrong({ SESSION_SECRET: "short-secret" })).toBe(false);
    expect(isSessionSecretStrong({ SESSION_SECRET: "s".repeat(40) })).toBe(false);
    expect(isSessionSecretStrong({ SESSION_SECRET: "abababababababababababababababab" })).toBe(false);
    expect(isSessionSecretStrong({ SESSION_SECRET: "changeme-please-0123456789abcdefgh" })).toBe(false);
  });
});

describe("開発モードの利用者（サーバー側の判定）", () => {
  it("運営アカウントでログイン中の人だけ dev。ログインなし・店舗アカウントは準備中（development）", async () => {
    let m = await load(DEV_ENV);
    expect(await m.testModeState()).toBe("development");
    expect(await m.isTestModeActive()).toBe(false);

    auth.sessionHash = "h-store";
    auth.user = STORE_USER;
    m = await load(DEV_ENV);
    expect(await m.testModeState()).toBe("development");

    auth.sessionHash = "h-op";
    auth.user = OPERATOR;
    m = await load(DEV_ENV);
    expect(await m.testModeState()).toBe("dev");
    expect(await m.isTestModeActive()).toBe(true);
    expect(m.isServiceStopped("development")).toBe(true);
    expect(m.isServiceStopped("dev")).toBe(false);
  });

  it("運営アカウントでも使えない：危険な設定・本番用の決済キー・弱い SESSION_SECRET・データベース無し・ログインの確認に失敗", async () => {
    auth.sessionHash = "h-op";
    auth.user = OPERATOR;
    expect(await (await load({ ...DEV_ENV, ENABLE_TEST_PAYMENT: "true" })).testModeState()).toBe("halted");
    expect(await (await load({ ...DEV_ENV, PAYJP_SECRET_KEY: "sk_live_x" })).testModeState()).toBe("halted");
    expect(await (await load({ ...DEV_ENV, SESSION_SECRET: "s".repeat(40) })).testModeState()).toBe("development");
    expect(await (await load({ ...DEV_ENV, SESSION_SECRET: "" })).testModeState()).toBe("development");
    expect(await (await load({ ...DEV_ENV, FIREBASE_PROJECT_ID: "" })).testModeState()).toBe("development");
    auth.fail = true;
    expect(await (await load(DEV_ENV)).testModeState()).toBe("development");
  });

  it("開発モードでは、Preview の ENABLE_TEST_PAYMENT=true（誰でも無料）より開発モードの判定を優先する", async () => {
    const m = await load({ ...DEV_ENV, VERCEL_ENV: "preview", ENABLE_TEST_PAYMENT: "true" });
    expect(await m.testModeState()).toBe("development"); // ログインなしは無料で使えない
  });

  it("テストモード（ローカル・Preview）は今までどおり。ただし SESSION_SECRET が安全でなければ無料にしない", async () => {
    expect(await (await load({ VERCEL_ENV: "preview", ENABLE_TEST_PAYMENT: "true", SESSION_SECRET: SECRET })).testModeState()).toBe("on");
    expect(await (await load({ VERCEL_ENV: "preview", ENABLE_TEST_PAYMENT: "true", SESSION_SECRET: "s".repeat(40) })).testModeState()).toBe("off");
    expect(await (await load({ VERCEL_ENV: "preview", ENABLE_TEST_PAYMENT: "true" })).testModeState()).toBe("off");
    expect(await (await load({ VERCEL_ENV: "production", ENABLE_TEST_PAYMENT: "true", SESSION_SECRET: SECRET })).testModeState()).toBe("halted");
    expect(await (await load({ VERCEL_ENV: "production", SITE_STATUS: "coming_soon", SESSION_SECRET: SECRET })).testModeState()).toBe("coming_soon");
    expect(await (await load({ VERCEL_ENV: "production", SESSION_SECRET: SECRET })).testModeState()).toBe("off");
  });

  it("開発モードの店舗：QR なし・/s/test はテスト店舗、登録済みの実店舗の QR はその店舗、未登録は null", async () => {
    auth.sessionHash = "h-op";
    auth.user = OPERATOR;
    let m = await load(DEV_ENV);
    expect(await m.resolveVisitorStore()).toEqual(m.TEST_STORE);
    jar.set("qr_store", "test");
    expect(await m.resolveVisitorStore()).toEqual(m.TEST_STORE);
    jar.set("qr_store", "realstore01");
    m = await load(DEV_ENV);
    expect(await m.resolveVisitorStore()).toMatchObject({ storeCode: "realstore01", status: "ACTIVE" });
    jar.set("qr_store", "paused01");
    expect(await m.resolveVisitorStore()).toMatchObject({ storeCode: "paused01", status: "SUSPENDED" }); // 稼働中かは呼び出し側で確認
    jar.set("qr_store", "unknown01");
    expect(await m.resolveVisitorStore()).toBeNull();
  });

  it("開発モードの無料占いに使える店舗：テスト店舗と稼働中の登録店舗だけ（休止・未登録・確認できないときは不可）", async () => {
    const m = await load(DEV_ENV);
    expect(await m.isDevModeStoreUsable("test")).toBe(true);
    expect(await m.isDevModeStoreUsable("realstore01")).toBe(true);
    expect(await m.isDevModeStoreUsable("paused01")).toBe(false);
    expect(await m.isDevModeStoreUsable("unknown01")).toBe(false);
    storeDb.fail = true;
    expect(await m.isDevModeStoreUsable("realstore01")).toBe(false);
    expect(await m.isDevModeStoreUsable("test")).toBe(true); // テスト店舗はデータベース不要
  });

  it("運営以外は、実店舗の QR でも無料の占いの状態にならない", async () => {
    jar.set("qr_store", "realstore01");
    expect(await (await load(DEV_ENV)).testModeState()).toBe("development"); // ログインなし
    auth.sessionHash = "h-store";
    auth.user = STORE_USER;
    expect(await (await load(DEV_ENV)).testModeState()).toBe("development"); // 店舗アカウント
    auth.user = OPERATOR;
    expect(await (await load({ ...DEV_ENV, SITE_STATUS: "production" })).testModeState()).toBe("coming_soon"); // production は未定義の値＝準備中
    expect(await (await load({ ...DEV_ENV, SITE_STATUS: "open" })).testModeState()).toBe("off");
  });
});

describe("開発モード用 Cookie（署名・有効期限・ログイン状態との結び付け）", () => {
  const binding = { userId: "op-1", sessionHash: "h-op" };
  const dev = (over: Partial<TestSession> = {}) => session({ mode: "development", uid: "op-1", sid: bindingFor("h-op"), exp: Date.now() + DEV_TTL_MS - 1000, ...over });

  it("正しい Cookie は読める。運営アカウント・ログイン状態が違えば読めない", () => {
    const v = encodeFreeSession(dev(), "development", SECRET)!;
    expect(decodeFreeSession(v, "development", SECRET, binding)?.uid).toBe("op-1");
    expect(decodeFreeSession(v, "development", SECRET, { ...binding, userId: "op-2" })).toBeNull(); // 別の運営アカウント
    expect(decodeFreeSession(v, "development", SECRET, { ...binding, sessionHash: "h-other" })).toBeNull(); // ログアウト・再ログイン後
    expect(decodeFreeSession(v, "development", SECRET)).toBeNull(); // ログイン状態なし
  });

  it("改ざん・別の鍵・期限切れ・長すぎる有効期限・テストモード用との取り違えは読めない", () => {
    const v = encodeFreeSession(dev(), "development", SECRET)!;
    const [body, sig] = v.split(".");
    const forged = Buffer.from(JSON.stringify({ ...dev(), uid: "op-9" })).toString("base64url");
    expect(decodeFreeSession(`${forged}.${sig}`, "development", SECRET, { ...binding, userId: "op-9" })).toBeNull();
    expect(decodeFreeSession(`${body}.${sig}x`, "development", SECRET, binding)).toBeNull();
    expect(decodeFreeSession(`${body}.${sig}.x`, "development", SECRET, binding)).toBeNull();
    expect(decodeFreeSession(v, "development", "another-session-secret-Zr8Qp3Lm6Tx1Vb5N", binding)).toBeNull();
    expect(decodeFreeSession(v, "development", "s".repeat(40), binding)).toBeNull(); // 弱い鍵では検証しない
    const expired = encodeFreeSession(dev({ exp: Date.now() - 1 }), "development", SECRET)!;
    expect(decodeFreeSession(expired, "development", SECRET, binding)).toBeNull();
    const tooLong = encodeFreeSession(dev({ exp: Date.now() + DEV_TTL_MS * 10 }), "development", SECRET)!;
    expect(decodeFreeSession(tooLong, "development", SECRET, binding)).toBeNull();
    // テストモード用の Cookie は開発モードで使えない（鍵も別）。逆も同じ
    const t = encodeFreeSession(session(), "test", SECRET)!;
    expect(decodeFreeSession(t, "development", SECRET, binding)).toBeNull();
    expect(decodeFreeSession(v, "test", SECRET)).toBeNull();
    expect(decodeFreeSession(t, "test", SECRET)?.id).toBe("abc");
    // 開発モードの印が無いものは開発モード用として署名しない。弱い鍵では署名しない
    expect(encodeFreeSession(session(), "development", SECRET)).toBeNull();
    expect(encodeFreeSession(dev(), "development", "s".repeat(40))).toBeNull();
    expect(encodeFreeSession(dev(), "test", SECRET)).toBeNull();
  });

  it("getTestSession: 開発モードでは運営アカウント本人・同じログイン状態・テスト店舗の Cookie だけ有効", async () => {
    auth.sessionHash = "h-op";
    auth.user = OPERATOR;
    let m = await load(DEV_ENV);
    const s = m.newTestSession(m.TEST_STORE, "ZODIAC", { userId: OPERATOR.id, sessionHash: "h-op" });
    expect(s.mode).toBe("development");
    expect(s.exp - Date.now()).toBeLessThanOrEqual(DEV_TTL_MS);
    expect(JSON.stringify(s)).not.toContain("h-op"); // ログイン状態のハッシュそのものは入れない
    expect(await m.saveTestSession(s, true)).toBe(true);
    expect(jar.has("fx_dev")).toBe(true);
    expect((await m.getTestSession())?.id).toBe(s.id);

    // 稼働中の登録店舗で作られたものは使える。休止・未登録の店舗、店舗を確認できないときは使わない
    jar.set("fx_dev", encodeFreeSession({ ...s, storeCode: "realstore01" }, "development", SECRET)!);
    expect((await m.getTestSession())?.storeCode).toBe("realstore01");
    jar.set("fx_dev", encodeFreeSession({ ...s, storeCode: "paused01" }, "development", SECRET)!);
    expect(await m.getTestSession()).toBeNull();
    jar.set("fx_dev", encodeFreeSession({ ...s, storeCode: "unknown01" }, "development", SECRET)!);
    expect(await m.getTestSession()).toBeNull();
    storeDb.fail = true;
    jar.set("fx_dev", encodeFreeSession({ ...s, storeCode: "realstore01" }, "development", SECRET)!);
    expect(await m.getTestSession()).toBeNull();
    storeDb.fail = false;

    // 別の運営アカウントでログインし直すと、前の Cookie は使えない
    await m.saveTestSession(s, true);
    auth.user = { ...OPERATOR, id: "op-2" };
    auth.sessionHash = "h-op2";
    m = await load(DEV_ENV);
    expect(await m.getTestSession()).toBeNull();

    // ログアウト（ログイン状態なし）・店舗アカウントでも使えない
    auth.user = null;
    auth.sessionHash = null;
    m = await load(DEV_ENV);
    expect(await m.getTestSession()).toBeNull();
    auth.user = STORE_USER;
    auth.sessionHash = "h-op";
    m = await load(DEV_ENV);
    expect(await m.getTestSession()).toBeNull();

    // 公開（open）に戻すと開発モードの Cookie はすべて無効
    auth.user = OPERATOR;
    m = await load({ ...DEV_ENV, SITE_STATUS: "open" });
    expect(await m.getTestSession()).toBeNull();
  });
});

describe("無料の占いの回数制限（サーバー側）", () => {
  const req = () => new Request("http://localhost/api/test-fortune", { method: "POST", headers: { "x-real-ip": "203.0.113.1" } });

  it("超えたら 429、確認できなければ 503。開発モードは運営アカウントごとにも数える", async () => {
    const m = await load({ ...DEV_ENV, VERCEL_ENV: "" });
    expect(await m.limitFreeFortune(req(), "test-fortune", 10, 60, "op-1")).toBeNull();
    expect(limiter.keys).toHaveLength(2);
    expect(limiter.keys[1]).toBe("test-fortune:user:op-1");
    expect(limiter.keys[0]).not.toContain("203.0.113.1"); // IP はハッシュ化
    limiter.allow = false;
    expect((await m.limitFreeFortune(req(), "test-fortune", 10, 60, "op-1"))?.status).toBe(429);
    limiter.allow = true;
    limiter.fail = true;
    expect((await m.limitFreeFortune(req(), "test-fortune", 10, 60, "op-1"))?.status).toBe(503);
  });

  it("データベースが無いのはローカルのテストモードだけ（開発モードの利用者なら 503）", async () => {
    const m = await load({ SESSION_SECRET: SECRET, ENABLE_TEST_PAYMENT: "true" });
    expect(await m.limitFreeFortune(req(), "test-fortune", 10, 60)).toBeNull();
    expect((await m.limitFreeFortune(req(), "test-fortune", 10, 60, "op-1"))?.status).toBe(503);
  });
});

describe("決済 API の停止（サーバー側）", () => {
  it("開発モード・準備中・危険な設定では、誰に対しても 503（運営アカウントでも）", async () => {
    vi.resetModules();
    const { paymentStopResponse } = await import("@/lib/api");
    expect(paymentStopResponse("development")?.status).toBe(503);
    expect(await paymentStopResponse("development")!.json()).toMatchObject({ error: { code: "development_mode" } });
    expect(paymentStopResponse("coming_soon")?.status).toBe(503);
    expect(paymentStopResponse("dangerous_config")?.status).toBe(503);
    expect(paymentStopResponse(null)).toBeNull();
  });

  it("決済の API ルートは、開発モードではデータベースや決済サービスに触れる前に 503 を返す", async () => {
    auth.sessionHash = "h-op";
    auth.user = OPERATOR; // 運営アカウントでも停止
    for (const k of ALL_KEYS) vi.stubEnv(k, (DEV_ENV as Record<string, string>)[k]);
    vi.resetModules();
    const checkout = await import("@/app/api/checkout/route");
    const pay = await import("@/app/api/checkout/pay/route");
    const body = (b: unknown) => new Request("http://localhost/api/checkout", { method: "POST", headers: { origin: "http://localhost", "content-type": "application/json" }, body: JSON.stringify(b) });
    const r1 = await checkout.POST(body({ fortuneType: "ZODIAC" }));
    const r2 = await pay.POST(body({ cardToken: "tok_x" }));
    expect([r1.status, r2.status]).toEqual([503, 503]);
    expect(limiter.keys).toEqual([]); // 回数制限（データベース）にも届いていない
  });
});

describe("Vercel Authentication の確認（表示だけ。保護されていると推測しない）", () => {
  it("応答の判断", () => {
    expect(classifyProbeResponse(200, null, JSON.stringify({ probe: PROBE_MARKER })).state).toBe("unprotected");
    expect(classifyProbeResponse(401, null, "").state).toBe("auth_required");
    // 403 は Firewall・Bot 対策・IP の制限でも返るため「未確認」
    expect(classifyProbeResponse(403, null, "").state).toBe("unknown");
    expect(classifyProbeResponse(403, "https://vercel.com/sso-api?url=x", "").state).toBe("unknown");
    expect(classifyProbeResponse(307, "https://vercel.com/sso-api?url=x", "").state).toBe("auth_required");
    expect(classifyProbeResponse(302, "https://vercel.com/sso-api/x", "").state).toBe("auth_required");
    expect(classifyProbeResponse(307, "https://evil.example/vercel.com", "").state).toBe("unknown");
    expect(classifyProbeResponse(307, "https://vercel.com/somewhere-else", "").state).toBe("unknown");
    expect(classifyProbeResponse(307, null, "").state).toBe("unknown");
    expect(classifyProbeResponse(200, "https://vercel.com/sso-api", "").state).toBe("unknown"); // 転送でない応答の Location は見ない
    expect(classifyProbeResponse(200, null, "<html>other</html>").state).toBe("unknown");
    expect(classifyProbeResponse(500, null, "").state).toBe("unknown");
  });

  it("ログイン画面への転送は、絶対 URL・https・ちょうど vercel.com・/sso-api だけを信用する", () => {
    for (const ok of ["https://vercel.com/sso-api", "https://vercel.com/sso-api?url=https%3A%2F%2Fx&nonce=1", "https://VERCEL.com/sso-api/"]) {
      expect(isVercelLoginRedirect(ok), ok).toBe(true);
    }
    for (const bad of [
      null,
      "",
      "/sso-api", // 相対 URL
      "//vercel.com/sso-api", // 方式なし
      "http://vercel.com/sso-api", // https 以外
      "https://evil.vercel.com/sso-api", // サブドメイン
      "https://vercel.com.evil.example/sso-api", // 似た名前
      "https://evil.example/sso-api?u=https://vercel.com/sso-api",
      "https://vercel.com@evil.example/sso-api", // ユーザー名でごまかす
      "https://user:pass@vercel.com/sso-api",
      "https://vercel.com:8443/sso-api", // ポート指定
      "https://vercel.com/sso-apix",
      "https://vercel.com/login",
      "javascript:alert(1)",
      `https://vercel.com/sso-api?${"a".repeat(5000)}`, // 長すぎる
    ]) {
      expect(isVercelLoginRedirect(bad), String(bad)).toBe(false);
    }
  });

  it("表示には最後に確認した日時と、キャッシュされた結果の可能性を添える。未確認は保護済みと誤解させない", () => {
    const checkedAt = Date.UTC(2026, 9, 21, 7, 5); // 16:05 JST
    const u = describeProtection({ state: "unknown", detail: "", checkedAt });
    expect(u).toContain("未確認");
    expect(u).toContain("保護されているかは分かりません");
    expect(u).toMatch(/最終確認：2026\/10\/21 16:05/);
    expect(u).toContain("最大5分前の結果");
    expect(u).not.toMatch(/保護済み|保護されています/);
    expect(describeProtection({ state: "auth_required", detail: "", checkedAt })).toContain("認証を求める応答を確認");
    expect(describeProtection({ state: "auth_required", detail: "", checkedAt })).not.toContain("保護済み");
    expect(describeProtection({ state: "unprotected", detail: "", checkedAt })).toContain("保護されていません");
  });

  it("Vercel 以外・通信の失敗は「未確認」。保護を回避する設定は送らない", async () => {
    expect((await getProtectionStatus({ force: true, env: {} })).state).toBe("unknown");
    const failing = (async () => {
      throw new Error("network");
    }) as unknown as typeof fetch;
    expect((await getProtectionStatus({ force: true, env: { VERCEL_ENV: "production", VERCEL_PROJECT_PRODUCTION_URL: "uranai.example.jp" }, fetchImpl: failing })).state).toBe("unknown");
    let sent: { url: string; init?: RequestInit } | null = null;
    const ok = (async (url: string, init?: RequestInit) => {
      sent = { url, init };
      return new Response(null, { status: 401 });
    }) as unknown as typeof fetch;
    const r = await getProtectionStatus({ force: true, env: { VERCEL_ENV: "production", VERCEL_PROJECT_PRODUCTION_URL: "uranai.example.jp" }, fetchImpl: ok });
    expect(r.state).toBe("auth_required");
    expect(sent!.url).toBe("https://uranai.example.jp/api/health/probe");
    expect(JSON.stringify(sent!.init?.headers ?? {})).not.toMatch(/bypass|authorization|cookie/i);
  });
});

describe("/api/health の停止理由の文言（値は出さない）", () => {
  it("本番の無料テスト設定・疑似決済・開発モードでの本番用決済キーを区別する", () => {
    const prod = { VERCEL_ENV: "production" };
    expect(dangerousConfigReasons({ ...prod, ENABLE_TEST_PAYMENT: "true" })).toEqual([{ kind: "test_payment_in_production" }]);
    expect(pausedMessage(dangerousConfigReasons({ ...prod, ENABLE_TEST_PAYMENT: "true" }))).toContain("本番で無料テストの設定（ENABLE_TEST_PAYMENT=true）が有効になっている");
    expect(pausedMessage(dangerousConfigReasons({ ...prod, PAYMENT_PROVIDER: "mock" }))).toContain("疑似決済（PAYMENT_PROVIDER=mock）");
    const live = { SITE_STATUS: "development", STRIPE_SECRET_KEY: "sk_live_FAKEVAL1", PAYJP_PUBLIC_KEY: "pk_live_FAKEVAL2" };
    const msg = pausedMessage(dangerousConfigReasons(live));
    expect(msg).toContain("開発モードで本番用の決済キー（PAYJP_PUBLIC_KEY・STRIPE_SECRET_KEY）が設定されている");
    expect(msg).not.toMatch(/FAKEVAL|sk_live_|pk_live_/); // 値は出さない
    // 複数の理由はすべて並べる
    const both = pausedMessage(dangerousConfigReasons({ ...prod, ...live, ENABLE_TEST_PAYMENT: "true" }));
    expect(both).toContain("ENABLE_TEST_PAYMENT=true");
    expect(both).toContain("本番用の決済キー");
    // 本番以外の ENABLE_TEST_PAYMENT・公開中の本番用キーは危険な設定ではない
    expect(dangerousConfigReasons({ VERCEL_ENV: "preview", ENABLE_TEST_PAYMENT: "true" })).toEqual([]);
    expect(dangerousConfigReasons({ ...prod, PAYJP_SECRET_KEY: "sk_live_x" })).toEqual([]);
    expect(pausedMessage([])).toContain("危険な設定のため");
  });
});
