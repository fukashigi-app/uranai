"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { FortuneTypeValue } from "@/lib/db/schema";
import { FORTUNE_CATALOG, FORTUNE_ORDER } from "@/lib/fortune/catalog";
import { DISPLAY_PRICE_JPY } from "@/config/site";
import { FortuneIcon } from "./fortune-icons";
import { Spinner } from "@/components/ui/spinner";


/**
 * @param testMode ENABLE_TEST_PAYMENT=true のとき true（サーバーで判定して渡す）。決済をスキップして無料で占える
 * @param stripeTest Stripe のテスト決済の専用の入口（/fortune?pay=stripe-test。サーバーで運営アカウントだと確かめたときだけ true）。
 *   有料の注文（/api/checkout）を作って支払い画面へ進む。testMode より優先する
 */
export function FortuneSelector({ testMode: testModeProp = false, stripeTest = false }: { testMode?: boolean; stripeTest?: boolean }) {
  const testMode = testModeProp && !stripeTest;
  const router = useRouter();
  const [selected, setSelected] = useState<FortuneTypeValue | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function start() {
    if (!selected || loading) return;
    setLoading(true);
    setError(null);
    try {
      // テストモードは決済をスキップする専用API、通常は決済セッション作成
      const res = await fetch(testMode ? "/api/test-fortune" : "/api/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fortuneType: selected }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        if (data?.error?.code === "paid_session_exists") return router.push("/fortune/input");
        if (data?.error?.code === "payment_processing") return router.push("/payment");
        setError(data?.error?.message ?? "エラーが発生しました。もう一度お試しください。");
        setLoading(false);
        return;
      }
      router.push(testMode ? "/fortune/input" : "/payment");
    } catch {
      setError("通信エラーが発生しました。電波の良い場所で、もう一度お試しください。");
      setLoading(false);
    }
  }

  return (
    <div className={testMode || stripeTest ? "pb-48" : "pb-36"}>
      <div role="radiogroup" aria-label="占いの種類" className="space-y-3">
        {FORTUNE_ORDER.map((t, i) => {
          const item = FORTUNE_CATALOG[t];
          const active = selected === t;
          return (
            <button
              key={t}
              type="button"
              role="radio"
              aria-checked={active}
              onClick={(e) => {
                setSelected(t);
                e.currentTarget.scrollIntoView({ behavior: "smooth", block: "center" });
              }}
              style={{ animationDelay: `${i * 90}ms` }}
              className={`fade-up glass relative flex w-full items-center rounded-3xl px-4 py-3.5 text-left transition-all duration-200 active:scale-[0.99] ${
                active ? "!border-gold-300/80 shadow-[0_0_0_1px_rgba(223,196,136,0.5),0_18px_50px_-18px_rgba(207,171,102,0.55)]" : "hover:border-white/25"
              }`}
            >
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-2.5 pr-6">
                  <span
                    className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border transition-colors ${
                      active ? "border-gold-300/50 bg-gold-300/10" : "border-white/10 bg-white/5"
                    }`}
                  >
                    <FortuneIcon type={t} className="h-7 w-7" />
                  </span>
                  <span className="flex-1 font-serif text-lg font-bold tracking-wide text-ink">{item.label}</span>
                  <span className="shrink-0 rounded-full bg-white/8 px-2 py-0.5 text-[11px] text-gold-200">{DISPLAY_PRICE_JPY}円</span>
                </span>
                <span className="mt-2 block text-[13.5px] font-bold leading-snug text-gold-200 [text-wrap:balance]">{item.catch}</span>
                <span className="mt-1 block text-[12.5px] leading-relaxed text-ink-muted">{item.description}</span>
                <span className="mt-2 flex flex-wrap gap-1.5 text-[11px]">
                  <span className="rounded-full border border-white/10 px-2 py-0.5 text-ink-muted">入力：{item.inputHint}</span>
                  <span className="rounded-full border border-violet-400/30 px-2 py-0.5 text-violet-300">{item.forWhom}</span>
                </span>
              </span>
              <span
                aria-hidden
                className={`absolute right-3 top-3.5 flex h-5 w-5 items-center justify-center rounded-full border text-[11px] transition-all ${
                  active ? "border-gold-300 bg-gold-300 text-night-900 scale-100" : "border-white/20 scale-90 opacity-0"
                }`}
              >
                ✓
              </span>
            </button>
          );
        })}
      </div>

      <div
        className={`fixed inset-x-0 bottom-0 z-20 transition-all duration-300 ${
          selected ? "translate-y-0 opacity-100" : "pointer-events-none translate-y-6 opacity-0"
        }`}
      >
        <div className="glass-strong mx-auto max-w-md rounded-t-3xl border-b-0 px-5 pb-[max(1rem,env(safe-area-inset-bottom))] pt-4">
          {error ? (
            <p role="alert" className="mb-3 rounded-xl bg-danger/10 px-3 py-2 text-[13px] text-danger">
              {error}
            </p>
          ) : null}
          <div className="mb-2 flex items-baseline justify-between text-sm">
            <span className="text-ink-muted">{selected ? FORTUNE_CATALOG[selected].label : ""}</span>
            <span>
              <span className="font-display text-2xl font-semibold text-gold-200">{DISPLAY_PRICE_JPY}</span>
              <span className="ml-0.5 text-gold-200">円</span>
              <span className="ml-1 text-[11px] text-ink-faint">（税込・1回）</span>
            </span>
          </div>
          <button
            type="button"
            onClick={start}
            disabled={!selected || loading}
            className="btn-gold flex h-14 w-full items-center justify-center gap-2 rounded-2xl text-base font-bold tracking-wide"
          >
            {loading ? (
              <>
                <Spinner /> 準備しています…
              </>
            ) : stripeTest ? (
              `この占いを${DISPLAY_PRICE_JPY}円で始める（Stripeテスト決済）`
            ) : testMode ? (
              "テストモード：無料で占う"
            ) : (
              `この占いを${DISPLAY_PRICE_JPY}円で始める`
            )}
          </button>
          {stripeTest ? (
            <p className="mt-2 text-center text-[11px] leading-relaxed text-sky-200">Stripe Sandbox のテスト決済です（運営アカウントのみ）。実際の請求は発生しません。</p>
          ) : null}
          {testMode ? (
            <p className="mt-2 text-center text-[11px] leading-relaxed text-violet-300">
              現在テストモードのため決済は発生しません
              <span className="block text-ink-faint">（本番ではここが「この占いを{DISPLAY_PRICE_JPY}円で始める」になります）</span>
            </p>
          ) : null}
        </div>
      </div>
    </div>
  );
}
