"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Spinner } from "@/components/ui/spinner";
import { TEST_PAY_BUTTON_LABEL } from "@/lib/legal/labels";

/**
 * 疑似決済（自動テスト専用。PAYMENT_PROVIDER=mock のときだけサーバーが表示する。Vercel の本番では表示されない）。
 * カード情報の入力はなく、実際の請求は発生しない。決済の結果は必ずサーバーで確認する（/api/checkout/status）。
 * 実際の決済は Stripe Checkout（stripe-checkout-button.tsx）で、この画面は使わない。PAY.JP のカード入力フォームは廃止した。
 */
type Phase = "idle" | "charging" | "confirming" | "success" | "timeout";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function MockPaymentForm({ initialStatus }: { initialStatus: "created" | "processing" | "failed" }) {
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
          setError("お支払いを完了できませんでした。もう一度お試しください。");
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
      <MockCardForm busy={busy} onToken={(t) => guarded(() => submitToken(t))} />
    </div>
  );
}

/** 疑似決済のボタン（実際の請求は発生しない） */
function MockCardForm({ busy, onToken }: { busy: boolean; onToken: (t: string) => void }) {
  return (
    <div className="glass rounded-3xl p-5">
      <p className="rounded-xl border border-violet-400/30 bg-violet-500/10 px-3 py-2.5 text-[12px] leading-relaxed text-violet-300">
        自動テスト用の疑似決済です。カード情報の入力は不要で、実際の請求は発生しません。
      </p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (!busy) onToken("mock_tok_success");
        }}
      >
        <button type="submit" disabled={busy} className="btn-gold mt-5 flex h-14 w-full items-center justify-center gap-2 rounded-2xl text-base font-bold tracking-wide">
          {busy ? (
            <>
              <Spinner /> 処理しています…
            </>
          ) : (
            TEST_PAY_BUTTON_LABEL
          )}
        </button>
      </form>
      <button
        type="button"
        disabled={busy}
        onClick={() => onToken("mock_tok_declined")}
        className="mt-3 w-full text-center text-[12px] text-ink-faint underline underline-offset-4"
      >
        決済失敗時の表示を確認する
      </button>
    </div>
  );
}
