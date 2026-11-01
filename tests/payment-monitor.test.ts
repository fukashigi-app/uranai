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
const { paymentReviewId, recordPaymentReview, recordRequiredPaymentReview } = await import("@/lib/firestore/payment-reviews");
const { safeId } = await import("@/lib/firestore/admin");
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
    expect(r).toEqual({ ok: false, error: "TimeoutError", unknown: true }); // 待つのをやめただけ（保存されたかは不明）
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

describe("記録が必須の決済要確認（recordRequiredPaymentReview）", () => {
  beforeEach(() => {
    store.docs.clear();
    store.mode = "ok";
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });
  afterEach(() => vi.restoreAllMocks());
  const reviewPath = (objectId: string) => `paymentReviews/${paymentReviewId("transaction_not_found", objectId)}`;
  const input = (objectId: string, amount?: number) => ({ kind: "transaction_not_found" as const, objectType: "charge" as const, objectId, livemode: true, ...(amount === undefined ? {} : { amount }) });
  // 通知の文書（beginWebhookEvent が処理の前に作る）
  const eventPath = (eventId: string) => `webhookEvents/${safeId("stripe", eventId)}`;
  const begun = (...eventIds: string[]) => eventIds.forEach((id) => store.docs.set(eventPath(id), { provider: "stripe", eventId: id, processedAt: null, state: "RECEIVED" }));
  const wh = (eventId: string) => ({ webhookEvent: { provider: "stripe", eventId } });

  it("保存できたら例外にしない（未確認・回数1）。通知の文書に記録の ID を残す（記録には以前の方式の項目を書かない）", async () => {
    begun("evt_1");
    await expect(recordRequiredPaymentReview(input("ch_req_1"), wh("evt_1"))).resolves.toBeUndefined();
    const rv = store.docs.get(reviewPath("ch_req_1"));
    expect(rv).toMatchObject({ status: "OPEN", occurrences: 1 });
    expect(rv).not.toHaveProperty("recentOccurrenceKeys");
    expect(store.docs.get(eventPath("evt_1"))?.recordedReviewIds).toEqual([paymentReviewId("transaction_not_found", "ch_req_1")]);
  });

  it("保存の失敗・時間切れは例外（PaymentReviewRecordError）。記録は残らない", async () => {
    store.mode = "fail";
    await expect(recordRequiredPaymentReview(input("ch_req_2"))).rejects.toMatchObject({ name: "PaymentReviewRecordError" });
    expect(store.docs.has(reviewPath("ch_req_2"))).toBe(false);
  });

  it("同じ通知の再送では回数を増やさない。別の通知では増やす。A→B→A・21件以上の後の古い通知でも増やさない（件数で切り捨てない）", async () => {
    const ids = Array.from({ length: 25 }, (_, i) => `evt_n${i}`);
    begun(...ids);
    await recordRequiredPaymentReview(input("ch_req_3"), wh("evt_n0"));
    await recordRequiredPaymentReview(input("ch_req_3"), wh("evt_n0"));
    expect(store.docs.get(reviewPath("ch_req_3"))?.occurrences).toBe(1);
    await recordRequiredPaymentReview(input("ch_req_3"), wh("evt_n1"));
    await recordRequiredPaymentReview(input("ch_req_3"), wh("evt_n0")); // A→B→A
    expect(store.docs.get(reviewPath("ch_req_3"))?.occurrences).toBe(2);
    for (const id of ids.slice(2)) await recordRequiredPaymentReview(input("ch_req_3"), wh(id));
    expect(store.docs.get(reviewPath("ch_req_3"))?.occurrences).toBe(25);
    for (const id of ids) await recordRequiredPaymentReview(input("ch_req_3"), wh(id)); // 25件すべての再送
    expect(store.docs.get(reviewPath("ch_req_3"))?.occurrences).toBe(25);
    await recordRequiredPaymentReview(input("ch_req_3")); // 通知なし（決済確定の後の再確認など）は今までどおり数える
    expect(store.docs.get(reviewPath("ch_req_3"))?.occurrences).toBe(26);
  });

  it("1件の通知から複数の種類の決済要確認：それぞれ1回。通知の文書に両方の ID", async () => {
    begun("evt_multi");
    const other = { kind: "dispute_amount_invalid" as const, objectType: "dispute" as const, objectId: "dp_multi", livemode: true };
    for (let i = 0; i < 2; i++) {
      await recordRequiredPaymentReview(input("ch_multi"), wh("evt_multi"));
      await recordRequiredPaymentReview(other, wh("evt_multi"));
    }
    expect(store.docs.get(reviewPath("ch_multi"))?.occurrences).toBe(1);
    expect(store.docs.get(`paymentReviews/${paymentReviewId("dispute_amount_invalid", "dp_multi")}`)?.occurrences).toBe(1);
    expect(store.docs.get(eventPath("evt_multi"))?.recordedReviewIds).toEqual([paymentReviewId("transaction_not_found", "ch_multi"), paymentReviewId("dispute_amount_invalid", "dp_multi")]);
  });

  it("以前の方式（記録の recentOccurrenceKeys に同じ通知）：記録済みとして扱い、何も書かない", async () => {
    begun("evt_old");
    store.docs.set(reviewPath("ch_legacy"), { kind: "transaction_not_found", causeKey: JSON.stringify(["transaction_not_found", [], null]), status: "RESOLVED", occurrences: 4, recentOccurrenceKeys: ["event:evt_old"] });
    await recordRequiredPaymentReview(input("ch_legacy"), wh("evt_old"));
    expect(store.docs.get(reviewPath("ch_legacy"))).toMatchObject({ occurrences: 4, status: "RESOLVED", recentOccurrenceKeys: ["event:evt_old"] });
    expect(store.docs.get(eventPath("evt_old"))?.recordedReviewIds).toBeUndefined(); // 一括の書き換えはしない
    begun("evt_new");
    await recordRequiredPaymentReview(input("ch_legacy"), wh("evt_new"));
    expect(store.docs.get(reviewPath("ch_legacy"))).toMatchObject({ occurrences: 5, recentOccurrenceKeys: ["event:evt_old"] }); // 追記しない
  });

  it("通知の文書が無い：回数を増やさず、記録もしないで例外（呼び出し側は 500 → 再送で文書が作り直される）", async () => {
    store.docs.set(reviewPath("ch_nodoc"), { kind: "transaction_not_found", causeKey: "x", status: "OPEN", occurrences: 2 });
    await expect(recordRequiredPaymentReview(input("ch_nodoc"), wh("evt_missing"))).rejects.toMatchObject({ name: "PaymentReviewRecordError" });
    expect(store.docs.get(reviewPath("ch_nodoc"))?.occurrences).toBe(2);
    expect(store.docs.has(eventPath("evt_missing"))).toBe(false); // 中途半端な通知の文書を作らない
    begun("evt_missing");
    await recordRequiredPaymentReview(input("ch_nodoc"), wh("evt_missing"));
    expect(store.docs.get(reviewPath("ch_nodoc"))?.occurrences).toBe(3);
  });

  it("確認済みの記録：同じ通知の再送は何も変えない。別の通知で同じ内容は確認済みのまま、内容が変わったら未確認に戻す", async () => {
    begun("e1", "e2", "e3");
    await recordRequiredPaymentReview(input("ch_req_4", 100), wh("e1"));
    store.docs.set(reviewPath("ch_req_4"), { ...store.docs.get(reviewPath("ch_req_4")), status: "RESOLVED", resolvedBy: "op" });
    await recordRequiredPaymentReview(input("ch_req_4", 100), wh("e1"));
    expect(store.docs.get(reviewPath("ch_req_4"))).toMatchObject({ status: "RESOLVED", occurrences: 1, resolvedBy: "op" });
    await recordRequiredPaymentReview(input("ch_req_4", 100), wh("e2"));
    expect(store.docs.get(reviewPath("ch_req_4"))).toMatchObject({ status: "RESOLVED", occurrences: 2 });
    await recordRequiredPaymentReview(input("ch_req_4", 30), wh("e3"));
    expect(store.docs.get(reviewPath("ch_req_4"))).toMatchObject({ status: "OPEN", occurrences: 3, resolvedBy: null, amount: 30 });
  });
});

describe("記録が必須の決済要確認の待ち時間と、保存されたか不明の扱い", () => {
  beforeEach(() => {
    store.docs.clear();
    store.mode = "ok";
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });
  const reviewPath = (objectId: string) => `paymentReviews/${paymentReviewId("transaction_not_found", objectId)}`;
  const input = (objectId: string) => ({ kind: "transaction_not_found" as const, objectType: "charge" as const, objectId, livemode: true });

  it("待ち時間：失敗しても止めない記録・決済監視は3秒のまま、記録が必須の決済要確認だけ6秒", async () => {
    const reviews = await import("@/lib/firestore/payment-reviews");
    const alerts = await import("@/lib/firestore/payment-alerts");
    expect([reviews.PAYMENT_REVIEW_TIMEOUT_MS, alerts.PAYMENT_ALERT_TIMEOUT_MS, reviews.REQUIRED_PAYMENT_REVIEW_TIMEOUT_MS]).toEqual([3000, 3000, 6000]);
  });

  it("応答しない Firestore：失敗しても止めない記録は3秒で返り、記録が必須の決済要確認は6秒で「保存されたか不明」の例外", async () => {
    vi.useFakeTimers();
    store.mode = "hang";
    const errors = vi.mocked(console.error);
    const optionalGaveUp = () => errors.mock.calls.some((c) => c[0] === "[payment-review] record failed" && (c[1] as { error?: string })?.error === "TimeoutError");
    void recordPaymentReview(input("ch_hang_1")); // この後に決済監視の記録（同じく3秒）も試みる
    let required: unknown = null;
    void recordRequiredPaymentReview(input("ch_hang_2")).catch((e) => (required = e));
    await vi.advanceTimersByTimeAsync(2999);
    expect(optionalGaveUp()).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(optionalGaveUp()).toBe(true); // 失敗しても止めない記録は3秒で待つのをやめる
    expect(required).toBeNull(); // 記録が必須の決済要確認は、3秒ではまだ待っている
    await vi.advanceTimersByTimeAsync(2999);
    expect(required).toBeNull();
    await vi.advanceTimersByTimeAsync(1);
    expect(required).toMatchObject({ name: "PaymentReviewRecordUnknownError" });
  });

  it("書き込みの失敗は「保存されていない」例外（PaymentReviewRecordError）で、「不明」とは区別する", async () => {
    store.mode = "fail";
    await expect(recordRequiredPaymentReview(input("ch_fail_1"))).rejects.toMatchObject({ name: "PaymentReviewRecordError" });
  });

  it("待つのをやめた後に保存された：記録は1件・回数1。同じ通知の再送では回数を増やさない", async () => {
    const admin = await import("@/lib/firestore/admin");
    const real = admin.fsdb();
    const orig = real.runTransaction;
    // 1回目の書き込みだけ遅らせる（待つのをやめた後に確定する）
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => (release = r));
    let first = true;
    (real as { runTransaction: unknown }).runTransaction = async (fn: never) => {
      if (first) {
        first = false;
        await gate;
      }
      return orig(fn);
    };
    try {
      store.docs.set(`webhookEvents/${safeId("stripe", "evt_late")}`, { provider: "stripe", eventId: "evt_late", processedAt: null });
      await expect(recordRequiredPaymentReview(input("ch_late_1"), { webhookEvent: { provider: "stripe", eventId: "evt_late" }, timeoutMs: 20 })).rejects.toMatchObject({ name: "PaymentReviewRecordUnknownError" });
      expect(store.docs.has(reviewPath("ch_late_1"))).toBe(false); // まだ保存されていない（不明）
      release();
      await new Promise((r) => setTimeout(r, 10));
      expect(store.docs.get(reviewPath("ch_late_1"))).toMatchObject({ occurrences: 1 }); // 後から保存された
      expect(store.docs.get(`webhookEvents/${safeId("stripe", "evt_late")}`)?.recordedReviewIds).toEqual([paymentReviewId("transaction_not_found", "ch_late_1")]); // 印も一緒に
      await recordRequiredPaymentReview(input("ch_late_1"), { webhookEvent: { provider: "stripe", eventId: "evt_late" } }); // Stripe の再送
      expect(store.docs.get(reviewPath("ch_late_1"))?.occurrences).toBe(1);
    } finally {
      (real as { runTransaction: unknown }).runTransaction = orig;
    }
  });
});
