import { siteConfig, DISPLAY_PRICE_JPY } from "@/config/site";

export function Hero({ storeName }: { storeName?: string }) {
  return (
    <section className="relative mb-7 mt-3 overflow-hidden rounded-[2rem] px-6 pb-7 pt-8 text-center fade-up">
      <svg viewBox="0 0 100 100" className="pointer-events-none absolute -right-6 -top-6 h-36 w-36 opacity-90 drop-shadow-[0_0_24px_rgba(236,217,166,0.35)]" aria-hidden>
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
        {storeName ? (
          <p className="text-[12px] tracking-[0.25em] text-ink-muted">
            WELCOME TO <span className="text-gold-200">{storeName}</span>
          </p>
        ) : null}
        <h1 className="mt-3 font-serif text-[28px] font-bold leading-snug tracking-wide">
          <span className="text-gold-gradient">今日の星</span>を、
          <br />
          のぞいてみませんか。
        </h1>
        <p className="mt-3 text-[13px] leading-relaxed text-ink-muted">{siteConfig.tagline}</p>
        <div className="mt-5 inline-flex items-center gap-3 rounded-full border border-gold-300/30 bg-gold-300/[0.07] px-4 py-1.5">
          <span className="text-[12px] text-ink-muted">1回</span>
          <span className="font-display text-2xl font-semibold leading-none text-gold-200">{DISPLAY_PRICE_JPY}</span>
          <span className="text-[12px] text-gold-200">円（税込）</span>
        </div>
        <ol className="mt-6 grid grid-cols-3 gap-2 text-[11px] text-ink-muted">
          {["占いを選ぶ", "100円を支払う", "結果をチェック"].map((s, i) => (
            <li key={s} className="rounded-2xl border border-white/8 bg-white/[0.03] px-2 py-2.5">
              <span className="block font-display text-base text-gold-300">{i + 1}</span>
              {s}
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}
