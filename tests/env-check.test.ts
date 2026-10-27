import { generateKeyPairSync, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { checkFirebasePrivateKey, checkProductionEnv, summarize } from "@/lib/ops/env-check";

// テスト用にその場で作る鍵（実際の鍵ではない）
const pem = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const pemEscaped = pem.replace(/\n/g, "\\n");
const pkcs1 = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs1", format: "pem" }).toString();
const ecKey = generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey.export({ type: "pkcs8", format: "pem" }).toString();

const SECRETS = {
  session: "S".repeat(20) + randomBytes(16).toString("hex"),
  dek: randomBytes(32).toString("base64"),
  cron: "C".repeat(10) + randomBytes(16).toString("hex"),
  liveKey: "sk_live_" + "Z9".repeat(12),
};

const good = {
  VERCEL_ENV: "production",
  DB_PROVIDER: "firestore",
  FIREBASE_PROJECT_ID: "uranai-prod-12345",
  FIREBASE_CLIENT_EMAIL: "firebase-adminsdk-abc@uranai-prod-12345.iam.gserviceaccount.com",
  FIREBASE_PRIVATE_KEY: pemEscaped,
  SESSION_SECRET: SECRETS.session,
  DATA_ENCRYPTION_KEY: SECRETS.dek,
  CRON_SECRET: SECRETS.cron,
  APP_URL: "https://uranai.example.jp",
  SITE_STATUS: "coming_soon",
};

const levelOf = (env: Record<string, string | undefined>, key: string) => checkProductionEnv(env).filter((r) => r.key === key).map((r) => r.level);

describe("check:env（本番の環境変数の形式確認）", () => {
  it("正しい設定ではエラーも注意もない", () => {
    const res = checkProductionEnv(good);
    expect(res.filter((r) => r.level !== "ok")).toEqual([]);
    expect(summarize(res).error).toBe(0);
  });

  it("FIREBASE_PRIVATE_KEY：\\n 表記・実際の改行の両方を受け付け、決済キー・欠け・空・別形式を見分ける", () => {
    expect(checkFirebasePrivateKey(pemEscaped).level).toBe("ok");
    expect(checkFirebasePrivateKey(pem).level).toBe("ok");
    expect(checkFirebasePrivateKey(`"${pemEscaped}"`).level).toBe("ok");
    // 今回の相談の状況：決済サービスのキーが入っている
    const live = checkFirebasePrivateKey(SECRETS.liveKey);
    expect(live.level).toBe("error");
    expect(live.message).toContain("決済サービスのキー");
    expect(checkFirebasePrivateKey(undefined).level).toBe("error");
    expect(checkFirebasePrivateKey("").level).toBe("unknown"); // Sensitive は取り出せず空になる
    expect(checkFirebasePrivateKey(pem.slice(0, 200) + "\n-----END PRIVATE KEY-----").level).toBe("error"); // 途中が欠けている
    expect(checkFirebasePrivateKey(pem.replace("-----END PRIVATE KEY-----", "")).level).toBe("error");
    expect(checkFirebasePrivateKey(pkcs1).level).toBe("warn");
    expect(checkFirebasePrivateKey(ecKey).level).toBe("warn");
  });

  it("決済キー・秘密鍵の取り違えや、ブラウザに公開される変数への秘密の値を検出する", () => {
    const env = { ...good, FIREBASE_PRIVATE_KEY: SECRETS.liveKey, SESSION_SECRET: pemEscaped, NEXT_PUBLIC_SITE_NAME: SECRETS.liveKey };
    const res = checkProductionEnv(env);
    expect(res.filter((r) => r.level === "error").map((r) => r.key).sort()).toEqual(
      ["FIREBASE_PRIVATE_KEY", "NEXT_PUBLIC_SITE_NAME", "NEXT_PUBLIC_SITE_NAME", "SESSION_SECRET"].sort(),
    );
  });

  it("本番で危険な設定・不足を検出する", () => {
    expect(levelOf({ ...good, PAYMENT_PROVIDER: "mock" }, "PAYMENT_PROVIDER")).toEqual(["error"]);
    expect(levelOf({ ...good, PAYMENT_PROVIDER: "stripe" }, "PAYMENT_PROVIDER")).toEqual(["warn"]); // 本番決済は未実装のため、本番では受け付けない
    expect(levelOf({ ...good, PAYMENT_PROVIDER: "square" }, "PAYMENT_PROVIDER")).toEqual(["error"]); // 未対応の値はアプリが起動時にエラー
    expect(levelOf({ ...good, ALLOW_MOCK_PAYMENTS_IN_PRODUCTION: "true" }, "ALLOW_MOCK_PAYMENTS_IN_PRODUCTION")).toEqual(["error"]);
    expect(levelOf({ ...good, PAYJP_SECRET_KEY: SECRETS.liveKey }, "PAYJP_SECRET_KEY")).toEqual(["warn"]); // 廃止：削除を促す
    expect(levelOf({ ...good, PAYMENT_PROVIDER: "payjp" }, "PAYMENT_PROVIDER")).toEqual(["warn"]); // 廃止：起動は止めない
    expect(levelOf({ ...good, CRON_SECRET: "" }, "CRON_SECRET")).toEqual(["error"]);
    expect(levelOf({ ...good, SESSION_SECRET: "short" }, "SESSION_SECRET")).toEqual(["error"]);
    expect(levelOf({ ...good, DATA_ENCRYPTION_KEY: "not-32-bytes" }, "DATA_ENCRYPTION_KEY")).toEqual(["error"]);
    expect(levelOf({ ...good, FIREBASE_PROJECT_ID: "demo-uranai" }, "FIREBASE_PROJECT_ID")).toEqual(["error"]);
    expect(levelOf({ ...good, FIREBASE_CLIENT_EMAIL: "x@other-proj.iam.gserviceaccount.com" }, "FIREBASE_CLIENT_EMAIL")).toEqual(["warn"]);
    expect(levelOf({ ...good, FIRESTORE_EMULATOR_HOST: "127.0.0.1:8080" }, "FIRESTORE_EMULATOR_HOST")).toEqual(["error"]);
    expect(levelOf({ ...good, APP_URL: "http://uranai.example.jp" }, "APP_URL")).toEqual(["error"]);
    expect(levelOf({ ...good, SITE_STATUS: "comingsoon" }, "SITE_STATUS")).toEqual(["error"]);
    expect(levelOf({ ...good, SITE_STATUS: "development" }, "SITE_STATUS")).toEqual(["ok"]);
    expect(levelOf({ ...good, SITE_STATUS: "development", STRIPE_SECRET_KEY: "sk_live_abcdefgh" }, "SITE_STATUS")).toEqual(["error"]);
    expect(levelOf({ ...good, SITE_STATUS: "development", PAYJP_SECRET_KEY: "sk_live_abcdefgh" }, "SITE_STATUS")).toEqual(["ok"]); // PAY.JP は廃止（読まない）
    expect(levelOf({ ...good, SITE_STATUS: "development", SESSION_SECRET: "a".repeat(40) }, "SESSION_SECRET")).toContain("warn");
    expect(levelOf({ ...good, ENABLE_TEST_PAYMENT: "true" }, "ENABLE_TEST_PAYMENT")).toEqual(["warn"]);
    expect(levelOf({ ...good, PRODUCTION_FIREBASE_PROJECT_ID: "other-project" }, "PRODUCTION_FIREBASE_PROJECT_ID")).toEqual(["error"]);
    expect(levelOf({ ...good, NEXT_PUBLIC_OPERATOR_EMAIL: "support@example.com" }, "NEXT_PUBLIC_OPERATOR_EMAIL")).toEqual(["error"]);
  });

  it("結果に秘密の値を一切含めない（エラーのときも）", () => {
    const env = {
      ...good,
      FIREBASE_PRIVATE_KEY: SECRETS.liveKey,
      PAYJP_SECRET_KEY: SECRETS.liveKey,
      SESSION_SECRET: SECRETS.session.slice(0, 10),
      NEXT_PUBLIC_X: SECRETS.liveKey,
      OTHER: pemEscaped,
    };
    const json = JSON.stringify(checkProductionEnv(env)) + JSON.stringify(checkProductionEnv(good));
    for (const v of [SECRETS.liveKey, SECRETS.session, SECRETS.session.slice(0, 10), SECRETS.dek, SECRETS.cron, "MII", good.FIREBASE_CLIENT_EMAIL, good.APP_URL, good.FIREBASE_PROJECT_ID]) {
      expect(json).not.toContain(v);
    }
  });
});
