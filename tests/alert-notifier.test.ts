import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { alertWebhookStatus, buildAlertMessage, collectCronIssues, diffOpenItems, DISCORD_CONTENT_LIMIT, environmentLabelOf, parseDiscordWebhookUrl, sendDiscordAlert } from "@/lib/ops/alert-notifier";

// 形だけの送信先（実在しない ID とトークン。その場で作る。外には送らない）
const ID = "1".repeat(18);
const TOKEN = randomBytes(51).toString("base64url");
const URL_OK = `https://discord.com/api/webhooks/${ID}/${TOKEN}`;

describe("送信先の確認（Discord の正規の Webhook だけ）", () => {
  it("discord.com・discordapp.com の https の Webhook を受け付ける（前後の空白は取り除く）", () => {
    expect(parseDiscordWebhookUrl(URL_OK)).toBe(URL_OK);
    expect(parseDiscordWebhookUrl(`  ${URL_OK.replace("discord.com", "discordapp.com")}\n`)).toBe(URL_OK.replace("discord.com", "discordapp.com"));
    expect(alertWebhookStatus({ OPS_ALERT_WEBHOOK_URL: URL_OK })).toBe("configured");
  });

  it("http・別のホスト・似せたホスト・ポート・利用者名・クエリ・フラグメント・形の違うパス・短いトークンは拒否", () => {
    const bad = [
      URL_OK.replace("https://", "http://"),
      URL_OK.replace("discord.com", "evil.example"),
      URL_OK.replace("discord.com", "discord.com.evil.example"),
      URL_OK.replace("discord.com", "evil.discord.com"),
      URL_OK.replace("discord.com", "discord.com:8443"),
      URL_OK.replace("https://", "https://user:pass@"),
      `${URL_OK}?wait=true`,
      `${URL_OK}#x`,
      `${URL_OK}/github`,
      URL_OK.replace("/api/webhooks/", "/api/v10/webhooks/"),
      `https://discord.com/api/webhooks/abc/${TOKEN}`,
      `https://discord.com/api/webhooks/${ID}/short`,
      "",
      "not a url",
    ];
    for (const u of bad) expect(parseDiscordWebhookUrl(u), u).toBeNull();
    expect(alertWebhookStatus({})).toBe("not_configured");
    expect(alertWebhookStatus({ OPS_ALERT_WEBHOOK_URL: bad[1] })).toBe("invalid");
  });
});

describe("通知する異常の判定", () => {
  const ok = (name: string) => ({ name, status: "ok", reason: null, errorCode: null });
  it("段階の失敗・時間切れ・時間不足、ロックの異常、復旧・再確認の失敗、監視の失敗・一部未確認・時間不足を集める", () => {
    const issues = collectCronIssues({
      runStatus: "partial",
      unsettled: true,
      phases: [
        { name: "maintenance", status: "failed", reason: null, errorCode: "SimulatedError" },
        { name: "webhookRecovery", status: "timed_out", reason: null, errorCode: "PhaseTimeout", abortSettled: false },
        { name: "recheckRecovery", status: "skipped", reason: "deadline", errorCode: null },
        { name: "paymentMonitor", status: "skipped", reason: "deadline", errorCode: null },
      ],
      webhookRecovery: { status: "completed", failed: 2 },
      recheckRecovery: { status: "completed", error: 1, rejected: 1 },
      paymentMonitor: { status: "skipped_time" },
    });
    const text = issues.map((i) => `${i.severity}:${i.text}`).join("\n");
    expect(text).toContain("error:メンテナンス：失敗（SimulatedError）");
    expect(text).toContain("error:Webhook の自動復旧：時間切れ（止まらずに続いている可能性）");
    expect(text).toContain("warn:決済確定の後の自動再確認：時間不足で実行しませんでした");
    expect(text).toContain("error:Webhook の自動復旧：処理できなかった通知 2件");
    expect(text).toContain("error:自動再確認：失敗 1件");
    expect(text).toContain("warn:自動再確認：拒否 1件");
    expect(text).toContain("warn:決済監視：時間不足で点検しませんでした");
    expect(text).toContain("止まらなかった段階");
  });

  it("すべて正常・監視が busy・異常ありでも、定期処理としての異常は無し（異常の一覧は別に通知）", () => {
    for (const pm of ["ok", "issues", "busy", "unsupported"]) {
      expect(collectCronIssues({ runStatus: "completed", unsettled: false, phases: ["maintenance", "webhookRecovery", "recheckRecovery", "paymentMonitor"].map(ok), webhookRecovery: { status: "completed", failed: 0 }, recheckRecovery: { status: "completed", error: 0 }, paymentMonitor: { status: pm } }), pm).toEqual([]);
    }
    expect(collectCronIssues({ runStatus: "lock_lost", unsettled: false, phases: [], paymentMonitor: { status: "partial" } }).map((i) => i.severity)).toEqual(["error", "warn"]);
  });

  it("エラーの識別子は決まった形だけ（文面・秘密の値は出さない）", () => {
    const issues = collectCronIssues({ runStatus: "partial", unsettled: false, phases: [{ name: "maintenance", status: "failed", reason: null, errorCode: `boom ${TOKEN} sk_test_x` }] });
    expect(issues[0].text).toBe("メンテナンス：失敗");
  });

  it("新しい未確認だけを選び、次の状態は今の未確認の一覧（確認済みになったものは消える）", () => {
    const r = diffOpenItems(["a", "b", "gone"], [{ id: "a" }, { id: "c" }]);
    expect(r.fresh.map((x) => x.id)).toEqual(["c"]);
    expect(r.next).toEqual(["a", "c"]);
  });
});

describe("本文", () => {
  it("環境・異常の種類と件数・案内だけ。メンションは無効。ID・送信先は入れない", () => {
    const p = buildAlertMessage({
      envLabel: "Sandbox v2・テスト",
      at: new Date("2026-11-05T03:17:00Z"),
      issues: [{ severity: "error", text: "メンテナンス：失敗（SimulatedError）" }],
      newAlerts: [
        { label: "Stripe では支払い済みなのに、アプリで決済が確定していない", mode: "テスト" },
        { label: "Stripe では支払い済みなのに、アプリで決済が確定していない", mode: "テスト" },
        { label: "@everyone 決済の API でサーバーのエラー（5xx）が起きた", mode: "不明" },
      ],
      newReviews: [{ label: "本番とテストの取り違え（受け付けていません）", mode: "本番" }],
      deletionDelay: { runs: 2, items: ["占い結果（30日）：件数の上限で打ち切り、古いものが残っています（残りの件数は不明）"] },
      listsExceeded: { alerts: true, reviews: false, limit: 200 },
      adminUrl: "https://example.test/admin/payment-monitor",
    });
    expect(p.allowed_mentions).toEqual({ parse: [] });
    expect(p.content).toContain("【要対応】100円占い・決済の運用（Sandbox v2・テスト） 2026/11/05 12:17");
    expect(p.content).toContain("■ 新しい未確認の決済監視の異常：3件");
    expect(p.content).toContain("・Stripe では支払い済みなのに、アプリで決済が確定していない（テスト） ×2");
    expect(p.content).toContain("■ 新しい決済要確認：1件");
    expect(p.content).toContain("■ データの削除の遅れ（2回続けて）\n・占い結果（30日）：件数の上限で打ち切り、古いものが残っています（残りの件数は不明）");
    expect(p.content).toContain("■ 未確認の決済監視の異常が200件を超えています。一部の異常を通知できていない可能性があります");
    expect(p.content).toContain("確認：https://example.test/admin/payment-monitor");
    expect(p.content).not.toContain(TOKEN);
  });

  it("Discord の上限より短く切る", () => {
    const many = Array.from({ length: 200 }, (_, i) => ({ severity: "error" as const, text: `段階${i}：失敗（${"X".repeat(40)}）` }));
    const p = buildAlertMessage({ envLabel: "本番", at: new Date(), issues: many, newAlerts: [], newReviews: [] });
    expect(p.content.length).toBeLessThanOrEqual(DISCORD_CONTENT_LIMIT);
    expect(p.content).toContain("（以下省略）");
  });

  it("環境の名前", () => {
    expect(environmentLabelOf({ VERCEL_ENV: "production" }, false)).toBe("本番");
    expect(environmentLabelOf({ VERCEL_ENV: "preview" }, true)).toBe("Sandbox v2・テスト");
    expect(environmentLabelOf({ VERCEL_ENV: "preview" }, false)).toBe("Preview・テスト");
    expect(environmentLabelOf({}, false)).toBe("ローカル");
  });
});

describe("送信", () => {
  const payload = { content: "x", allowed_mentions: { parse: [] as [] } };
  it("正規の送信先に JSON で POST する（リダイレクトしない・時間を区切る）", async () => {
    const f = vi.fn(async () => new Response(null, { status: 204 }));
    expect(await sendDiscordAlert(URL_OK, payload, { fetchImpl: f as unknown as typeof fetch })).toEqual({ ok: true });
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(URL_OK);
    expect(init.method).toBe("POST");
    expect(init.redirect).toBe("error");
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(JSON.parse(String(init.body))).toEqual(payload);
  });
  it("失敗・時間切れ・通信の失敗は分類だけ（例外にしない・URL を返さない）", async () => {
    const status = (n: number) => (async () => new Response(null, { status: n })) as unknown as typeof fetch;
    expect(await sendDiscordAlert(URL_OK, payload, { fetchImpl: status(429) })).toEqual({ ok: false, error: "http_429" });
    expect(await sendDiscordAlert(URL_OK, payload, { fetchImpl: status(500) })).toEqual({ ok: false, error: "http_500" });
    const timeout = (async () => Promise.reject(Object.assign(new Error("t"), { name: "TimeoutError" }))) as unknown as typeof fetch;
    expect(await sendDiscordAlert(URL_OK, payload, { fetchImpl: timeout })).toEqual({ ok: false, error: "timeout" });
    const net = (async () => Promise.reject(new TypeError(`fetch failed ${URL_OK}`))) as unknown as typeof fetch;
    const r = await sendDiscordAlert(URL_OK, payload, { fetchImpl: net });
    expect(r).toEqual({ ok: false, error: "network_error" });
  });
  it("正規の送信先でなければ送らない", async () => {
    const f = vi.fn();
    expect(await sendDiscordAlert("https://evil.example/api/webhooks/1/2", payload, { fetchImpl: f as unknown as typeof fetch })).toEqual({ ok: false, error: "invalid_url" });
    expect(f).not.toHaveBeenCalled();
  });
});

describe("週1回の正常の報告（本文）", () => {
  it("記録から得た値だけを書く。取得できない値は「取得不可」。届かないことは自動で検知できないと明記する", async () => {
    const { buildHeartbeatMessage } = await import("@/lib/ops/alert-notifier");
    const at = new Date("2026-11-12T18:17:00Z");
    const p = buildHeartbeatMessage({ envLabel: "Sandbox v2・テスト", at, runs7d: { count: 7, since: new Date("2026-11-01T00:00:00Z") }, openAlerts: { count: 0, exceeded: false }, openReviews: { count: 200, exceeded: true }, adminUrl: "https://example.test/admin/payment-monitor" });
    expect(p.allowed_mentions).toEqual({ parse: [] });
    expect(p.content).toContain("【正常】100円占い・決済の運用（Sandbox v2・テスト） 週1回の定期報告");
    expect(p.content).toContain("・直近7日の実行：7回（今回を含む）");
    expect(p.content).toContain("・未確認：決済監視の異常 0件・決済要確認 200件以上");
    expect(p.content).toContain("届かないことは自動では検知できません");
    const q = buildHeartbeatMessage({ envLabel: "本番", at, runs7d: null, openAlerts: null, openReviews: null });
    expect(q.content).toContain("・直近7日の実行：取得不可");
    expect(q.content).toContain("決済監視の異常 取得不可・決済要確認 取得不可");
    const r = buildHeartbeatMessage({ envLabel: "本番", at, runs7d: { count: 2, since: new Date("2026-11-11T00:00:00Z") }, openAlerts: { count: 1, exceeded: false }, openReviews: { count: 0, exceeded: false } });
    expect(r.content).toMatch(/・直近7日の実行：2回（今回を含む。記録は 2026\/11\/11 09:00 から）/);
  });
});

// ---- 通知の流れ（Firestore の状態・一覧は模擬） ----
const DAY = 86_400_000;
const st = vi.hoisted(() => ({
  state: { notifiedAlertIds: [] as string[], notifiedReviewIds: [] as string[], deletionDelayRuns: 0, lastHeartbeatAt: null as Date | null },
  writes: [] as { status: string; errorCode: string | null; sent: boolean; ids: string[] }[],
  alerts: [] as { id: string; kind: string; mode: string }[],
  alertsTruncated: false,
  reviews: [] as { id: string; kind: string; livemode: boolean | null }[],
  tasks: [] as { task: string; truncated: boolean; stoppedBy: "time" | "aborted" | "cap" | null; overdueFound: number }[],
  history: { starts: [] as Date[], since: null as Date | null } as { starts: Date[]; since: Date | null } | "fail",
  listDelayMs: 0,
  writeFails: false,
  firestore: true,
}));
vi.mock("@/lib/data-provider", async (orig) => ({ ...(await orig<object>()), isFirestore: () => st.firestore }));
vi.mock("@/lib/env", async (orig) => ({ ...(await orig<object>()), env: () => ({ APP_URL: "https://sandbox.example.test" }) }));
vi.mock("@/lib/firestore/alert-notification", () => ({
  readAlertNotificationState: async () => ({ ...st.state }),
  writeAlertNotificationState: async (s: typeof st.state, meta: { status: string; errorCode: string | null; sent: boolean }) => {
    if (st.writeFails) throw Object.assign(new Error("firestore down"), { name: "SimulatedWriteError" });
    st.state = { ...s };
    st.writes.push({ ...meta, ids: s.notifiedAlertIds });
  },
  readMaintenanceTaskStats: async () => st.tasks,
  readCronRunHistory: async () => {
    if (st.history === "fail") throw new Error("read failed");
    return st.history;
  },
}));
vi.mock("@/lib/firestore/payment-alerts", () => ({
  listPaymentAlerts: async () => {
    if (st.listDelayMs) await new Promise((r) => setTimeout(r, st.listDelayMs));
    return { rows: st.alerts, truncated: st.alertsTruncated };
  },
}));
vi.mock("@/lib/firestore/payment-reviews", () => ({ listPaymentReviews: async (o: { limit?: number }) => st.reviews.slice(0, o.limit ?? 200), PAYMENT_REVIEW_LABEL: { mode_mismatch: "本番とテストの取り違え（受け付けていません）" } }));

describe("通知の流れ（notifyCronRun）", () => {
  const quiet = { runStatus: "completed", unsettled: false, phases: [], maintenanceOk: true };
  const alertA1 = { id: "a1", kind: "stripe_paid_not_confirmed", mode: "test" };
  let logs: string[];
  beforeEach(() => {
    vi.stubEnv("OPS_ALERT_WEBHOOK_URL", URL_OK);
    Object.assign(st, {
      // 既定：正常の報告は最近送った（正常の報告の場面だけ変える）
      state: { notifiedAlertIds: [], notifiedReviewIds: [], deletionDelayRuns: 0, lastHeartbeatAt: new Date(Date.now() - DAY) },
      writes: [],
      alerts: [],
      alertsTruncated: false,
      reviews: [],
      tasks: [],
      history: { starts: [], since: null },
      listDelayMs: 0,
      writeFails: false,
      firestore: true,
    });
    logs = [];
    for (const k of ["log", "warn", "error"] as const) vi.spyOn(console, k).mockImplementation((...a: unknown[]) => void logs.push(JSON.stringify(a)));
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });
  const sender = (status = 204) => {
    const bodies: string[] = [];
    const signals: AbortSignal[] = [];
    const f = vi.fn(async (_u: string, init: RequestInit) => (bodies.push(String(init.body)), signals.push(init.signal!), new Response(null, { status })));
    return { f: f as unknown as typeof fetch, bodies, signals, calls: f };
  };
  const content = (b: string) => (JSON.parse(b) as { content: string }).content;

  it("送信先が未登録・不正なら送らない（状態も変えない）", async () => {
    const { notifyCronRun } = await import("@/lib/services/alert-notification");
    const s = sender();
    vi.stubEnv("OPS_ALERT_WEBHOOK_URL", "");
    expect((await notifyCronRun({ ...quiet, runStatus: "partial", phases: [{ name: "maintenance", status: "failed", reason: null, errorCode: "X" }] }, { timeoutMs: 5000, fetchImpl: s.f })).status).toBe("not_configured");
    vi.stubEnv("OPS_ALERT_WEBHOOK_URL", "https://evil.example/api/webhooks/1/2");
    expect((await notifyCronRun(quiet, { timeoutMs: 5000, fetchImpl: s.f })).status).toBe("invalid_url");
    expect(s.calls).not.toHaveBeenCalled();
    expect(st.writes).toEqual([]);
    expect(logs.join(" ")).not.toContain("evil.example");
  });

  it("異常が無く、正常の報告の期限（7日）も来ていなければ送らない（状態だけ更新）", async () => {
    const { notifyCronRun } = await import("@/lib/services/alert-notification");
    const s = sender();
    st.state.lastHeartbeatAt = new Date(Date.now() - 7 * DAY + 60_000); // 7日の1分前
    expect(await notifyCronRun(quiet, { timeoutMs: 5000, fetchImpl: s.f })).toMatchObject({ status: "nothing" });
    expect(s.calls).not.toHaveBeenCalled();
    expect(st.writes.map((w) => w.status)).toEqual(["nothing"]);
  });

  it("正常の報告：履歴が無ければ初回に送る。直近7日の実行の回数は記録から数える。送信の成功で lastHeartbeatAt を進め、7日未満は送らず、7日を過ぎたら送る", async () => {
    const { notifyCronRun } = await import("@/lib/services/alert-notification");
    const s = sender();
    const now = Date.now();
    st.state.lastHeartbeatAt = null;
    st.history = { starts: [new Date(now - 8 * DAY), new Date(now - 3 * DAY), new Date(now - 2 * DAY), new Date(now - DAY)], since: new Date(now - 10 * DAY) };
    st.alerts = [];
    st.reviews = [];
    expect(await notifyCronRun({ ...quiet, startedAt: new Date(now) }, { timeoutMs: 5000, fetchImpl: s.f })).toMatchObject({ status: "heartbeat" });
    expect(content(s.bodies[0])).toContain("【正常】");
    expect(content(s.bodies[0])).toContain("・直近7日の実行：4回（今回を含む）"); // 8日前は含めない・今回を1回として足す
    expect(content(s.bodies[0])).toContain("・未確認：決済監視の異常 0件・決済要確認 0件");
    expect(st.state.lastHeartbeatAt).toBeInstanceOf(Date);
    // 7日未満：送らない
    expect(await notifyCronRun(quiet, { timeoutMs: 5000, fetchImpl: s.f })).toMatchObject({ status: "nothing" });
    expect(s.calls).toHaveBeenCalledTimes(1);
    // 7日を過ぎた：送る
    st.state.lastHeartbeatAt = new Date(Date.now() - 7 * DAY - 1000);
    expect(await notifyCronRun(quiet, { timeoutMs: 5000, fetchImpl: s.f })).toMatchObject({ status: "heartbeat" });
    expect(s.calls).toHaveBeenCalledTimes(2);
  });

  it("正常の報告：実行の履歴を読めなければ「取得不可」（推測しない）", async () => {
    const { notifyCronRun } = await import("@/lib/services/alert-notification");
    const s = sender();
    st.state.lastHeartbeatAt = null;
    st.history = "fail";
    await notifyCronRun(quiet, { timeoutMs: 5000, fetchImpl: s.f });
    expect(content(s.bodies[0])).toContain("・直近7日の実行：取得不可");
  });

  it("異常がある回は正常の報告を送らない（異常の通知だけ。lastHeartbeatAt は変えない）", async () => {
    const { notifyCronRun } = await import("@/lib/services/alert-notification");
    const s = sender();
    st.state.lastHeartbeatAt = null;
    st.alerts = [alertA1];
    expect(await notifyCronRun(quiet, { timeoutMs: 5000, fetchImpl: s.f })).toMatchObject({ status: "sent", newAlerts: 1 });
    expect(content(s.bodies[0])).toContain("【要対応】");
    expect(content(s.bodies[0])).not.toContain("【正常】");
    expect(st.state.lastHeartbeatAt).toBeNull();
  });

  it("正常の報告の送信に失敗したら lastHeartbeatAt を進めず、次の回にもう一度送る", async () => {
    const { notifyCronRun } = await import("@/lib/services/alert-notification");
    st.state.lastHeartbeatAt = null;
    expect(await notifyCronRun(quiet, { timeoutMs: 5000, fetchImpl: sender(500).f })).toMatchObject({ status: "send_failed", errorCode: "http_500" });
    expect(st.state.lastHeartbeatAt).toBeNull();
    const s = sender();
    expect(await notifyCronRun(quiet, { timeoutMs: 5000, fetchImpl: s.f })).toMatchObject({ status: "heartbeat" });
    expect(st.state.lastHeartbeatAt).toBeInstanceOf(Date);
  });

  it("新しい未確認の異常は1回だけ送る（同じ未確認は次の回に送らない。確認済みにして再び出たら送る）", async () => {
    const { notifyCronRun } = await import("@/lib/services/alert-notification");
    const s = sender();
    st.alerts = [alertA1];
    st.reviews = [{ id: "r1", kind: "mode_mismatch", livemode: true }];
    expect(await notifyCronRun(quiet, { timeoutMs: 5000, fetchImpl: s.f })).toMatchObject({ status: "sent", newAlerts: 1, newReviews: 1 });
    expect(content(s.bodies[0])).toContain("Stripe では支払い済みなのに、アプリで決済が確定していない（テスト） ×1");
    expect(content(s.bodies[0])).toContain("本番とテストの取り違え（受け付けていません）（本番） ×1");
    expect(s.bodies[0]).not.toContain("a1");
    expect(await notifyCronRun(quiet, { timeoutMs: 5000, fetchImpl: s.f })).toMatchObject({ status: "nothing" });
    expect(s.calls).toHaveBeenCalledTimes(1);
    st.alerts = []; // 確認済みにした
    await notifyCronRun(quiet, { timeoutMs: 5000, fetchImpl: s.f });
    st.alerts = [alertA1]; // 再び未確認
    expect(await notifyCronRun(quiet, { timeoutMs: 5000, fetchImpl: s.f })).toMatchObject({ status: "sent", newAlerts: 1 });
  });

  it("送信に失敗したら通知済みにしない（次の回にもう一度送る）。失敗の種類だけを記録し、URL を出さない", async () => {
    const { notifyCronRun } = await import("@/lib/services/alert-notification");
    st.alerts = [alertA1];
    expect(await notifyCronRun(quiet, { timeoutMs: 5000, fetchImpl: sender(500).f })).toMatchObject({ status: "send_failed", errorCode: "http_500" });
    expect(st.state.notifiedAlertIds).toEqual([]);
    const s = sender();
    expect(await notifyCronRun(quiet, { timeoutMs: 5000, fetchImpl: s.f })).toMatchObject({ status: "sent", newAlerts: 1 });
    expect(logs.join(" ")).not.toContain(TOKEN);
  });

  it("送信の成功の後に記録が失敗：sent_unrecorded（送信は成功の扱い）。次の回は重複して送る（取りこぼさない）", async () => {
    const { notifyCronRun } = await import("@/lib/services/alert-notification");
    const s = sender();
    st.alerts = [alertA1];
    st.writeFails = true;
    expect(await notifyCronRun(quiet, { timeoutMs: 5000, fetchImpl: s.f })).toMatchObject({ status: "sent_unrecorded", newAlerts: 1, errorCode: "SimulatedWriteError" });
    expect(s.calls).toHaveBeenCalledTimes(1);
    st.writeFails = false;
    expect(await notifyCronRun(quiet, { timeoutMs: 5000, fetchImpl: s.f })).toMatchObject({ status: "sent", newAlerts: 1 });
    expect(s.calls).toHaveBeenCalledTimes(2);
    // 正常の報告でも同じ（送れたが記録できない）
    st.alerts = [];
    st.state.notifiedAlertIds = [];
    st.state.lastHeartbeatAt = null;
    st.writeFails = true;
    expect(await notifyCronRun(quiet, { timeoutMs: 5000, fetchImpl: s.f })).toMatchObject({ status: "heartbeat_unrecorded" });
    expect(logs.join(" ")).not.toContain("firestore down");
  });

  it("時間の区切り：読み込みの途中で区切りを過ぎたら、その後に送信を始めない", async () => {
    const { notifyCronRun } = await import("@/lib/services/alert-notification");
    const s = sender();
    st.alerts = [alertA1];
    st.listDelayMs = 300;
    const t0 = Date.now();
    expect(await notifyCronRun(quiet, { timeoutMs: 100, fetchImpl: s.f })).toMatchObject({ status: "error", errorCode: "timeout" });
    expect(Date.now() - t0).toBeLessThan(1000);
    await new Promise((r) => setTimeout(r, 500)); // 裏の処理が読み込みを終えるまで待つ
    expect(s.calls).not.toHaveBeenCalled();
  });

  it("時間の区切り：残りの時間が短ければ送信を始めない（skipped_time）", async () => {
    const { notifyCronRun } = await import("@/lib/services/alert-notification");
    const s = sender();
    st.alerts = [alertA1];
    expect(await notifyCronRun(quiet, { timeoutMs: 1000, fetchImpl: s.f })).toMatchObject({ status: "skipped_time" });
    expect(s.calls).not.toHaveBeenCalled();
    expect(st.state.notifiedAlertIds).toEqual([]); // 送っていないので通知済みにしない
  });

  it("時間の区切り：送信中に区切りを過ぎたら、送信の HTTP にも中止の合図が届く", async () => {
    const { notifyCronRun } = await import("@/lib/services/alert-notification");
    st.alerts = [alertA1];
    let seen: AbortSignal | null = null;
    const hang = ((_u: string, init: RequestInit) => {
      seen = init.signal!;
      return new Promise<Response>((_, rej) => init.signal!.addEventListener("abort", () => rej(Object.assign(new Error("aborted"), { name: "AbortError" }))));
    }) as unknown as typeof fetch;
    // 送信の時間は残りの時間から決める（全体の区切りより少し前に、送信そのものが中止される）。どちらでも HTTP には中止の合図が届く
    const t0 = Date.now();
    const r = await notifyCronRun(quiet, { timeoutMs: 2000, fetchImpl: hang });
    expect(Date.now() - t0).toBeLessThan(2500);
    expect(["send_failed", "error"]).toContain(r.status);
    expect(r.errorCode).toBe("timeout");
    await new Promise((r2) => setTimeout(r2, 20));
    expect(seen!.aborted).toBe(true);
    expect(st.state.notifiedAlertIds).toEqual([]); // 送れていない：通知済みにしない
  });

  it("定期処理の異常は毎回送る（その回の異常）", async () => {
    const { notifyCronRun } = await import("@/lib/services/alert-notification");
    const s = sender();
    const bad = { ...quiet, runStatus: "partial", phases: [{ name: "paymentMonitor", status: "failed", reason: null, errorCode: "MonitorChecksFailed" }], paymentMonitor: { status: "failed" } };
    expect(await notifyCronRun(bad, { timeoutMs: 5000, fetchImpl: s.f })).toMatchObject({ status: "sent", issues: 2 });
    expect(await notifyCronRun(bad, { timeoutMs: 5000, fetchImpl: s.f })).toMatchObject({ status: "sent" });
    expect(content(s.bodies[0])).toContain("決済監視：失敗（MonitorChecksFailed）");
  });

  it("保存期間の削除の遅れ（すべてが対象の削除）：2回続けて打ち切りで送り、その後は7回ごと。打ち切りが無くなれば数え直す。メンテナンスの失敗の回は数えない", async () => {
    const { notifyCronRun } = await import("@/lib/services/alert-notification");
    const s = sender();
    st.tasks = [{ task: "purgeResults", truncated: true, stoppedBy: "cap", overdueFound: 0 }];
    const sentAt: number[] = [];
    for (let i = 1; i <= 10; i++) if ((await notifyCronRun(quiet, { timeoutMs: 5000, fetchImpl: s.f })).status === "sent") sentAt.push(i);
    expect(sentAt).toEqual([2, 9]);
    expect(content(s.bodies[0])).toContain("・占い結果（30日）：件数の上限で打ち切り、古いものが残っています（残りの件数は不明）");
    await notifyCronRun({ ...quiet, maintenanceOk: false }, { timeoutMs: 5000, fetchImpl: s.f });
    expect(st.state.deletionDelayRuns).toBe(10);
    st.tasks = [{ task: "purgeResults", truncated: false, stoppedBy: null, overdueFound: 0 }];
    await notifyCronRun(quiet, { timeoutMs: 5000, fetchImpl: s.f });
    expect(st.state.deletionDelayRuns).toBe(0);
  });

  it("未決済の注文（7日）の削除の遅れ：続きの位置からの読み込み（件数の上限）・通常の区切りは遅れとしない", async () => {
    const { notifyCronRun } = await import("@/lib/services/alert-notification");
    const s = sender();
    for (const t of [
      { task: "purgeCheckouts", truncated: true, stoppedBy: "cap" as const, overdueFound: 0 }, // 古い順の読み込みが件数の上限（一周の途中）
      { task: "purgeCheckouts", truncated: false, stoppedBy: null, overdueFound: 0 }, // 新しい順の上限で区切った（通常）
    ]) {
      st.tasks = [t];
      for (let i = 0; i < 3; i++) expect((await notifyCronRun(quiet, { timeoutMs: 5000, fetchImpl: s.f })).status).toBe("nothing");
      expect(st.state.deletionDelayRuns).toBe(0);
    }
    expect(s.calls).not.toHaveBeenCalled();
  });

  it("未決済の注文（7日）の削除の遅れ：時間の上限で止まった／期限を過ぎた注文が見つかったら、2回続けて送る（件数は実際に見つけた数だけ）", async () => {
    const { notifyCronRun } = await import("@/lib/services/alert-notification");
    const s = sender();
    st.tasks = [{ task: "purgeCheckouts", truncated: true, stoppedBy: "time", overdueFound: 3 }];
    expect((await notifyCronRun(quiet, { timeoutMs: 5000, fetchImpl: s.f })).status).toBe("nothing"); // 1回目は送らない
    expect(await notifyCronRun(quiet, { timeoutMs: 5000, fetchImpl: s.f })).toMatchObject({ status: "sent" });
    const c = content(s.bodies[0]);
    expect(c).toContain("・未決済の注文（7日）：保存期間を過ぎて残っていた削除の対象の注文を 3件 確認しました（今回の削除の対象）");
    expect(c).toContain("・未決済の注文（7日）：時間の上限で、最後まで削除できませんでした（残りの件数は不明）");
    // その後は毎回は送らない（重複の抑制。7回ごとに再び送る）
    for (let i = 0; i < 6; i++) expect((await notifyCronRun(quiet, { timeoutMs: 5000, fetchImpl: s.f })).status).toBe("nothing");
    expect(s.calls).toHaveBeenCalledTimes(1);
  });

  it("未確認の一覧が上限を超えた（確定）：本文で知らせ、読めなかった分の通知済みの ID は消さない", async () => {
    const { notifyCronRun, NOTIFY_LIST_LIMIT } = await import("@/lib/services/alert-notification");
    const s = sender();
    st.state.notifiedAlertIds = ["old_beyond_window", "a1"];
    st.alerts = [alertA1, { id: "a2", kind: "stripe_paid_not_confirmed", mode: "test" }];
    st.alertsTruncated = true;
    expect(await notifyCronRun(quiet, { timeoutMs: 5000, fetchImpl: s.f })).toMatchObject({ status: "sent", newAlerts: 1 });
    expect(content(s.bodies[0])).toContain(`■ 未確認の決済監視の異常が${NOTIFY_LIST_LIMIT}件を超えています。一部の異常を通知できていない可能性があります`);
    expect(st.state.notifiedAlertIds).toEqual(["a1", "a2", "old_beyond_window"]);
    // 決済要確認：1件多く読んで、上限を超えたかを確かめる
    st.alertsTruncated = false;
    st.alerts = [];
    st.reviews = Array.from({ length: NOTIFY_LIST_LIMIT + 1 }, (_, i) => ({ id: `r${i}`, kind: "mode_mismatch", livemode: false }));
    await notifyCronRun(quiet, { timeoutMs: 5000, fetchImpl: s.f });
    expect(content(s.bodies[1])).toContain(`■ 未確認の決済要確認が${NOTIFY_LIST_LIMIT}件を超えています`);
    expect(content(s.bodies[1])).toContain(`■ 新しい決済要確認：${NOTIFY_LIST_LIMIT}件`);
    // ちょうど上限の件数（超えていない）：上限の注意は出さない
    st.reviews = st.reviews.slice(0, NOTIFY_LIST_LIMIT);
    st.state.notifiedReviewIds = [];
    await notifyCronRun(quiet, { timeoutMs: 5000, fetchImpl: s.f });
    expect(content(s.bodies[2])).not.toContain("件を超えています");
  });

  it("Firestore ではない構成：定期処理の異常だけを送る。ロックの失敗の通知は Firestore を使わない", async () => {
    const { notifyCronRun, notifyCronLockFailure } = await import("@/lib/services/alert-notification");
    st.firestore = false;
    const s = sender();
    expect(await notifyCronRun({ ...quiet, runStatus: "partial", phases: [{ name: "maintenance", status: "failed", reason: null, errorCode: "X" }] }, { timeoutMs: 5000, fetchImpl: s.f })).toMatchObject({ status: "sent", issues: 1 });
    expect(await notifyCronLockFailure({ timeoutMs: 5000, fetchImpl: s.f })).toMatchObject({ status: "sent", issues: 1 });
    expect(content(s.bodies[1])).toContain("定期処理のロックを取得できず");
    expect(st.writes).toEqual([]);
  });
});
