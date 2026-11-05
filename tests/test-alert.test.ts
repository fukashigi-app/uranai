import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";

/**
 * Sandbox v2 専用のテスト異常の通知。Discord への HTTP は必ず模擬（実際には送らない）。
 * Firestore・Stripe には触れないことを、触れたら失敗する模擬で確かめる。
 */
const st = vi.hoisted(() => ({
  user: null as null | { id: string; email: string; name: string; role: "OPERATOR" | "STORE" },
  sameOrigin: true,
  sessionCalls: 0,
  firestoreCalls: 0,
}));
vi.mock("@/lib/auth/session", () => ({ getSessionUser: async () => (st.sessionCalls++, st.user) }));
vi.mock("@/lib/security/request", () => ({ isSameOrigin: () => st.sameOrigin }));
// Firestore・Stripe に触れたら失敗にする
vi.mock("@/lib/firestore/admin", () => ({
  fsdb: () => {
    st.firestoreCalls++;
    throw new Error("Firestore must not be used by the test alert");
  },
  C: {},
}));
vi.mock("stripe", () => ({
  default: class {
    constructor() {
      throw new Error("Stripe must not be used by the test alert");
    }
  },
}));

import { buildAlertMessage } from "@/lib/ops/alert-notifier";
import { buildTestAlertPayload, isTestAlertAllowed, TEST_ALERT_NOTICE } from "@/lib/ops/test-alert";

const TOKEN = randomBytes(51).toString("base64url");
const URL_OK = `https://discord.com/api/webhooks/${"3".repeat(18)}/${TOKEN}`;
const V2 = {
  VERCEL_ENV: "preview",
  VERCEL_GIT_COMMIT_REF: "preview/stripe-sandbox-v2",
  FIREBASE_PROJECT_ID: "uranai-stripe-sandbox-v2",
  PRODUCTION_FIREBASE_PROJECT_ID: "uranai-b6edf",
  FIREBASE_CLIENT_EMAIL: "firebase-adminsdk-ab12c@uranai-stripe-sandbox-v2.iam.gserviceaccount.com",
};
const OLD_PREVIEW = { ...V2, VERCEL_GIT_COMMIT_REF: "preview/stripe-verification", FIREBASE_PROJECT_ID: "uranai-preview", FIREBASE_CLIENT_EMAIL: "firebase-adminsdk-ab12c@uranai-preview.iam.gserviceaccount.com" };
const PRODUCTION = { VERCEL_ENV: "production", VERCEL_GIT_COMMIT_REF: "main", FIREBASE_PROJECT_ID: "uranai-b6edf", PRODUCTION_FIREBASE_PROJECT_ID: "uranai-b6edf", FIREBASE_CLIENT_EMAIL: "firebase-adminsdk-ab12c@uranai-b6edf.iam.gserviceaccount.com" };

describe("使える環境（Sandbox v2 の Preview だけ）", () => {
  it("Sandbox v2 の Preview だけ true", () => {
    expect(isTestAlertAllowed(V2)).toBe(true);
  });
  it("本番・旧 Preview・ローカル・Development・ブランチ違い・プロジェクト違いは false", () => {
    for (const e of [
      PRODUCTION,
      OLD_PREVIEW,
      { ...V2, VERCEL_ENV: undefined },
      { ...V2, VERCEL_ENV: "development" },
      { ...V2, VERCEL_ENV: "production" },
      { ...V2, VERCEL_GIT_COMMIT_REF: "main" },
      { ...V2, VERCEL_GIT_COMMIT_REF: "preview/stripe-sandbox-v2 " },
      { ...V2, VERCEL_GIT_COMMIT_REF: undefined },
      { ...V2, FIREBASE_PROJECT_ID: "uranai-preview" },
      { ...V2, FIREBASE_PROJECT_ID: "uranai-b6edf" },
    ]) {
      expect(isTestAlertAllowed(e), JSON.stringify(e)).toBe(false);
    }
  });
});

describe("テスト異常の本文", () => {
  it("見出しは【テスト異常】100円占い・決済の運用（Sandbox v2・テスト）。テストであること・対応不要を明記。メンションなし", () => {
    const p = buildTestAlertPayload(new Date("2026-11-05T05:00:00Z"));
    const lines = p.content.split("\n");
    expect(lines[0]).toBe("【テスト異常】100円占い・決済の運用（Sandbox v2・テスト）");
    expect(lines[1]).toBe("これは運営者が実施したテスト通知です。実際の障害ではありません。対応は不要です。");
    expect(TEST_ALERT_NOTICE).toBe(lines[1]);
    expect(lines[2]).toBe("送信の時刻：2026/11/05 14:00");
    expect(p.content).toContain("■ 定期処理の異常\n・テスト用の段階（作り物）：失敗（TestAlert）"); // 本番と同じ判定（collectCronIssues）を通る
    expect(p.content).not.toMatch(/【要対応】|【注意】|【正常】/);
    expect(p.allowed_mentions).toEqual({ parse: [] });
  });

  it("既存の異常の通知の本文は変わらない（テストの指定が無ければ今までどおり）", () => {
    const at = new Date("2026-11-05T03:17:00Z");
    const p = buildAlertMessage({ envLabel: "本番", at, issues: [{ severity: "error", text: "メンテナンス：失敗（X）" }], newAlerts: [], newReviews: [] });
    expect(p.content).toBe("【要対応】100円占い・決済の運用（本番） 2026/11/05 12:17\n■ 定期処理の異常\n・メンテナンス：失敗（X）");
    const w = buildAlertMessage({ envLabel: "Sandbox v2・テスト", at, issues: [{ severity: "warn", text: "決済監視：一部の項目を確認できませんでした" }], newAlerts: [], newReviews: [] });
    expect(w.content).toBe("【注意】100円占い・決済の運用（Sandbox v2・テスト） 2026/11/05 12:17\n■ 注意\n・決済監視：一部の項目を確認できませんでした");
  });
});

describe("POST /api/admin/test-alert", () => {
  const OPERATOR = { id: "op-1", email: "op@example.com", name: "運営", role: "OPERATOR" as const };
  let logs: string[];
  let fetchMock: Mock<(...a: unknown[]) => Promise<Response>>;
  const stubEnv = (e: Record<string, string | undefined>) => {
    for (const k of new Set([...Object.keys(V2), ...Object.keys(PRODUCTION), "OPS_ALERT_WEBHOOK_URL"])) vi.stubEnv(k, e[k] as string);
  };
  const load = async () => {
    vi.resetModules();
    return (await import("@/app/api/admin/test-alert/route")).POST;
  };
  const req = (mode: unknown) => new Request("https://sandbox.example.test/api/admin/test-alert", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ mode }) });
  const respond = (status: number) => (fetchMock = vi.fn(async () => new Response(null, { status })));

  beforeEach(() => {
    Object.assign(st, { user: OPERATOR, sameOrigin: true, sessionCalls: 0, firestoreCalls: 0 });
    stubEnv({ ...V2, OPS_ALERT_WEBHOOK_URL: URL_OK });
    respond(204);
    vi.stubGlobal("fetch", (...a: unknown[]) => fetchMock(...a)); // Discord への HTTP は必ず模擬
    logs = [];
    for (const k of ["log", "info", "warn", "error"] as const) vi.spyOn(console, k).mockImplementation((...a: unknown[]) => void logs.push(JSON.stringify(a)));
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });
  const noSecrets = async (res: Response) => {
    const body = await res.clone().text();
    for (const s of [TOKEN, URL_OK]) {
      expect(body).not.toContain(s);
      for (const l of logs) expect(l).not.toContain(s);
    }
    expect(res.headers.get("cache-control")).toContain("no-store");
  };

  it("本番・旧 Preview・ローカルでは 404（ログインの確認・送信もしない）", async () => {
    for (const e of [PRODUCTION, OLD_PREVIEW, { ...V2, VERCEL_ENV: undefined }]) {
      stubEnv({ ...e, OPS_ALERT_WEBHOOK_URL: URL_OK });
      const POST = await load();
      for (const mode of ["preview", "send"]) {
        const res = await POST(req(mode));
        expect(res.status, JSON.stringify(e)).toBe(404);
        await noSecrets(res);
      }
    }
    expect(st.sessionCalls).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("ログインしていない・店舗アカウントは 404、別のサイトからの送信は 403（送信しない）", async () => {
    for (const u of [null, { ...OPERATOR, role: "STORE" as const }]) {
      st.user = u;
      const POST = await load();
      expect((await POST(req("send"))).status).toBe(404);
    }
    st.user = OPERATOR;
    st.sameOrigin = false;
    const POST = await load();
    expect((await POST(req("send"))).status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("下書き：本文と送信先の状態だけを返し、送信しない", async () => {
    const POST = await load();
    const res = await POST(req("preview"));
    await noSecrets(res);
    expect(res.status).toBe(200);
    const j = (await res.json()) as { mode: string; content: string; webhook: string };
    expect(j.mode).toBe("preview");
    expect(j.webhook).toBe("configured");
    expect(j.content.split("\n")[0]).toBe("【テスト異常】100円占い・決済の運用（Sandbox v2・テスト）");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("送信：1回だけ送り、結果を返す（本文は下書きと同じ形・メンションなし）。Firestore・Stripe に触れない", async () => {
    const POST = await load();
    const res = await POST(req("send"));
    await noSecrets(res);
    expect(await res.json()).toEqual({ mode: "send", result: "sent" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(URL_OK);
    const body = JSON.parse(String(init.body)) as { content: string; allowed_mentions: unknown };
    expect(body.content.split("\n")[0]).toBe("【テスト異常】100円占い・決済の運用（Sandbox v2・テスト）");
    expect(body.content).toContain("これは運営者が実施したテスト通知です。実際の障害ではありません。対応は不要です。");
    expect(body.allowed_mentions).toEqual({ parse: [] });
    expect(init.redirect).toBe("error");
    expect(st.firestoreCalls).toBe(0);
  });

  it("二重の送信の防止：続けて送ると 429（送信しない）。同時に2回押しても送信は1回", async () => {
    let POST = await load();
    expect((await POST(req("send"))).status).toBe(200);
    const again = await POST(req("send"));
    expect(again.status).toBe(429);
    expect(await again.json()).toMatchObject({ result: "not_sent", error: "rate_limited" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // 同時に2回（新しいサーバーのプロセス）
    POST = await load();
    fetchMock = vi.fn(() => new Promise<Response>((ok) => setTimeout(() => ok(new Response(null, { status: 204 })), 30)));
    const both = await Promise.all([POST(req("send")), POST(req("send"))]);
    expect(both.map((r) => r.status).sort()).toEqual([200, 429]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("送信の失敗：失敗の種類を返し、自動では送り直さない（続けての送信も制限）", async () => {
    for (const [mk, err] of [
      [() => respond(500), "http_500"],
      [() => respond(429), "http_429"],
      [() => respond(404), "http_404"],
      [() => (fetchMock = vi.fn(async () => Promise.reject(Object.assign(new Error("t"), { name: "TimeoutError" })))), "timeout"],
      [() => (fetchMock = vi.fn(async () => Promise.reject(new TypeError(`fetch failed ${URL_OK}`)))), "network_error"],
    ] as const) {
      mk();
      const POST = await load();
      const res = await POST(req("send"));
      await noSecrets(res);
      expect(await res.json(), err).toEqual({ mode: "send", result: "failed", error: err });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect((await POST(req("send"))).status).toBe(429); // 失敗の直後の連続の送信も制限（自動・連続で送り直さない）
      expect(fetchMock).toHaveBeenCalledTimes(1);
    }
  });

  it("送信先が未登録・不正なら送らない（409）。不正な mode は 400", async () => {
    stubEnv({ ...V2, OPS_ALERT_WEBHOOK_URL: "" });
    let POST = await load();
    expect(await (await POST(req("send"))).json()).toMatchObject({ result: "not_sent", error: "not_configured" });
    stubEnv({ ...V2, OPS_ALERT_WEBHOOK_URL: "https://evil.example/api/webhooks/1/2" });
    POST = await load();
    const r = await POST(req("send"));
    expect(r.status).toBe(409);
    expect(await r.json()).toMatchObject({ error: "invalid_url" });
    expect(await (await POST(req("preview"))).json()).toMatchObject({ webhook: "invalid_url" });
    expect((await POST(req("other"))).status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
