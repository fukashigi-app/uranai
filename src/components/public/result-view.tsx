import type { FortuneResultData, LegacyFortuneResult } from "@/lib/db/schema";
import { ZodiacResultView } from "./zodiac-result-view";
import { BloodResultView } from "./blood-result-view";
import { StarRating } from "@/components/ui/stars";

function delay(i: number) {
  return { animationDelay: `${300 + i * 220}ms` };
}

/** 保存された結果の形に合わせて表示を切り替える（v を持たない旧形式は従来の表示） */
export function ResultView({ result }: { result: FortuneResultData }) {
  if (result.v === 2 && result.kind === "ZODIAC") return <ZodiacResultView result={result} />;
  if (result.v === 2 && result.kind === "BLOOD") return <BloodResultView result={result} />;
  return <LegacyResultView result={result as LegacyFortuneResult} />;
}

function LegacyResultView({ result }: { result: LegacyFortuneResult }) {
  const [y, m, d] = result.dateLabel.split("-");
  const categories = [
    { key: "love", label: "恋愛運", icon: "♡", data: result.love },
    { key: "work", label: "仕事運", icon: "✦", data: result.work },
    { key: "money", label: "金運", icon: "◎", data: result.money },
    ...(result.health ? [{ key: "health", label: "健康運", icon: "❀", data: result.health }] : []),
  ];

  return (
    <div className="space-y-3.5">
      <section className="reveal relative overflow-hidden rounded-[2rem] border border-gold-300/30 bg-gradient-to-b from-night-600/80 to-night-800/80 px-6 pb-7 pt-6 text-center shadow-[0_30px_80px_-30px_rgba(207,171,102,0.45)]">
        <div className="pointer-events-none absolute inset-x-0 -top-24 mx-auto h-48 w-48 rounded-full bg-gold-300/20 blur-3xl" aria-hidden />
        <p className="relative text-[11px] tracking-[0.3em] text-ink-muted">
          {y}.{m}.{d} — TODAY&apos;S FORTUNE
        </p>
        <p className="relative mt-3 font-serif text-lg text-ink">{result.subject}</p>
        {result.highlight ? (
          <p className="relative mx-auto mt-2 inline-block rounded-full border border-violet-400/30 bg-violet-500/10 px-3 py-1 text-[11px] text-violet-300">
            {result.highlight}
          </p>
        ) : null}
        <div className="hairline relative my-5" />
        <p className="relative font-serif text-sm tracking-[0.2em] text-gold-200">今日の総合運</p>
        <div className="relative mt-2 flex justify-center">
          <StarRating value={result.overall.stars} size="lg" label="総合運" />
        </div>
        <p className="relative mt-4 text-[15px] leading-loose text-ink">{result.overall.comment}</p>
      </section>

      {categories.map((c, i) => (
        <section key={c.key} className="glass reveal rounded-3xl p-5" style={delay(i)}>
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

      <section className="glass reveal grid grid-cols-2 gap-px overflow-hidden rounded-3xl bg-white/5 p-0" style={delay(categories.length)}>
        <Lucky label="ラッキーカラー">
          <span className="flex items-center justify-center gap-2">
            <span className="h-4 w-4 rounded-full border border-white/30" style={{ backgroundColor: result.luckyColor.hex }} aria-hidden />
            {result.luckyColor.name}
          </span>
        </Lucky>
        <Lucky label="ラッキーアイテム">{result.luckyItem}</Lucky>
        <Lucky label="ラッキーナンバー">
          <span className="font-display text-2xl text-gold-200">{result.luckyNumber}</span>
        </Lucky>
        <Lucky label="ラッキータイム">{result.luckyTime}</Lucky>
      </section>

      <section className="reveal rounded-3xl border border-gold-300/25 bg-gold-300/[0.06] px-6 py-6 text-center" style={delay(categories.length + 1)}>
        <p className="text-[11px] tracking-[0.3em] text-gold-300">今日の一言</p>
        <p className="mt-3 font-serif text-[17px] leading-loose text-gold-50">「{result.message}」</p>
      </section>

      <section className="glass reveal space-y-3 rounded-3xl p-5 text-[13px] leading-relaxed text-ink-muted" style={delay(categories.length + 2)}>
        <p className="text-ink">
          <span className="mr-2 rounded-full bg-gold-300/15 px-2 py-0.5 text-[11px] text-gold-200">開運アクション</span>
          {result.advice.replace(/^開運アクション：/, "")}
        </p>
        {result.traits ? <p>{result.traits}</p> : null}
      </section>
    </div>
  );
}

function Lucky({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="bg-night-800/60 px-3 py-4 text-center">
      <p className="text-[10px] tracking-widest text-ink-faint">{label}</p>
      <div className="mt-1.5 text-[14px] font-bold text-ink">{children}</div>
    </div>
  );
}
