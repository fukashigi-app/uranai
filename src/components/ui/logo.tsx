import { siteConfig } from "@/config/site";

export function MoonMark({ className = "h-8 w-8" }: { className?: string }) {
  return (
    <svg viewBox="0 0 64 64" className={className} aria-hidden>
      <defs>
        <linearGradient id="moon-g" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#faf3df" />
          <stop offset=".55" stopColor="#dfc488" />
          <stop offset="1" stopColor="#b8904a" />
        </linearGradient>
      </defs>
      <path d="M38 12a20 20 0 1 0 14 34A17 17 0 0 1 38 12z" fill="url(#moon-g)" />
      <path d="M46 14l1.6 4.4L52 20l-4.4 1.6L46 26l-1.6-4.4L40 20l4.4-1.6z" fill="#faf3df" />
    </svg>
  );
}

export function Logo({ sub }: { sub?: string }) {
  return (
    <span className="inline-flex items-center gap-2">
      <MoonMark className="h-7 w-7" />
      <span className="font-serif text-[17px] font-bold tracking-wider text-gold-gradient">{siteConfig.name}</span>
      {sub ? <span className="ml-1 rounded-full border border-white/15 px-2 py-0.5 text-[10px] tracking-widest text-ink-muted">{sub}</span> : null}
    </span>
  );
}
