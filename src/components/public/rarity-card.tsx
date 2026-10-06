import type { RarityInfo, Stars } from "@/lib/fortune/types";
import { StarRating } from "@/components/ui/stars";
import { MoonPhase } from "./moon-phase";

/** レア度ごとの見た目（重い演出は使わず、枠・光・色で段階を表現） */
const STYLE: Record<RarityInfo["key"], { frame: string; name: string; tagline: string }> = {
  NEW_MOON: {
    frame: "border-violet-400/25 bg-gradient-to-b from-night-600/70 to-night-800/80",
    name: "text-violet-300",
    tagline: "text-ink-muted",
  },
  CRESCENT: {
    frame: "border-gold-300/25 bg-gradient-to-b from-night-600/75 to-night-800/80",
    name: "text-gold-200",
    tagline: "text-ink-muted",
  },
  HALF_MOON: {
    frame: "border-gold-300/40 bg-gradient-to-b from-night-600/80 to-night-800/80 shadow-[0_24px_70px_-30px_rgba(223,196,136,0.55)]",
    name: "text-gold-200",
    tagline: "text-gold-50/80",
  },
  FULL_MOON: {
    frame: "rarity-full border-gold-300/70 bg-gradient-to-b from-[#2a2a4a]/90 to-night-800/90 shadow-[0_30px_90px_-25px_rgba(223,196,136,0.75)]",
    name: "rarity-gold-text",
    tagline: "text-gold-50",
  },
  MIRACLE: {
    frame: "rarity-miracle border-transparent shadow-[0_30px_110px_-20px_rgba(236,217,166,0.85)]",
    name: "rarity-gold-text",
    tagline: "text-gold-50",
  },
};

export function RarityCard({
  rarity,
  overall,
  typeLabel,
  dateLabel,
  subject,
  rank,
}: {
  rarity: RarityInfo;
  overall: Stars;
  typeLabel: string;
  dateLabel: string;
  subject: React.ReactNode;
  rank?: number;
}) {
  const st = STYLE[rarity.key];
  const [y, m, d] = dateLabel.split("-");
  const high = rarity.level >= 4;
  return (
    <section
      className={`reveal relative overflow-hidden rounded-[2rem] border px-6 pb-6 pt-5 text-center ${st.frame}`}
      aria-label={`今日の運勢レア度 ${rarity.en}｜${rarity.ja}`}
      data-rarity={rarity.key}
    >
      {high ? <div className="pointer-events-none absolute inset-x-0 -top-28 mx-auto h-56 w-56 rounded-full bg-gold-300/25 blur-3xl" aria-hidden /> : null}
      {rarity.key === "MIRACLE" ? <Constellation /> : null}
      {rarity.key === "MIRACLE" ? <Sparkles count={6} /> : null}
      {rarity.key === "HALF_MOON" ? <Sparkles count={3} /> : null}
      {rarity.key === "FULL_MOON" ? <FullMoonLight /> : null}
      <p className="relative text-[11px] tracking-[0.25em] text-ink-muted">
        {typeLabel}・{y}.{m}.{d}
      </p>
      <p className="relative mt-3 font-serif text-base text-ink">{subject}</p>
      {rank ? (
        <p className={`relative mx-auto mt-2 inline-flex items-baseline gap-1 rounded-full px-4 py-1 ${rank === 1 ? "bg-gold-300/20 text-gold-50" : "bg-white/5 text-ink"}`}>
          <span className="text-[12px]">12星座中</span>
          <span className="font-display text-3xl leading-none">{rank}</span>
          <span className="text-[12px]">位</span>
        </p>
      ) : null}

      <div className="hairline relative my-4" />
      <p className="relative text-[11px] tracking-[0.3em] text-ink-muted">今日の運勢レア度</p>
      <div className="relative mt-2 flex justify-center">
        <MoonPhase level={rarity.level} className={high ? "h-16 w-16" : "h-14 w-14"} />
      </div>
      <p className={`relative mt-2 font-display text-[28px] font-semibold leading-tight tracking-[0.12em] ${st.name}`}>{rarity.en}</p>
      <p className={`relative text-[13px] tracking-[0.2em] ${st.name}`}>{rarity.ja}</p>
      <p className={`relative mt-1.5 font-serif text-[15px] ${st.tagline}`}>「{rarity.tagline}」</p>

      <div className="relative mt-4 flex justify-center">
        <StarRating value={overall} size="lg" label="総合運" />
      </div>
      <ul className="relative mx-auto mt-4 max-w-xs space-y-1 text-left text-[12.5px] leading-relaxed text-ink-muted">
        {rarity.reasons.map((r) => (
          <li key={r} className="flex gap-2">
            <span className="text-gold-300" aria-hidden>
              ✦
            </span>
            <span>{r}</span>
          </li>
        ))}
      </ul>
      {rarity.special ? <p className="relative mt-4 rounded-2xl bg-gold-300/10 px-4 py-3 font-serif text-[14px] leading-relaxed text-gold-50">{rarity.special}</p> : null}
    </section>
  );
}

/** 静かな星のきらめき（CSSのみ・少数の要素）。奇跡の星夜は6個、上弦は3個 */
function Sparkles({ count }: { count: number }) {
  // 文字に重ならないよう、カードの左右の端だけに置く
  const stars = [
    [5, 10, 0],
    [92, 8, 0.6],
    [4, 48, 1.2],
    [94, 38, 0.3],
    [93, 70, 0.9],
    [5, 86, 1.5],
  ];
  return (
    <div className="pointer-events-none absolute inset-0" aria-hidden>
      {stars.slice(0, count).map(([x, y, delay], i) => (
        <span key={i} className="rarity-twinkle absolute text-[10px] text-gold-50" style={{ left: `${x}%`, top: `${y}%`, animationDelay: `${delay}s` }}>
          ✦
        </span>
      ))}
    </div>
  );
}

/** 満月：カードを1回だけ横切る光と、ゆっくり舞う金色の粒（6個） */
function FullMoonLight() {
  const particles = [
    [8, 78, 0],
    [90, 70, 1.4],
    [14, 40, 2.6],
    [86, 30, 0.7],
    [6, 60, 3.3],
    [94, 52, 2],
  ];
  return (
    <div className="pointer-events-none absolute inset-0" aria-hidden>
      <span className="rarity-sweep" />
      {particles.map(([x, y, d], i) => (
        <span key={i} className="rarity-particle" style={{ left: `${x}%`, top: `${y}%`, animationDelay: `${d}s` }} />
      ))}
    </div>
  );
}

/** 奇跡の星夜：星座を思わせる線（演出後も残る静的な背景） */
function Constellation() {
  return (
    <svg className="pointer-events-none absolute inset-0 h-full w-full opacity-40" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden>
      <g stroke="#ecd9a6" strokeWidth="0.25" fill="none">
        <polyline points="6,18 14,9 22,15 18,26" />
        <polyline points="78,12 86,20 94,14" />
        <polyline points="8,70 15,82 24,78" />
        <polyline points="80,84 88,74 95,80" />
      </g>
      <g fill="#fffaf0">
        {[
          [6, 18],
          [14, 9],
          [22, 15],
          [18, 26],
          [78, 12],
          [86, 20],
          [94, 14],
          [8, 70],
          [15, 82],
          [24, 78],
          [80, 84],
          [88, 74],
          [95, 80],
        ].map(([x, y], i) => (
          <circle key={i} cx={x} cy={y} r="0.6" />
        ))}
      </g>
    </svg>
  );
}
