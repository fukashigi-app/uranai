/** レア度の月アイコン（絵文字を使わず SVG で描く）。level 1=新月 … 4=満月 / 5=奇跡の星夜 */
export function MoonPhase({ level, className = "h-14 w-14" }: { level: 1 | 2 | 3 | 4 | 5; className?: string }) {
  const id = `moon-${level}`;
  return (
    <svg viewBox="0 0 48 48" className={className} aria-hidden>
      <defs>
        <radialGradient id={`${id}-gold`} cx="38%" cy="35%" r="70%">
          <stop offset="0" stopColor="#fffaf0" />
          <stop offset=".45" stopColor="#ecd9a6" />
          <stop offset="1" stopColor="#b8904a" />
        </radialGradient>
        <radialGradient id={`${id}-halo`} cx="50%" cy="50%" r="50%">
          <stop offset=".55" stopColor="#dfc488" stopOpacity=".55" />
          <stop offset="1" stopColor="#dfc488" stopOpacity="0" />
        </radialGradient>
        <mask id={`${id}-crescent`}>
          <rect width="48" height="48" fill="white" />
          <circle cx="17" cy="22" r="16" fill="black" />
        </mask>
      </defs>
      {level >= 4 ? <circle cx="24" cy="24" r="23" fill={`url(#${id}-halo)`} /> : null}
      {/* 影の部分（新月・三日月・上弦） */}
      <circle cx="24" cy="24" r="17" fill="#121a3a" stroke="#dfc488" strokeOpacity={level === 1 ? 0.7 : 0.25} strokeWidth="1" />
      {level === 1 ? <circle cx="24" cy="24" r="17" fill="#c3b5ff" opacity=".08" /> : null}
      {level === 2 ? <circle cx="24" cy="24" r="17" fill={`url(#${id}-gold)`} mask={`url(#${id}-crescent)`} /> : null}
      {level === 3 ? <path d="M24 7 A17 17 0 0 1 24 41 Z" fill={`url(#${id}-gold)`} /> : null}
      {level >= 4 ? <circle cx="24" cy="24" r="17" fill={`url(#${id}-gold)`} /> : null}
      {level === 5 ? (
        <g fill="#fffaf0">
          <path d="M40 4 l1.4 3.6 3.6 1.4 -3.6 1.4 -1.4 3.6 -1.4 -3.6 -3.6 -1.4 3.6 -1.4z" />
          <path d="M7 34 l1 2.4 2.4 1 -2.4 1 -1 2.4 -1 -2.4 -2.4 -1 2.4 -1z" opacity=".85" />
          <path d="M44 30 l.7 1.6 1.6 .7 -1.6 .7 -.7 1.6 -.7 -1.6 -1.6 -.7 1.6 -.7z" opacity=".7" />
        </g>
      ) : null}
    </svg>
  );
}
