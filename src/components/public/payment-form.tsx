"use client";

import Script from "next/script";
import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Spinner } from "@/components/ui/spinner";

/* ---- payjp.js v2 の最小型定義 ---- */
type PayjpElement = { mount(selector: string): void; on(ev: string, cb: (e: { complete?: boolean; error?: { message: string } }) => void): void; unmount?(): void };
type PayjpInstance = {
  elements(): { create(type: "cardNumber" | "cardExpiry" | "cardCvc", opts?: object): PayjpElement };
  createToken(
    el: PayjpElement,
    opts?: { three_d_secure?: boolean; card?: { email?: string; name?: string } },
  ): Promise<{ id?: string; error?: { message: string; code?: string } }>;
};
declare global {
  interface Window {
    Payjp?: (publicKey: string, opts?: object) => PayjpInstance;
  }
}

type Phase = "idle" | "tokenizing" | "charging" | "confirming" | "success" | "timeout";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function PaymentForm({
  provider,
  publicKey,
  initialStatus,
}: {
  provider: "payjp" | "mock";
  publicKey: string | null;
  initialStatus: "created" | "processing" | "failed";
}) {
  const router = useRouter();
  const [phase, setPhase] = useState<Phase>(initialStatus === "processing" ? "confirming" : "idle");
  const [error, setError] = useState<string | null>(null);
  const busy = phase !== "idle" && phase !== "timeout";
  const submitting = useRef(false);

  /** サーバーで決済が確定するまで状態を確認する（成功判定は必ずサーバー側） */
  const poll = useCallback(async () => {
    for (let i = 0; i < 45; i++) {
      try {
        const res = await fetch("/api/checkout/status", { cache: "no-store" });
        const data = (await res.json()) as { status?: string };
        if (data.status === "succeeded") {
          setPhase("success");
          await sleep(1300);
          router.replace("/fortune/input");
          return;
        }
        if (data.status === "failed") {
          setPhase("idle");
          setError("お支払いを完了できませんでした。カード情報をご確認のうえ、もう一度お試しください。");
          return;
        }
        if (data.status === "expired") {
          setPhase("idle");
          setError("お支払いの有効期限が切れました。お手数ですが占いの選択からやり直してください。");
          return;
        }
      } catch {
        /* 一時的な通信エラーは再試行 */
      }
      await sleep(i < 5 ? 1200 : 2500);
    }
    setPhase("timeout");
  }, [router]);

  const waitForConfirmation = useCallback(() => {
    setPhase("confirming");
    return poll();
  }, [poll]);

  useEffect(() => {
    // リロード等で処理中の決済に戻ってきた場合は確認を再開（初期 phase は confirming）
    // poll 内の setState はすべて await fetch の後（非同期）で行われる
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (initialStatus === "processing") void poll();
  }, [initialStatus, poll]);

  async function submitToken(cardToken: string) {
    setPhase("charging");
    try {
      const res = await fetch("/api/checkout/pay", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cardToken }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        setPhase("idle");
        setError(data?.error?.message ?? "お支払いを完了できませんでした。もう一度お試しください。");
        return;
      }
      await waitForConfirmation();
    } catch {
      // 課金済みの可能性があるため、まず状態を確認する（再課金はしない）
      await waitForConfirmation();
    }
  }

  async function guarded(fn: () => Promise<void>) {
    if (submitting.current) return;
    submitting.current = true;
    setError(null);
    try {
      await fn();
    } finally {
      submitting.current = false;
    }
  }

  if (phase === "confirming" || phase === "charging" || phase === "success") {
    return (
      <div className="glass flex flex-col items-center gap-4 rounded-3xl px-6 py-10 text-center" role="status" aria-live="polite">
        {phase === "success" ? (
          <>
            <span className="flex h-16 w-16 items-center justify-center rounded-full bg-gradient-to-br from-gold-200 to-gold-500 text-3xl text-night-900 reveal">✓</span>
            <p className="font-serif text-xl font-bold text-gold-200">お支払いが完了しました</p>
            <p className="text-[13px] text-ink-muted">占いの入力画面へ移動します…</p>
          </>
        ) : (
          <>
            <Spinner className="h-10 w-10 text-gold-300" />
            <p className="font-serif text-lg text-gold-200">決済を確認しています…</p>
            <p className="text-[12px] leading-relaxed text-ink-muted">
              画面を閉じたり、戻るボタンを押したりせずに
              <br />
              そのままお待ちください。
            </p>
          </>
        )}
      </div>
    );
  }

  return (
    <div>
      {phase === "timeout" ? (
        <div role="alert" className="mb-4 rounded-2xl border border-gold-300/30 bg-gold-300/5 p-4 text-[13px] leading-relaxed text-gold-50">
          決済の確認に時間がかかっています。二重にお支払いいただく必要はありません。
          <button type="button" onClick={() => void waitForConfirmation()} className="btn-ghost mt-3 block w-full rounded-xl py-2.5 text-sm">
            もう一度確認する
          </button>
        </div>
      ) : null}
      {error ? (
        <p role="alert" className="mb-4 rounded-2xl bg-danger/10 px-4 py-3 text-[13px] leading-relaxed text-danger">
          {error}
        </p>
      ) : null}
      {provider === "payjp" && publicKey ? (
        <PayjpCardForm publicKey={publicKey} busy={busy} phase={phase} onToken={(t) => guarded(() => submitToken(t))} setPhase={setPhase} setError={setError} />
      ) : (
        <MockCardForm busy={busy} onToken={(t) => guarded(() => submitToken(t))} />
      )}
    </div>
  );
}

function PayButton({ busy, label }: { busy: boolean; label: string }) {
  return (
    <button type="submit" disabled={busy} className="btn-gold mt-5 flex h-14 w-full items-center justify-center gap-2 rounded-2xl text-base font-bold tracking-wide">
      {busy ? (
        <>
          <Spinner /> {label}
        </>
      ) : (
        "100円を支払う"
      )}
    </button>
  );
}

const ELEMENT_STYLE = {
  style: {
    base: { color: "#eef0fa", fontSize: "16px", "::placeholder": { color: "#6f7596" } },
    invalid: { color: "#ff8a8a" },
  },
};

function PayjpCardForm({
  publicKey,
  busy,
  phase,
  onToken,
  setPhase,
  setError,
}: {
  publicKey: string;
  busy: boolean;
  phase: Phase;
  onToken: (token: string) => void;
  setPhase: (p: Phase) => void;
  setError: (e: string | null) => void;
}) {
  const [ready, setReady] = useState(false);
  const [email, setEmail] = useState("");
  const payjp = useRef<PayjpInstance | null>(null);
  const numberEl = useRef<PayjpElement | null>(null);

  const init = useCallback(() => {
    if (!window.Payjp || payjp.current) return;
    payjp.current = window.Payjp(publicKey, { locale: "ja" });
    const elements = payjp.current.elements();
    numberEl.current = elements.create("cardNumber", ELEMENT_STYLE);
    numberEl.current.mount("#card-number");
    elements.create("cardExpiry", ELEMENT_STYLE).mount("#card-expiry");
    elements.create("cardCvc", ELEMENT_STYLE).mount("#card-cvc");
    setReady(true);
  }, [publicKey]);

  useEffect(() => {
    init();
  }, [init]);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (busy || !payjp.current || !numberEl.current) return;
    setPhase("tokenizing");
    // カード番号は PAY.JP の iframe 内でのみ扱われ、当社サーバーには送られない。3Dセキュア認証を行う
    const r = await payjp.current.createToken(numberEl.current, {
      three_d_secure: true,
      card: email ? { email } : undefined,
    });
    if (!r.id) {
      setPhase("idle");
      setError(r.error?.message ?? "カード情報を確認できませんでした。入力内容をご確認ください。");
      return;
    }
    onToken(r.id);
  }

  const box = "field flex h-[50px] items-center";
  return (
    <form onSubmit={onSubmit} className="glass rounded-3xl p-5">
      <Script src="https://js.pay.jp/v2/pay.js" strategy="afterInteractive" onReady={init} />
      <label className="mb-1.5 block text-[12px] text-ink-muted">カード番号</label>
      <div id="card-number" className={box} />
      <div className="mt-3 grid grid-cols-2 gap-3">
        <div>
          <label className="mb-1.5 block text-[12px] text-ink-muted">有効期限</label>
          <div id="card-expiry" className={box} />
        </div>
        <div>
          <label className="mb-1.5 block text-[12px] text-ink-muted">セキュリティコード</label>
          <div id="card-cvc" className={box} />
        </div>
      </div>
      <label className="mb-1.5 mt-3 block text-[12px] text-ink-muted" htmlFor="tds-email">
        メールアドレス（3Dセキュア認証用・任意）
      </label>
      <input id="tds-email" type="email" inputMode="email" autoComplete="email" className="field" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="カード会社の本人認証に使用されます" />
      <p className="mt-1.5 text-[11px] leading-relaxed text-ink-faint">カード会社の本人認証にのみ使用され、当サービスには保存されません。</p>
      <PayButton busy={busy || !ready} label={phase === "tokenizing" ? "カード情報を確認しています…" : "読み込み中…"} />
    </form>
  );
}

/** 開発・検証用（PAYMENT_PROVIDER=mock）。実際の請求は発生しない */
function MockCardForm({ busy, onToken }: { busy: boolean; onToken: (t: string) => void }) {
  const [number, setNumber] = useState("4242 4242 4242 4242");
  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    const digits = number.replace(/\D/g, "");
    onToken(digits === "4242424242424242" ? "mock_tok_success" : digits.endsWith("0002") ? "mock_tok_declined" : "mock_tok_invalid");
  }
  return (
    <form onSubmit={onSubmit} className="glass rounded-3xl p-5">
      <p className="mb-4 rounded-xl border border-violet-400/30 bg-violet-500/10 px-3 py-2 text-[12px] leading-relaxed text-violet-300">
        テスト決済モードです。実際の請求は発生しません。
        <br />
        成功: 4242 4242 4242 4242 ／ 失敗: 4000 0000 0000 0002
      </p>
      <label className="mb-1.5 block text-[12px] text-ink-muted" htmlFor="mock-number">
        カード番号
      </label>
      <input id="mock-number" className="field font-mono tracking-wider" inputMode="numeric" autoComplete="off" value={number} onChange={(e) => setNumber(e.target.value)} />
      <div className="mt-3 grid grid-cols-2 gap-3">
        <input className="field" defaultValue="12 / 30" aria-label="有効期限" autoComplete="off" />
        <input className="field" defaultValue="123" aria-label="セキュリティコード" inputMode="numeric" autoComplete="off" />
      </div>
      <PayButton busy={busy} label="処理しています…" />
    </form>
  );
}
