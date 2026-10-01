export function Spinner({ className = "h-5 w-5" }: { className?: string }) {
  return (
    <svg className={`${className} animate-spin`} viewBox="0 0 24 24" aria-hidden>
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity=".25" strokeWidth="3" fill="none" />
      <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="3" strokeLinecap="round" fill="none" />
    </svg>
  );
}

/** 月と星が周回する占い中アニメーション */
export function CelestialLoader({ label }: { label: string }) {
  return (
    <div className="flex flex-col items-center gap-6 py-6" role="status" aria-live="polite">
      <div className="relative h-36 w-36">
        <div className="absolute inset-0 rounded-full border border-gold-300/20" />
        <div className="absolute inset-4 rounded-full border border-violet-400/20" />
        <div className="absolute inset-0 animate-orbit">
          <span className="absolute -top-1.5 left-1/2 h-3 w-3 -translate-x-1/2 rounded-full bg-gold-200 shadow-[0_0_14px_4px_rgba(236,217,166,0.6)]" />
        </div>
        <div className="absolute inset-4 animate-orbit-slow">
          <span className="absolute -bottom-1 left-1/2 h-2 w-2 -translate-x-1/2 rounded-full bg-violet-300 shadow-[0_0_10px_3px_rgba(195,181,255,0.6)]" />
        </div>
        <div className="absolute inset-10 rounded-full bg-gradient-to-br from-gold-50 via-gold-300 to-gold-500 animate-glow" />
        <div className="absolute inset-10 translate-x-3 -translate-y-2 rounded-full bg-night-800" />
      </div>
      <p className="font-serif text-lg tracking-wider text-gold-200">{label}</p>
    </div>
  );
}
