import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { alertKindForWebhookEvent, alertModeOf, hourBucket, monitorHealth, newThrottleState, throttleTick, type MonitorRunStatus } from "@/lib/payments/monitor-rules";
import { createSimulatedStripeRuntime } from "@/lib/payments/stripe-checkout";

// Firestore の代わり（メモリ上）。mode = "fail" で接続できない状態、"hang" で応答しない状態にする
const store = vi.hoisted(() => ({ docs: new Map<string, Record<string, unknown>>(), mode: "ok" as "ok" | "fail" | "hang", tx: 0 }));


vi.mock("@/lib/firestore/admin", async (orig) => {
  const actual = await orig<typeof import("@/lib/firestore/admin")>();
  const ref = (path: string) => ({ path, id: path.split("/").pop() });
  const isInc = (v: unknown): v is { operand: number } => !!v && typeof v === "object" && v.constructor?.name === "NumericIncrementTransform";
  const fake = {
    collection: (c: string) => ({ doc: (id: string) => ref(`${c}/${id}`) }),
    runTransaction: async (fn: (tx: unknown) => Promise<unknown>) => {
      store.tx++;
      if (store.mode === "fail") throw Object.assign(new Error("unavailable"), { name: "FirebaseError" });
      if (store.mode === "hang") return new Promise(() => undefined);
      const tx = {
        get: async (r: { path: string }) => {
          const d = store.docs.get(r.path);
          return { exists: !!d, get: (k: string) => d?.[k] };
        },
        create: (r: { path: string }, data: Record<string, unknown>) => store.docs.set(r.path, { ...data }),
        update: (r: { path: string }, data: Record<string, unknown>) => {
          const cur = { ...store.docs.get(r.path) };
          for (const [k, v] of Object.entries(data)) cur[k] = isInc(v) ? Number(cur[k] ?? 0) + v.operand : v;
          store.docs.set(r.path, cur);
        },
      };
      return fn(tx);
    },
  };
  return { ...actual, fsdb: () => fake };
});

const { recordPaymentAlert, notePaymentApiError, paymentAlertId } = await import("@/lib/firestore/payment-alerts");
const { recordPaymentReview } = await import("@/lib/firestore/payment-reviews");
const { upsertDedupedRecord } = await import("@/lib/firestore/deduped-record");
const { handleStripeWebhook } = await import("@/lib/payments/stripe-webhook");

describe("決済監視の規則", () => {
  it("Webhook の処理の失敗を、通知の種類から分類する", () => {
    expect(alertKindForWebhookEvent("charge.dispute.created")).toBe("dispute_sync_failed");
    expect(alertKindForWebhookEvent("charge.dispute.closed")).toBe("dispute_sync_failed");
    expect(alertKindForWebhookEvent("charge.refunded")).toBe("refund_sync_failed");
    expect(alertKindForWebhookEvent("charge.refund.updated")).toBe("refund_sync_failed");
    expect(alertKindForWebhookEvent("refund.updated")).toBe("refund_sync_failed");
    expect(alertKindForWebhookEvent("checkout.session.completed")).toBe("checkout_confirm_failed");
    expect(alertKindForWebhookEvent("charge.updated")).toBe("webhook_processing_failed");
  });

  it("モード：livemode が true/false 以外は「不明」（テストと本番を取り違えない）", () => {
    expect(alertModeOf(true)).toBe("live");
    expect(alertModeOf(false)).toBe("test");
    expect(alertModeOf(undefined)).toBe("unknown");
    expect(alertModeOf("true")).toBe("unknown");
  });

  it("1時間ごとのまとめは日本時間", () => {
    expect(hourBucket(new Date("2026-10-27T14:59:59Z"))).toBe("2026-10-27T23");
    expect(hourBucket(new Date("2026-10-27T15:00:00Z"))).toBe("2026-10-28T00");
  });

  describe("監視の状態：動いていない・失敗・一部未確認のときは「異常なし」にしない", () => {
    const now = new Date("2026-10-27T12:00:00Z");
    const base: MonitorRunStatus = { lastStartedAt: new Date("2026-10-27T11:00:00Z"), lastFinishedAt: new Date("2026-10-27T11:01:00Z"), lastResult: "ok", unchecked: [], found: 0, stripeMode: "test" };
    it("一度も実行していない", () => {
      expect(monitorHealth(null, now, 0).state).toBe("never_run");
      expect(monitorHealth({ ...base, lastStartedAt: null, lastFinishedAt: null }, now, 0).state).toBe("never_run");
    });
    it("実行中・途中で止まった", () => {
      expect(monitorHealth({ ...base, lastStartedAt: new Date("2026-10-27T11:57:00Z") }, now, 0).state).toBe("running");
      expect(monitorHealth({ ...base, lastStartedAt: new Date("2026-10-27T11:30:00Z") }, now, 0).state).toBe("failed");
      expect(monitorHealth({ ...base, lastFinishedAt: null }, now, 0).state).toBe("failed");
      // 最後に開始した点検の結果が書かれていない（終了の日時が古い点検のもの）
      expect(monitorHealth({ ...base, inProgress: true }, now, 0).state).toBe("failed");
      expect(monitorHealth({ ...base, inProgress: true, lastStartedAt: new Date("2026-10-27T11:58:00Z") }, now, 0).state).toBe("running");
    });
    it("最後の点検から時間がたった（監視が止まっている可能性）", () => {
      const old = { ...base, lastStartedAt: new Date("2026-10-26T09:00:00Z"), lastFinishedAt: new Date("2026-10-26T09:01:00Z") };
      expect(monitorHealth(old, now, 0).state).toBe("stale");
      expect(monitorHealth(old, now, 0).message).not.toContain("異常は見つかりません");
    });
    it("失敗・一部未確認・異常あり・異常なし", () => {
      expect(monitorHealth({ ...base, lastResult: "failed" }, now, 0).state).toBe("failed");
      expect(monitorHealth({ ...base, lastResult: "partial", unchecked: ["Stripe での支払いの照合"] }, now, 0).state).toBe("partial");
      expect(monitorHealth({ ...base, unchecked: ["x"] }, now, 0).state).toBe("partial");
      expect(monitorHealth({ ...base, lastResult: "issues", found: 2 }, now, 2).state).toBe("issues");
      // 点検は ok でも、未確認の異常（Webhook の失敗など）が残っていれば「異常なし」ではない
      expect(monitorHealth(base, now, 1).state).toBe("issues");
      expect(monitorHealth(base, now, 0).state).toBe("ok");
    });
  });
});

describe("決済監視の記録：重複をまとめる・確認済みからの再発・失敗しても止めない", () => {
  let errors: unknown[][];
  beforeEach(() => {
    store.docs.clear();
    store.mode = "ok";
    errors = [];
    vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => void errors.push(a));
  });
  afterEach(() => vi.restoreAllMocks());

  const path = (kind: Parameters<typeof paymentAlertId>[0], objectId: string) => `paymentAlerts/${paymentAlertId(kind, objectId)}`;

  it("同じ種類・対象は1件にまとめ、回数だけ増やす。確認済みの後にまた起きたら未確認に戻す", async () => {
    const input = { kind: "webhook_processing_failed" as const, objectType: "event" as const, objectId: "evt_1", mode: "test" as const, eventType: "charge.updated", errorName: "TypeError" };
    expect(await recordPaymentAlert(input)).toBe(true);
    expect(await recordPaymentAlert(input)).toBe(true);
    expect(await recordPaymentAlert(input)).toBe(true);
    const p = path("webhook_processing_failed", "evt_1");
    expect(store.docs.size).toBe(1);
    expect(store.docs.get(p)).toMatchObject({ status: "OPEN", occurrences: 3, mode: "test", errorName: "TypeError" });
    store.docs.set(p, { ...store.docs.get(p), status: "RESOLVED", resolvedBy: "op" });
    await recordPaymentAlert(input);
    expect(store.docs.get(p)).toMatchObject({ status: "OPEN", occurrences: 4, resolvedBy: null });
    // 別の対象は別の記録
    await recordPaymentAlert({ ...input, objectId: "evt_2" });
    expect(store.docs.size).toBe(2);
  });

  it("保存するのは ID・名前だけ（不正な値・エラーの文面・個人情報らしき値は保存しない）", async () => {
    await recordPaymentAlert({ kind: "checkout_confirm_failed", objectType: "checkout", objectId: "cs_test_1", mode: "test", errorName: "Error: card 4242 4242 4242 4242", storeId: "a b@example.com", eventType: "x\ny" });
    const d = store.docs.get(path("checkout_confirm_failed", "cs_test_1"))!;
    expect(d.errorName).toBeNull();
    expect(d.storeId).toBeNull();
    expect(d.eventType).toBeNull();
    expect(JSON.stringify(d)).not.toMatch(/4242|example\.com|whsec_|sk_(test|live)_/);
    await recordPaymentAlert({ kind: "checkout_confirm_failed", objectType: "checkout", objectId: "../../etc", mode: "live" });
    expect(store.docs.get(path("checkout_confirm_failed", "invalid"))).toMatchObject({ objectId: "invalid" });
  });

  it("API の 5xx は API ごと・1時間ごとに1件（回数を数える）", async () => {
    const t = new Date("2026-10-27T03:10:00Z");
    for (let i = 0; i < 6; i++) await notePaymentApiError("checkout", 500, "Error", t);
    await notePaymentApiError("checkout", 500, "Error", new Date("2026-10-27T04:10:00Z"));
    await notePaymentApiError("stripe_session", 502, undefined, t);
    expect(store.docs.size).toBe(3);
    expect(store.docs.get(path("payment_api_5xx", "checkout:2026-10-27T12"))).toMatchObject({ occurrences: 6, route: "checkout", httpStatus: 500, mode: "unknown" });
  });

  it("記録に失敗しても例外にしない（サーバーのログに残す）", async () => {
    store.mode = "fail";
    await expect(recordPaymentAlert({ kind: "refund_sync_failed", objectType: "event", objectId: "evt_x", mode: "live" })).resolves.toBe(false);
    expect(errors.some((a) => a[0] === "[payment-alert] record failed")).toBe(true);
    expect(JSON.stringify(errors)).not.toContain("unavailable"); // エラーの文面は出さない（名前だけ）
  });

  it("応答しないときは時間切れで返す（決済・Webhook の応答を止めない）", async () => {
    store.mode = "hang";
    const started = Date.now();
    const r = await upsertDedupedRecord({ path: "x/y" } as never, {}, { causeKey: "k", reopen: "always", timeoutMs: 50 });
    expect(r).toEqual({ ok: false, error: "TimeoutError" });
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it("決済要確認の記録に失敗したら、決済監視にも残す（両方失敗してもログだけで、例外にしない）", async () => {
    // 決済要確認の保存だけ失敗させる
    const admin = await import("@/lib/firestore/admin");
    const real = admin.fsdb();
    const orig = real.runTransaction;
    let calls = 0;
    (real as { runTransaction: unknown }).runTransaction = async (fn: never) => (calls++ === 0 ? Promise.reject(Object.assign(new Error("x"), { name: "FirebaseError" })) : orig(fn));
    try {
      await recordPaymentReview({ kind: "charge_mismatch", objectType: "charge", objectId: "ch_1", livemode: true, storeId: "store_1" });
    } finally {
      (real as { runTransaction: unknown }).runTransaction = orig;
    }
    expect(errors.some((a) => a[0] === "[payment-review] record failed")).toBe(true);
    const a = store.docs.get(path("payment_review_record_failed", "charge_mismatch:ch_1"));
    expect(a).toMatchObject({ kind: "payment_review_record_failed", mode: "live", storeId: "store_1", errorName: "FirebaseError", status: "OPEN" });

    store.mode = "fail";
    await expect(recordPaymentReview({ kind: "charge_mismatch", objectType: "charge", objectId: "ch_2" })).resolves.toBeUndefined();
    expect(errors.filter((a) => a[0] === "[payment-alert] record failed").length).toBe(1);
  });
});

describe("署名を確認できない通知の大量発生：書き込みを間引き、件数は「少なくとも」で記録する", () => {
  it("間引きの規則：間隔の中は書き込まない。次の書き込みで、それまでの件数をまとめて返す", () => {
    const st = newThrottleState();
    expect(throttleTick(st, 1_000, 60_000)).toBe(1); // 最初の1件はすぐ書き込む（気付くのが遅れない）
    for (let i = 0; i < 999; i++) expect(throttleTick(st, 1_000 + i, 60_000)).toBe(0);
    expect(st.pending).toBe(999);
    expect(throttleTick(st, 61_000, 60_000)).toBe(1000);
    expect(st.pending).toBe(0);
  });

  it("大量の不正な通知でも書き込みは間隔ごとに1回。書き込めなかった分は次に回す。中身・署名は保存しない", async () => {
    store.docs.clear();
    store.mode = "ok";
    store.tx = 0;
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const rt = createSimulatedStripeRuntime("test", { apiBase: "http://127.0.0.1:12199", secretKey: "sk_test_unit_dummy", webhookSecret: "whsec_unit_flood" }, { FIRESTORE_EMULATOR_HOST: "127.0.0.1:8080", FIREBASE_PROJECT_ID: "demo-flood-unit" });
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(new Date("2026-10-27T01:00:00Z"));
      const body = JSON.stringify({ id: "evt_flood", type: "charge.refunded", data: { object: { id: "ch_secret_4242", billing_details: { email: "a@example.com" } } } });
      const started = Date.now();
      for (let i = 0; i < 2000; i++) expect((await handleStripeWebhook(body, `t=1,v1=bad${i}`, rt)).status).toBe(400);
      expect(store.tx).toBe(1); // 2000件で書き込みは1回だけ
      const path = `paymentAlerts/${paymentAlertId("webhook_signature_invalid", `stripe:${hourBucket(new Date(started))}`)}`;
      expect(store.docs.get(path)).toMatchObject({ occurrences: 1, observedCount: 1, sampled: true, mode: "unknown" });
      // 間隔の後の1件で、それまでの未書き込みの分をまとめて加算
      vi.setSystemTime(new Date("2026-10-27T01:01:01Z"));
      await handleStripeWebhook(body, "t=1,v1=bad", rt);
      expect(store.tx).toBe(2);
      expect(store.docs.get(path)).toMatchObject({ occurrences: 2, observedCount: 2001 });
      // 書き込めなかった分は失わず、次の書き込みに回す
      store.mode = "fail";
      vi.setSystemTime(new Date("2026-10-27T01:02:02Z"));
      await handleStripeWebhook(body, "t=1,v1=bad", rt);
      store.mode = "ok";
      for (let i = 0; i < 4; i++) await handleStripeWebhook(body, "t=1,v1=bad", rt);
      vi.setSystemTime(new Date("2026-10-27T01:03:03Z"));
      await handleStripeWebhook(body, "t=1,v1=bad", rt);
      expect(store.docs.get(path)).toMatchObject({ occurrences: 3, observedCount: 2007 });
      expect(JSON.stringify([...store.docs.values()])).not.toMatch(/4242|example\.com|whsec_|sk_test_|v1=bad|evt_flood/);
    } finally {
      vi.useRealTimers();
      vi.restoreAllMocks();
    }
  });
});
