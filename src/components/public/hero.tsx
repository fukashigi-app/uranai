import { DISPLAY_PRICE_JPY } from "@/config/site";

/**
 * QRから開いた最初の画面の見出し。スマホ1画面目で「何のサービスか・いくらか・何ができるか」が分かり、
 * そのすぐ下に3種類の占いが見えるよう、説明は最小限にしている。
 */
export function Hero({ storeName }: { storeName?: string }) {
  return (
    <section className="relative mb-3 mt-1 overflow-hidden rounded-[2rem] px-5 pb-4 pt-4 text-center fade-up">
      <svg viewBox="0 0 100 100" className="pointer-events-none absolute -right-5 -top-5 h-24 w-24 opacity-90 drop-shadow-[0_0_24px_rgba(236,217,166,0.35)]" aria-hidden>
        <defs>
          <linearGradient id="hero-moon" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="#faf3df" />
            <stop offset=".6" stopColor="#dfc488" />
            <stop offset="1" stopColor="#b8904a" stopOpacity=".6" />
          </linearGradient>
        </defs>
        <path d="M62 14a36 36 0 1 0 24 58A30 30 0 0 1 62 14z" fill="url(#hero-moon)" />
      </svg>
      <div className="pointer-events-none absolute inset-0 rounded-[2rem] border border-white/10 bg-gradient-to-b from-white/[0.06] to-transparent" aria-hidden />
      <div className="relative">
        {/* 店舗名は画面上部のヘッダーに表示しているので、ここでは繰り返さない（読み上げ用にだけ残す） */}
        {storeName ? <p className="sr-only">{storeName}へようこそ</p> : null}
        <h1 className="font-serif text-[24px] font-bold leading-snug tracking-wide">
          <span className="text-gold-gradient">今日の星</span>を、
          <br />
          のぞいてみませんか。
        </h1>
        <p className="mt-2 text-[13px] leading-relaxed text-ink">
          <span className="font-display text-xl font-semibold text-gold-200">{DISPLAY_PRICE_JPY}</span>
          <span className="text-gold-200">円</span>
          <span className="text-[11px] text-ink-faint">（税込）</span>で、<span className="whitespace-nowrap">3種類から選べる占い。</span>
          <span className="block text-[12px] text-ink-muted">登録不要・結果はその場ですぐ見られます</span>
        </p>
        <ol className="mt-3 flex flex-wrap items-center justify-center gap-x-1.5 gap-y-1 text-[11.5px] text-ink-muted" aria-label="ご利用の流れ">
          {["占いを選ぶ", `${DISPLAY_PRICE_JPY}円で占う`, "すぐ結果"].map((s, i) => (
            <li key={s} className="flex items-center gap-1.5 whitespace-nowrap">
              {i > 0 ? (
                <span className="text-ink-faint" aria-hidden>
                  ›
                </span>
              ) : null}
              <span className="rounded-full border border-white/10 bg-white/[0.04] px-2.5 py-1">
                <span className="mr-1 font-display text-gold-300">{i + 1}</span>
                {s}
              </span>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}
