import type { CareSection, RarityKey, StarComment } from "@/lib/fortune/types";
import { StarRating } from "@/components/ui/stars";

/** 結果画面の共通パーツ（血液型占い・生年月日占い v2 で使用） */

/** 各項目のふわっと表示（待たせすぎないよう短い間隔で） */
export const revealDelay = (i: number) => ({ animationDelay: `${120 + i * 70}ms` });

export function OverallCard({ overall, delay, children }: { overall: StarComment; delay: number; children?: React.ReactNode }) {
  return (
    <section className="glass reveal rounded-3xl p-5" style={revealDelay(delay)}>
      <div className="flex items-center justify-between">
        <h2 className="font-serif text-base font-bold">今日の総合運</h2>
        <StarRating value={overall.stars} size="sm" label="総合運" />
      </div>
      <p className="mt-2.5 text-[14.5px] leading-relaxed text-ink">{overall.comment}</p>
      {children}
    </section>
  );
}

export function CategoryCards({ love, work, money, health, delay }: { love: StarComment; work: StarComment; money: StarComment; health: StarComment; delay: number }) {
  const items = [
    { key: "love", label: "恋愛運", icon: "♡", data: love },
    { key: "work", label: "仕事運", icon: "✦", data: work },
    { key: "money", label: "金運", icon: "◎", data: money },
    { key: "health", label: "健康運", icon: "❀", data: health },
  ];
  return (
    <>
      {items.map((c, i) => (
        <section key={c.key} className="glass reveal rounded-3xl p-5" style={revealDelay(delay + i)}>
          <div className="flex items-center justify-between">
            <h2 className="font-serif text-base font-bold">
              <span className="mr-2 text-gold-300" aria-hidden>
                {c.icon}
              </span>
              {c.label}
            </h2>
            <StarRating value={c.data.stars} size="sm" label={c.label} />
          </div>
          <p className="mt-2.5 text-[14px] leading-relaxed text-ink-muted">{c.data.comment}</p>
        </section>
      ))}
    </>
  );
}

export function LuckyCell({ label, children, wide = false }: { label: string; children: React.ReactNode; wide?: boolean }) {
  return (
    <div className={`bg-night-800/60 px-3 py-4 text-center ${wide ? "col-span-2" : ""}`}>
      <p className="text-[10px] tracking-widest text-ink-faint">{label}</p>
      <div className="mt-1.5 text-[14px] font-bold text-ink">{children}</div>
    </div>
  );
}

export function LuckyColor({ color }: { color: { name: string; hex: string } }) {
  return (
    <span className="flex items-center justify-center gap-2">
      <span className="h-4 w-4 rounded-full border border-white/30" style={{ backgroundColor: color.hex }} aria-hidden />
      {color.name}
    </span>
  );
}

/** 運勢が控えめな日ほど充実する「整えるヒント」 */
export function CareBox({ care, rarity, cautionLabel, delay }: { care: CareSection; rarity: RarityKey; cautionLabel: string; delay: number }) {
  const items = [
    { label: cautionLabel, text: care.caution },
    { label: "おすすめの過ごし方", text: care.style },
    { label: "運気を整える行動", text: care.reset },
  ].filter((c): c is { label: string; text: string } => Boolean(c.text));
  if (!items.length) return null;
  return (
    <section className="reveal rounded-3xl border border-violet-400/25 bg-violet-500/[0.06] p-5" style={revealDelay(delay)}>
      <h2 className="font-serif text-base font-bold text-violet-300">{rarity === "NEW_MOON" ? "新月の日の整え方" : "今日のひと工夫"}</h2>
      <dl className="mt-3 space-y-3 text-[13.5px] leading-relaxed">
        {items.map((c) => (
          <div key={c.label}>
            <dt className="text-[11px] tracking-wider text-violet-300/90">{c.label}</dt>
            <dd className="mt-0.5 text-ink">{c.text}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
