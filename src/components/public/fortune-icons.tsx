import type { FortuneTypeValue } from "@/lib/db/schema";

const stroke = { stroke: "url(#icon-gold)", strokeWidth: 1.6, fill: "none", strokeLinecap: "round" as const, strokeLinejoin: "round" as const };

function Defs() {
  return (
    <defs>
      <linearGradient id="icon-gold" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stopColor="#faf3df" />
        <stop offset=".6" stopColor="#dfc488" />
        <stop offset="1" stopColor="#b8904a" />
      </linearGradient>
    </defs>
  );
}

export function FortuneIcon({ type, className = "h-12 w-12" }: { type: FortuneTypeValue; className?: string }) {
  if (type === "BIRTHDAY") {
    return (
      <svg viewBox="0 0 48 48" className={className} aria-hidden>
        <Defs />
        <rect x="8" y="11" width="32" height="29" rx="5" {...stroke} />
        <path d="M8 19h32M16 7v7M32 7v7" {...stroke} />
        <path d="M24 23.5l1.8 3.8 4.2.5-3.1 2.9.8 4.1-3.7-2.1-3.7 2.1.8-4.1-3.1-2.9 4.2-.5z" fill="url(#icon-gold)" />
      </svg>
    );
  }
  if (type === "ZODIAC") {
    return (
      <svg viewBox="0 0 48 48" className={className} aria-hidden>
        <Defs />
        <circle cx="24" cy="24" r="17" {...stroke} strokeOpacity=".5" />
        <path d="M12 30l8-9 7 5 9-11" {...stroke} />
        {[
          [12, 30],
          [20, 21],
          [27, 26],
          [36, 15],
        ].map(([x, y]) => (
          <circle key={`${x}-${y}`} cx={x} cy={y} r="2.2" fill="url(#icon-gold)" />
        ))}
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 48 48" className={className} aria-hidden>
      <Defs />
      <path d="M24 7c6 8.5 11 15 11 21a11 11 0 0 1-22 0c0-6 5-12.5 11-21z" {...stroke} />
      <path d="M19 30a5 5 0 0 0 5 5" {...stroke} />
      <path d="M37 9l.9 2.4 2.4.9-2.4.9L37 15.6l-.9-2.4-2.4-.9 2.4-.9z" fill="url(#icon-gold)" />
    </svg>
  );
}
