/**
 * 自動テスト用の Stripe API の模擬サーバー（localhost だけ）。本物の Stripe には一切接続しない。
 * mode="test" は Sandbox、mode="live" は本番として振る舞う（Session の ID が cs_live_、livemode=true）。
 * 本番モードでも使うキーは形だけの偽物で、接続先は 127.0.0.1 の模擬サーバーだけ。
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

export type FakeStripeMode = "test" | "live";

export function createFakeStripe(opts: { port: number; mode: FakeStripeMode; apiKey: string }) {
  const { port, mode, apiKey } = opts;
  const LIVE = mode === "live";
  type FakeSession = Record<string, unknown> & { id: string; metadata: Record<string, string> };
  const fake = {
    n: 0,
    sessions: new Map<string, FakeSession>(),
    idem: new Map<string, { sessionId: string; body: string }>(),
    pis: new Map<string, Record<string, unknown>>(),
    charges: new Map<string, Record<string, unknown>>(),
    refunds: new Map<string, Record<string, unknown>>(),
    disputes: new Map<string, Record<string, unknown>>(),
    createCalls: 0,
    /** Stripe 側で表示される支払い方法（ダッシュボードの設定で有効なもの）。絞り込みの確認用に増やせる */
    eligible: ["card", "paypay", "link", "konbini"],
    extraMethods: [] as string[],
    /** 利用者の Sandbox と同じく、アカウントの既定で Managed Payments が有効（Session で enabled=false を明示しないと付く） */
    managedPaymentsDefault: true,
    /** 応答の managed_payments.enabled を強制的に true にする（アプリが移動を止めるかの確認用） */
    forceManagedResponse: false,
    /** 作成時の expires_at（ID ごと）と作成時刻 */
    created: new Map<string, number>(),
  };
  const stripeError = (res: ServerResponse, status: number, type: string, message: string, param?: string, code?: string) =>
    send(res, status, { error: { type, message, ...(param ? { param } : {}), ...(code ? { code } : {}) } });
  // 本物の Stripe の ID は世界で一意。Emulator のデータは実行をまたいで残るので、実行ごとに異なる ID にする
  const RUN = Date.now().toString(36);
  const id = (p: string) => `${p}_${mode}_${RUN}${(++fake.n).toString().padStart(6, "0")}`;

  function piView(piId: string) {
    const pi = fake.pis.get(piId)!;
    return { ...pi, latest_charge: pi.latest_charge ? chargeView(String(pi.latest_charge)) : null };
  }
  function chargeView(chId: string) {
    const ch = fake.charges.get(chId)!;
    return { ...ch, balance_transaction: ch.fee === null ? null : { id: `txn_${chId}`, object: "balance_transaction", currency: "jpy", fee: ch.fee } };
  }
  function sessionView(s: FakeSession) {
    return { ...s, payment_intent: s.payment_intent ? piView(String(s.payment_intent)) : null };
  }

  async function readBody(req: IncomingMessage) {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    return Buffer.concat(chunks).toString("utf8");
  }
  function send(res: ServerResponse, status: number, body: unknown) {
    res.writeHead(status, { "content-type": "application/json", "request-id": `req_${fake.n}` });
    res.end(JSON.stringify(body));
  }

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
    const body = await readBody(req);
    if (!url.pathname.startsWith("/__test") && req.headers.authorization !== `Bearer ${apiKey}`) return send(res, 401, { error: { type: "invalid_request_error", message: "bad key" } });
    const m = (re: RegExp) => re.exec(url.pathname);
    if (req.method === "POST" && url.pathname === "/v1/checkout/sessions") {
      const key = String(req.headers["idempotency-key"] ?? "");
      const prev = key ? fake.idem.get(key) : undefined;
      if (prev) {
        // 本物の Stripe と同じく、同じ冪等キーで別の内容を送ると 400
        if (prev.body !== body) return stripeError(res, 400, "idempotency_error", "Keys for idempotent requests can only be used with the same parameters they were first used with.");
        return send(res, 200, sessionView(fake.sessions.get(prev.sessionId)!));
      }
      const f = new URLSearchParams(body);
      const allowed = [...f.entries()].filter(([k]) => /^allowed_payment_method_types\[\d+\]$/.test(k)).map(([, v]) => v);
      if (f.has("payment_method_types[0]")) return send(res, 400, { error: { type: "invalid_request_error", message: "payment_method_types is not supported" } });
      // 検証に失敗した要求は冪等キーの結果として保存しない（本物の Stripe と同じ）
      const managed = f.has("managed_payments[enabled]") ? f.get("managed_payments[enabled]") === "true" : fake.managedPaymentsDefault;
      if (managed && allowed.length) return stripeError(res, 400, "invalid_request_error", "allowed_payment_method_types cannot be used with Managed Payments", "allowed_payment_method_types");
      const now = Math.floor(Date.now() / 1000);
      const exp = Number(f.get("expires_at"));
      if (!Number.isInteger(exp) || exp < now + 30 * 60 || exp > now + 24 * 60 * 60) {
        return stripeError(res, 400, "invalid_request_error", "The `expires_at` timestamp must be between 30 minutes and 24 hours from Checkout Session creation.", "expires_at", "parameter_invalid_integer");
      }
      fake.createCalls++;
      const s: FakeSession = {
        id: id("cs"),
        object: "checkout.session",
        livemode: LIVE,
        mode: f.get("mode"),
        status: "open",
        payment_status: "unpaid",
        currency: f.get("line_items[0][price_data][currency]"),
        amount_total: Number(f.get("line_items[0][price_data][unit_amount]")) * Number(f.get("line_items[0][quantity]")),
        client_reference_id: f.get("client_reference_id"),
        metadata: { checkoutId: f.get("metadata[checkoutId]") ?? "", storeId: f.get("metadata[storeId]") ?? "", fortuneType: f.get("metadata[fortuneType]") ?? "" },
        pi_metadata: { checkoutId: f.get("payment_intent_data[metadata][checkoutId]"), storeId: f.get("payment_intent_data[metadata][storeId]"), fortuneType: f.get("payment_intent_data[metadata][fortuneType]") },
        success_url: f.get("success_url"),
        cancel_url: f.get("cancel_url"),
        expires_at: Number(f.get("expires_at")),
        payment_intent: null,
        allowed_payment_method_types: allowed.length ? allowed : null,
        managed_payments_param: f.get("managed_payments[enabled]"),
        managed_payments: { enabled: fake.forceManagedResponse ? true : managed },
        // allowed_payment_method_types は「表示できる支払い方法」を絞り込む（指定が無ければ有効なものすべて）
        payment_method_types: [...(allowed.length ? fake.eligible.filter((t) => allowed.includes(t)) : fake.eligible), ...fake.extraMethods],
      };
      s.url = `http://127.0.0.1:${port}/pay/${s.id}`;
      fake.sessions.set(s.id, s);
      if (key) fake.idem.set(key, { sessionId: s.id, body });
      fake.created.set(s.id, now);
      return send(res, 200, sessionView(s));
    }
    let r = m(/^\/v1\/checkout\/sessions\/([^/]+)$/);
    if (req.method === "GET" && r) {
      const s = fake.sessions.get(r[1]);
      return s ? send(res, 200, sessionView(s)) : send(res, 404, { error: { type: "invalid_request_error", message: "No such session" } });
    }
    r = m(/^\/v1\/charges\/([^/]+)$/);
    if (req.method === "GET" && r) {
      return fake.charges.has(r[1]) ? send(res, 200, chargeView(r[1])) : send(res, 404, { error: { type: "invalid_request_error", message: "No such charge" } });
    }
    r = m(/^\/v1\/payment_intents\/([^/]+)$/);
    if (req.method === "GET" && r) {
      const pi = fake.pis.get(r[1]);
      return pi ? send(res, 200, pi) : send(res, 404, { error: { type: "invalid_request_error", message: "No such payment_intent" } });
    }
    r = m(/^\/v1\/disputes\/([^/]+)$/);
    if (req.method === "GET" && r) {
      const dp = fake.disputes.get(r[1]);
      return dp ? send(res, 200, dp) : send(res, 404, { error: { type: "invalid_request_error", message: "No such dispute" } });
    }
    if (req.method === "GET" && url.pathname === "/v1/refunds") {
      const charge = url.searchParams.get("charge");
      return send(res, 200, { object: "list", url: "/v1/refunds", has_more: false, data: [...fake.refunds.values()].filter((x) => x.charge === charge) });
    }
    // ---- テスト用の操作（決済画面での支払い・返金・期限切れ・手数料の確定を再現） ----
    const ctl = JSON.parse(body || "{}") as { fee?: number | null; amount?: number; created?: number; metadataStoreId?: string; method?: string; async?: boolean; status?: string; currency?: string };
    r = m(/^\/__test\/pay\/([^/]+)$/);
    if (r) {
      // 決済画面での支払い。method: card | apple_pay | google_pay | paypay | link | samsung_pay、async: 確定待ち（PayPay の非同期の確定）
      const s = fake.sessions.get(r[1])!;
      const piId = id("pi");
      const chId = id("ch");
      const amount = ctl.amount ?? Number(s.amount_total);
      const method = ctl.method ?? "card";
      const pmd = method === "paypay" ? { type: "paypay", paypay: {} } : method === "link" ? { type: "link", link: {} } : { type: "card", card: { brand: "visa", wallet: method === "card" ? null : { type: method } } };
      const pending = ctl.async === true;
      fake.charges.set(chId, { id: chId, object: "charge", livemode: LIVE, status: pending ? "pending" : "succeeded", paid: !pending, captured: !pending, refunded: false, amount_refunded: 0, currency: "jpy", amount, payment_intent: piId, created: ctl.created ?? Math.floor(Date.now() / 1000), payment_method_details: pmd, fee: ctl.fee === undefined ? 4 : ctl.fee });
      const md = { ...(s.pi_metadata as Record<string, string>), ...(ctl.metadataStoreId ? { storeId: ctl.metadataStoreId } : {}) };
      fake.pis.set(piId, { id: piId, object: "payment_intent", livemode: LIVE, status: pending ? "processing" : "succeeded", currency: "jpy", amount, amount_received: pending ? 0 : amount, metadata: md, latest_charge: chId });
      Object.assign(s, { status: "complete", payment_status: pending ? "unpaid" : "paid", payment_intent: piId, amount_total: amount });
      return send(res, 200, { paymentIntent: piId, charge: chId });
    }
    r = m(/^\/__test\/decline\/([^/]+)$/);
    if (r) {
      // カードが拒否された（決済画面で支払い直せる。Session は open のまま、PaymentIntent は requires_payment_method）
      const s = fake.sessions.get(r[1])!;
      const piId = id("pi");
      fake.pis.set(piId, { id: piId, object: "payment_intent", livemode: LIVE, status: "requires_payment_method", currency: "jpy", amount: s.amount_total, amount_received: 0, metadata: s.pi_metadata, latest_charge: null });
      Object.assign(s, { status: "open", payment_status: "unpaid", payment_intent: piId });
      return send(res, 200, { paymentIntent: piId });
    }
    r = m(/^\/__test\/async-(succeed|fail)\/([^/]+)$/);
    if (r) {
      const s = fake.sessions.get(r[2])!;
      const pi = fake.pis.get(String(s.payment_intent))!;
      const ch = fake.charges.get(String(pi.latest_charge))!;
      if (r[1] === "succeed") {
        Object.assign(pi, { status: "succeeded", amount_received: pi.amount });
        Object.assign(ch, { status: "succeeded", paid: true, captured: true });
        Object.assign(s, { payment_status: "paid" });
      } else {
        Object.assign(pi, { status: "requires_payment_method" });
        Object.assign(ch, { status: "failed", paid: false });
      }
      return send(res, 200, {});
    }
    const syncCharge = (chId: string) => {
      const ch = fake.charges.get(chId)!;
      const sum = [...fake.refunds.values()].filter((x) => x.charge === chId && (x.status === "succeeded" || x.status === "pending")).reduce((a, x) => a + Number(x.amount), 0);
      Object.assign(ch, { amount_refunded: sum, refunded: sum >= Number(ch.amount) });
    };
    r = m(/^\/__test\/refund\/([^/]+)$/);
    if (r) {
      const ch = fake.charges.get(r[1])!;
      const reId = id("re");
      fake.refunds.set(reId, { id: reId, object: "refund", charge: r[1], payment_intent: ch.payment_intent, currency: "jpy", amount: ctl.amount ?? ch.amount, status: ctl.status ?? "succeeded" });
      syncCharge(r[1]);
      return send(res, 200, { refund: reId });
    }
    r = m(/^\/__test\/refund-status\/([^/]+)$/);
    if (r) {
      const re = fake.refunds.get(r[1])!;
      re.status = ctl.status;
      syncCharge(String(re.charge));
      return send(res, 200, {});
    }
    r = m(/^\/__test\/dispute\/([^/]+)$/);
    if (r) {
      // 異議申し立て（チャージバック）の発生。status: needs_response（既定）・under_review・won・lost など
      const ch = fake.charges.get(r[1])!;
      const dpId = id("dp");
      fake.disputes.set(dpId, { id: dpId, object: "dispute", livemode: LIVE, charge: r[1], payment_intent: ch.payment_intent, currency: ctl.currency ?? "jpy", amount: ctl.amount ?? ch.amount, status: ctl.status ?? "needs_response", reason: "fraudulent" });
      Object.assign(ch, { disputed: true });
      return send(res, 200, { dispute: dpId });
    }
    r = m(/^\/__test\/dispute-status\/([^/]+)$/);
    if (r) {
      Object.assign(fake.disputes.get(r[1])!, { status: ctl.status });
      return send(res, 200, {});
    }
    r = m(/^\/__test\/pi-metadata\/([^/]+)$/);
    if (r) {
      // 照合の確認用：PaymentIntent の店舗を書き換える（記録と一致しない返金・異議申し立てを再現）
      const pi = fake.pis.get(r[1])!;
      pi.metadata = { ...(pi.metadata as Record<string, string>), storeId: ctl.metadataStoreId ?? "" };
      return send(res, 200, {});
    }
    r = m(/^\/__test\/expire\/([^/]+)$/);
    if (r) {
      Object.assign(fake.sessions.get(r[1])!, { status: "expired" });
      return send(res, 200, {});
    }
    r = m(/^\/__test\/fee\/([^/]+)$/);
    if (r) {
      Object.assign(fake.charges.get(r[1])!, { fee: ctl.fee });
      return send(res, 200, {});
    }
    send(res, 404, { error: { type: "invalid_request_error", message: `unknown ${req.method} ${url.pathname}` } });
  });

  async function ctl(path: string, body: Record<string, unknown> = {}) {
    const r = await fetch(`http://127.0.0.1:${port}/__test/${path}`, { method: "POST", body: JSON.stringify(body) });
    return r.json() as Promise<{ paymentIntent?: string; charge?: string; refund?: string; dispute?: string }>;
  }

  return {
    fake,
    server,
    ctl,
    sessionView,
    start: () => new Promise<void>((ok) => server.listen(port, "127.0.0.1", ok)),
    stop: () => new Promise<void>((ok) => server.close(() => ok())),
  };
}
