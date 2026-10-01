import { afterEach, describe, expect, it, vi } from "vitest";
import { PayjpProvider } from "@/lib/payments/payjp";
import { WebhookVerificationError } from "@/lib/payments/types";

const provider = new PayjpProvider("sk_test_secret", "pk_test_public", "whook_token_123");
const chargeJson = {
  id: "ch_abc123",
  object: "charge",
  amount: 100,
  currency: "jpy",
  paid: true,
  captured: true,
  refunded: false,
  amount_refunded: 0,
  fee_rate: "3.00",
  metadata: { checkoutId: "c-1", storeId: "s-1", fortuneType: "ZODIAC" },
  livemode: false,
  created: 1790000000,
};

afterEach(() => vi.unstubAllGlobals());

describe("PayjpProvider.createCharge", () => {
  it("秘密鍵のBasic認証・冪等キー・metadata付きで100円を請求する", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(chargeJson), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const r = await provider.createCharge({
      amount: 100,
      currency: "jpy",
      cardToken: "tok_xyz",
      description: "test",
      metadata: { checkoutId: "c-1", storeId: "s-1", fortuneType: "ZODIAC" },
      idempotencyKey: "c-1-1",
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.charge.feeRateBps).toBe(300);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.pay.jp/v1/charges");
    expect(init.headers.Authorization).toBe(`Basic ${Buffer.from("sk_test_secret:").toString("base64")}`);
    expect(init.headers["Idempotency-Key"]).toBe("c-1-1");
    const body = new URLSearchParams(init.body.toString());
    expect(body.get("amount")).toBe("100");
    expect(body.get("currency")).toBe("jpy");
    expect(body.get("card")).toBe("tok_xyz");
    expect(body.get("metadata[checkoutId]")).toBe("c-1");
    expect(body.get("metadata[storeId]")).toBe("s-1");
  });

  it("カード拒否を日本語メッセージに変換", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: { code: "card_declined", message: "declined" } }), { status: 402 })));
    const r = await provider.createCharge({ amount: 100, currency: "jpy", cardToken: "tok", description: "", metadata: { checkoutId: "c", storeId: "s", fortuneType: "BLOOD" }, idempotencyKey: "k" });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe("card_declined");
      expect(r.userMessage).toMatch(/カード/);
    }
  });

  it("5xx は課金有無が不明（ambiguous）として扱う", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: { code: "server_error" } }), { status: 502 })));
    const r = await provider.createCharge({ amount: 100, currency: "jpy", cardToken: "tok", description: "", metadata: { checkoutId: "c", storeId: "s", fortuneType: "BLOOD" }, idempotencyKey: "k" });
    expect(!r.ok && r.ambiguous).toBe(true);
  });

  it("通信エラーは network_error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNRESET")));
    const r = await provider.createCharge({ amount: 100, currency: "jpy", cardToken: "tok", description: "", metadata: { checkoutId: "c", storeId: "s", fortuneType: "BLOOD" }, idempotencyKey: "k" });
    expect(!r.ok && r.code).toBe("network_error");
    expect(!r.ok && r.ambiguous).toBe(true);
  });
});

describe("PayjpProvider.retrieveCharge", () => {
  it("不正なIDはAPIを呼ばない", async () => {
    const f = vi.fn();
    vi.stubGlobal("fetch", f);
    expect(await provider.retrieveCharge("../../v1/customers")).toBeNull();
    expect(f).not.toHaveBeenCalled();
  });
});

describe("PayjpProvider.parseWebhook", () => {
  const body = JSON.stringify({ id: "evnt_1", type: "charge.succeeded", data: chargeJson });
  it("正しいトークンなら charge.succeeded", async () => {
    const ev = await provider.parseWebhook(new Headers({ "x-payjp-webhook-token": "whook_token_123" }), body);
    expect(ev).toEqual({ kind: "charge.succeeded", eventId: "evnt_1", chargeId: "ch_abc123" });
  });
  it("トークン不一致・欠落は拒否", async () => {
    await expect(provider.parseWebhook(new Headers({ "x-payjp-webhook-token": "wrong" }), body)).rejects.toBeInstanceOf(WebhookVerificationError);
    await expect(provider.parseWebhook(new Headers(), body)).rejects.toBeInstanceOf(WebhookVerificationError);
  });
  it("未対応イベントは ignored", async () => {
    const ev = await provider.parseWebhook(new Headers({ "x-payjp-webhook-token": "whook_token_123" }), JSON.stringify({ id: "e2", type: "customer.created", data: { id: "cus_1", object: "customer" } }));
    expect(ev.kind).toBe("ignored");
  });
});
