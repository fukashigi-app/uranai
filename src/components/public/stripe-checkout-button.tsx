"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Spinner } from "@/components/ui/spinner";
import { PAY_BUTTON_LABEL } from "@/lib/legal/labels";

/**
 * Stripe Checkout（テスト決済）へ移動するボタン。URL はサーバーが注文と紐付けてから返す（/api/checkout/stripe-session）。
 * 運営アカウントだけに表示される（ページ側とサーバー側の両方で確認している）。
 */
export function StripeCheckoutButton({ canceled }: { canceled: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function start() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/checkout/stripe-session", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
      const json = (await res.json().catch(() => null)) as { status?: string; url?: string; error?: { message?: string } } | null;
      if (res.ok && json?.status === "succeeded") {
        router.push("/fortune/input");
        return;
      }
      if (res.ok && json?.status === "pending" && json.url?.startsWith("/payment/return?")) {
        router.push(json.url);
        return;
      }
      if (res.ok && json?.status === "redirect" && json.url) {
        window.location.assign(json.url);
        return;
      }
      setError(json?.error?.message ?? "決済画面を開けませんでした。もう一度お試しください。");
    } catch {
      setError("通信に失敗しました。電波の良い場所で、もう一度お試しください。");
    }
    setBusy(false);
  }

  return (
    <div className="glass rounded-3xl p-5">
      <p className="rounded-xl border border-sky-400/30 bg-sky-500/10 px-3 py-2.5 text-[12px] leading-relaxed text-sky-200">
        Stripe のテスト決済です（運営アカウントのみ）。実際の請求は発生しません。決済画面ではクレジットカード（Apple Pay・Google Pay を含む）または PayPay を選べます。Stripe のテスト用の支払い情報を使ってください。
      </p>
      {canceled ? (
        <p role="status" className="mt-3 rounded-xl bg-white/5 px-3 py-2 text-[13px] text-ink-muted">
          お支払いは完了していません（請求は発生していません）。もう一度お試しいただけます。
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="mt-3 rounded-xl bg-danger/10 px-3 py-2 text-[13px] text-danger">
          {error}
        </p>
      ) : null}
      <button type="button" onClick={start} disabled={busy} className="btn-gold mt-5 flex h-14 w-full items-center justify-center gap-2 rounded-2xl text-base font-bold tracking-wide">
        {busy ? (
          <>
            <Spinner /> 決済画面を開いています…
          </>
        ) : (
          `${PAY_BUTTON_LABEL}（テスト）`
        )}
      </button>
    </div>
  );
}
