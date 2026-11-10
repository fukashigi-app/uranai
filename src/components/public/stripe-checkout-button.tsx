"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Spinner } from "@/components/ui/spinner";
import { PAY_BUTTON_LABEL, PAY_BUTTON_NEXT_STEP_NOTE, STRIPE_TEST_PAY_BUTTON_LABEL } from "@/lib/legal/labels";

/**
 * Stripe Checkout へ移動するボタン。URL はサーバーが注文と紐付けてから返す（/api/checkout/stripe-session）。
 * 使える人・表示はサーバーで判定して渡す（ページ側とサーバー側の両方で確認している）。
 *  - operator_test … 運営アカウントだけのテスト決済（Sandbox）
 *  - operator_live … 運営アカウントだけの本番決済テスト（Production の開発モード。実際に請求される）
 *  - public_test   … 一般のお客さん向けの画面のテスト（Stripe Sandbox。実際の請求は発生しない）
 *  - live          … 本番決済（一般のお客さん）
 */
export type StripeCheckoutVariant = "operator_test" | "operator_live" | "public_test" | "live";

const NOTICE: Record<Exclude<StripeCheckoutVariant, "live">, string> = {
  operator_live: "本番の決済です（運営アカウントだけの確認用）。実際に請求され、売上・店舗の精算に含まれます。確認が終わったら、Stripe のダッシュボードから返金してください（返金した決済は売上・精算から外れます）。テスト用のカード番号は使えません。",
  operator_test: "Stripe のテスト決済です（運営アカウントのみ）。実際の請求は発生しません。決済画面ではクレジットカード（Apple Pay・Google Pay を含む）または PayPay を選べます。Stripe のテスト用の支払い情報を使ってください。",
  public_test: "テスト環境です。実際の請求は発生しません。決済画面に表示されるお支払い方法（クレジットカードなど）から選べます。Stripe のテスト用の支払い情報を使ってください。",
};

export function StripeCheckoutButton({ canceled, variant }: { canceled: boolean; variant: StripeCheckoutVariant }) {
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
      {variant === "live" ? (
        <p className="text-[12px] leading-relaxed text-ink-muted">決済画面に表示されるお支払い方法（クレジットカードなど）から選べます。</p>
      ) : variant === "operator_live" ? (
        <p data-live-operator-notice="" className="rounded-xl border border-danger/40 bg-danger/10 px-3 py-2.5 text-[12px] leading-relaxed text-danger">
          {NOTICE.operator_live}
        </p>
      ) : (
        <p className="rounded-xl border border-sky-400/30 bg-sky-500/10 px-3 py-2.5 text-[12px] leading-relaxed text-sky-200">{NOTICE[variant]}</p>
      )}
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
          variant === "live" || variant === "operator_live" ? PAY_BUTTON_LABEL : STRIPE_TEST_PAY_BUTTON_LABEL
        )}
      </button>
      <p data-pay-next-step="" className="mt-2 text-center text-[12px] leading-relaxed text-ink-muted">
        {PAY_BUTTON_NEXT_STEP_NOTE}
      </p>
    </div>
  );
}
