import { describe, expect, it } from "vitest";
import { decodeWebhookEventCursor, encodeWebhookEventCursor, isStaleUnfinished, stripeEventMeta, webhookErrorNameOf, webhookEventStateOf } from "@/lib/payments/webhook-event-state";

// Webhook の通知の処理状態の規則（Firestore・Stripe には接続しない）
describe("webhookEventStateOf：記録の状態（以前の記録との互換）", () => {
  it("processedAt があれば、state に関係なく PROCESSED（処理済みかどうかは processedAt で決まる）", () => {
    expect(webhookEventStateOf({ processedAt: new Date() })).toBe("PROCESSED");
    expect(webhookEventStateOf({ processedAt: new Date(), state: "RETRYABLE" })).toBe("PROCESSED");
    expect(webhookEventStateOf({ processedAt: new Date() /* 以前の記録：state なし */ })).toBe("PROCESSED");
  });
  it("processedAt が無ければ、記録の state。項目が無い以前の記録・不明な値は RECEIVED（処理が終わっていない）", () => {
    expect(webhookEventStateOf({ processedAt: null })).toBe("RECEIVED");
    expect(webhookEventStateOf({ processedAt: null, state: "RETRYABLE" })).toBe("RETRYABLE");
    expect(webhookEventStateOf({ processedAt: null, state: "PROCESSED" })).toBe("RECEIVED"); // processedAt が無いのに PROCESSED とは扱わない
    expect(webhookEventStateOf({ processedAt: null, state: "broken" })).toBe("RECEIVED");
  });
});

describe("isStaleUnfinished：途中で止まった・失敗した通知の検出", () => {
  const now = new Date("2026-10-29T03:00:00Z");
  const ago = (ms: number) => new Date(now.getTime() - ms);
  it("処理が終わっていない記録のうち、最後に処理を始めてから一定の時間がたったもの", () => {
    expect(isStaleUnfinished({ processedAt: null, state: "RECEIVED", lastAttemptAt: ago(600_000) }, now, 600_000)).toBe(true);
    expect(isStaleUnfinished({ processedAt: null, state: "RECEIVED", lastAttemptAt: ago(599_999) }, now, 600_000)).toBe(false); // 処理中かもしれない
    expect(isStaleUnfinished({ processedAt: null, state: "RETRYABLE", lastAttemptAt: ago(600_000) }, now, 600_000)).toBe(true);
  });
  it("以前の記録（lastAttemptAt なし）は作成の時刻で判定。処理済みは対象外", () => {
    expect(isStaleUnfinished({ processedAt: null, createdAt: ago(3_600_000) }, now, 600_000)).toBe(true);
    expect(isStaleUnfinished({ processedAt: new Date(), lastAttemptAt: ago(3_600_000) }, now, 600_000)).toBe(false);
    expect(isStaleUnfinished({ processedAt: null }, now, 600_000)).toBe(false); // 時刻が分からないものは決めつけない
  });
});

describe("stripeEventMeta：記録する通知の情報（ID・モード・作成日時だけ）", () => {
  const ev = (type: string, object: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({ id: "evt_1", type, livemode: false, created: 1_793_300_000, data: { object }, ...extra });
  it("Checkout Session：対象の ID だけ（Charge は無い）", () => {
    expect(stripeEventMeta(ev("checkout.session.completed", { id: "cs_test_1", object: "checkout.session", customer_details: { email: "a@example.com" } }))).toEqual({
      objectId: "cs_test_1",
      chargeId: null,
      livemode: false,
      eventCreatedAt: new Date(1_793_300_000 * 1000),
    });
  });
  it("Charge・返金・異議申し立て：対象の Charge の ID", () => {
    expect(stripeEventMeta(ev("charge.refunded", { id: "ch_1" })).chargeId).toBe("ch_1");
    expect(stripeEventMeta(ev("charge.updated", { id: "ch_2" })).chargeId).toBe("ch_2");
    expect(stripeEventMeta(ev("refund.updated", { id: "re_1", charge: "ch_3" }))).toMatchObject({ objectId: "re_1", chargeId: "ch_3" });
    expect(stripeEventMeta(ev("charge.refund.updated", { id: "re_2", charge: { id: "ch_4" } })).chargeId).toBe("ch_4");
    expect(stripeEventMeta(ev("charge.dispute.created", { id: "dp_1", charge: "ch_5" }))).toMatchObject({ objectId: "dp_1", chargeId: "ch_5" });
  });
  it("形の正しくない値は保存しない（null）", () => {
    expect(stripeEventMeta({ type: "charge.refunded", livemode: "true", created: -1, data: { object: { id: "ch 1<script>" } } })).toEqual({ objectId: null, chargeId: null, livemode: null, eventCreatedAt: null });
    expect(stripeEventMeta({})).toEqual({ objectId: null, chargeId: null, livemode: null, eventCreatedAt: null });
  });
});

describe("webhookErrorNameOf：エラーの名前だけ", () => {
  it("名前の形でなければ Error（エラー文・秘密情報は残さない）", () => {
    expect(webhookErrorNameOf(Object.assign(new Error("secret sk_test_x"), { name: "StripeAPIError" }))).toBe("StripeAPIError");
    expect(webhookErrorNameOf(Object.assign(new Error("x"), { name: "bad name with spaces" }))).toBe("Error");
    expect(webhookErrorNameOf("string")).toBe("Error");
  });
});

describe("一覧の続きの位置（カーソル）", () => {
  it("作成の時刻（秒・ナノ秒）と文書の ID だけを往復できる", () => {
    const c = { seconds: 1_793_300_000, nanoseconds: 123_456_789, id: "stripe_evt_1Abc" };
    const s = encodeWebhookEventCursor(c);
    expect(s).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeWebhookEventCursor(s)).toEqual(c);
    expect(Buffer.from(s, "base64url").toString("utf8")).toBe(JSON.stringify([c.seconds, c.nanoseconds, c.id])); // ほかの情報を含まない
  });
  it("形の正しくない位置は null（推測で位置を決めない）", () => {
    const enc = (v: unknown) => Buffer.from(JSON.stringify(v), "utf8").toString("base64url");
    for (const bad of [undefined, null, "", "not-base64!", enc({}), enc([1, 2]), enc([-1, 0, "a"]), enc([1, 1_000_000_000, "a"]), enc([1.5, 0, "a"]), enc([1, 0, "a b"]), enc([1, 0, ""]), "a".repeat(601)]) {
      expect(decodeWebhookEventCursor(bad)).toBeNull();
    }
  });
});
