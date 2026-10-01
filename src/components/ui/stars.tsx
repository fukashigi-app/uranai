export function StarRating({ value, size = "md", label }: { value: number; size?: "sm" | "md" | "lg"; label?: string }) {
  const cls = size === "lg" ? "h-7 w-7" : size === "sm" ? "h-4 w-4" : "h-5 w-5";
  return (
    <span className="inline-flex items-center gap-0.5" role="img" aria-label={`${label ?? ""}${value}つ星（5段階）`}>
      {[1, 2, 3, 4, 5].map((i) => (
        <svg key={i} viewBox="0 0 24 24" className={cls} aria-hidden>
          <path
            d="M12 2.8l2.75 5.86 6.4.74-4.75 4.37 1.27 6.33L12 16.9l-5.67 3.2 1.27-6.33L2.85 9.4l6.4-.74z"
            fill={i <= value ? "url(#star-gold)" : "rgba(255,255,255,0.12)"}
            stroke={i <= value ? "none" : "rgba(255,255,255,0.18)"}
            strokeWidth="0.8"
          />
          <defs>
            <linearGradient id="star-gold" x1="0" y1="0" x2="1" y2="1">
              <stop offset="0" stopColor="#faf3df" />
              <stop offset=".6" stopColor="#dfc488" />
              <stop offset="1" stopColor="#b8904a" />
            </linearGradient>
          </defs>
        </svg>
      ))}
    </span>
  );
}
