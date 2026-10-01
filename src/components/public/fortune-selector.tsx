"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { FortuneTypeValue } from "@/lib/db/schema";
import { FORTUNE_CATALOG } from "@/lib/fortune/catalog";
import { DISPLAY_PRICE_JPY } from "@/config/site";
import { FortuneIcon } from "./fortune-icons";
import { Spinner } from "@/components/ui/spinner";

const TYPES: FortuneTypeValue[] = ["BIRTHDAY", "ZODIAC", "BLOOD"];

export function FortuneSelector() {
  const router = useRouter();
  const [selected, setSelected] = useState<FortuneTypeValue | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function start() {
    if (!selected || loading) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/checkout", {
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
      router.push("/payment");
    } catch {
      setError("通信エラーが発生しました。電波の良い場所で、もう一度お試しください。");
      setLoading(false);
    }
  }

  return (
    <div className="pb-36">
      <div role="radiogroup" aria-label="占いの種類" className="space-y-3.5">
        {TYPES.map((t, i) => {
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
              className={`fade-up glass relative flex w-full items-center gap-4 rounded-3xl p-5 text-left transition-all duration-200 active:scale-[0.99] ${
                active ? "!border-gold-300/80 shadow-[0_0_0_1px_rgba(223,196,136,0.5),0_18px_50px_-18px_rgba(207,171,102,0.55)]" : "hover:border-white/25"
              }`}
            >
              <span
                className={`flex h-16 w-16 shrink-0 items-center justify-center rounded-2xl border transition-colors ${
                  active ? "border-gold-300/50 bg-gold-300/10" : "border-white/10 bg-white/5"
                }`}
              >
                <FortuneIcon type={t} className="h-10 w-10" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="flex items-center justify-between gap-2">
                  <span className="font-serif text-lg font-bold tracking-wide text-ink">{item.label}</span>
                  <span className="shrink-0 rounded-full bg-white/8 px-2 py-0.5 text-[11px] text-gold-200">1回 {DISPLAY_PRICE_JPY}円</span>
                </span>
                <span className="mt-1 block text-[13px] leading-relaxed text-ink-muted">{item.description}</span>
              </span>
              <span
                aria-hidden
                className={`absolute right-3 top-3 flex h-5 w-5 items-center justify-center rounded-full border text-[11px] transition-all ${
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
            ) : (
              `この占いを${DISPLAY_PRICE_JPY}円で始める`
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
