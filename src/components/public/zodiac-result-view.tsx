import type { ZodiacResultV2 } from "@/lib/fortune/types";
import { StarRating } from "@/components/ui/stars";
import { RarityCard } from "./rarity-card";

const delay = (i: number) => ({ animationDelay: `${300 + i * 180}ms` });
/** 星座記号を絵文字ではなく文字として表示する */
const sym = (s: string) => `${s}︎`;

export function ZodiacResultView({ result: r }: { result: ZodiacResultV2 }) {
  const categories = [
    { key: "love", label: "恋愛運", icon: "♡", data: r.love },
    { key: "work", label: "仕事運", icon: "✦", data: r.work },
    { key: "money", label: "金運", icon: "◎", data: r.money },
    { key: "health", label: "健康運", icon: "❀", data: r.health },
  ];
  const careItems = [
    { label: "今日気をつけたいこと", text: r.care.caution },
    { label: "おすすめの過ごし方", text: r.care.style },
    { label: "運気を整える行動", text: r.care.reset },
  ].filter((c): c is { label: string; text: string } => Boolean(c.text));

  return (
    <div className="space-y-3.5">
      <RarityCard
        rarity={r.rarity}
        overall={r.overall.stars}
        typeLabel="12星座占い"
        dateLabel={r.dateLabel}
        rank={r.rank}
        subject={
          <>
            <span className="mr-1.5 text-gold-300">{sym(r.sign.symbol)}</span>
            {r.sign.name}のあなた
          </>
        }
      />

      <section className="glass reveal rounded-3xl p-5" style={delay(0)}>
        <h2 className="font-serif text-base font-bold">今日の12星座ランキング</h2>
        <p className="mt-1 text-[13px] text-gold-200">{r.rankHeadline}</p>
        <ol className="mt-3 grid grid-cols-2 gap-1.5 text-[13px]">
          {r.ranking.map((s, i) => {
            const mine = s.key === r.sign.key;
            return (
              <li
                key={s.key}
                className={`flex items-center gap-2 rounded-xl px-2.5 py-1.5 ${mine ? "bg-gold-300/20 font-bold text-gold-50 ring-1 ring-gold-300/50" : "bg-white/[0.03] text-ink-muted"}`}
                aria-current={mine ? "true" : undefined}
              >
                <span className={`w-5 text-right font-display text-base ${i < 3 ? "text-gold-200" : ""}`}>{i + 1}</span>
                <span aria-hidden>{sym(s.symbol)}</span>
                <span>{s.name}</span>
              </li>
            );
          })}
        </ol>
        <p className="mt-3 text-[13px] leading-relaxed text-ink-muted">{r.signNote}</p>
      </section>

      <section className="glass reveal rounded-3xl p-5" style={delay(1)}>
        <div className="flex items-center justify-between">
          <h2 className="font-serif text-base font-bold">今日の総合運</h2>
          <StarRating value={r.overall.stars} size="sm" label="総合運" />
        </div>
        <p className="mt-2.5 text-[14.5px] leading-relaxed text-ink">{r.overall.comment}</p>
        <p className="mt-2 text-[13.5px] leading-relaxed text-gold-200">{r.point}</p>
      </section>

      {categories.map((c, i) => (
        <section key={c.key} className="glass reveal rounded-3xl p-5" style={delay(i + 2)}>
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

      <section className="reveal rounded-3xl border border-gold-300/25 bg-gold-300/[0.06] px-6 py-6 text-center" style={delay(6)}>
        <p className="text-[11px] tracking-[0.3em] text-gold-300">今日の星からのメッセージ</p>
        <p className="mt-3 font-serif text-[16px] leading-loose text-gold-50">「{r.starMessage}」</p>
      </section>

      <section className="glass reveal space-y-4 rounded-3xl p-5" style={delay(7)}>
        <SignRow label="今日相性のいい星座" symbol={r.goodSign.symbol} name={r.goodSign.name} reason={r.goodSign.reason} tone="good" />
        <div className="hairline" />
        <SignRow label="注意したい星座" symbol={r.cautionSign.symbol} name={r.cautionSign.name} reason={r.cautionSign.reason} tone="caution" />
      </section>

      <section className="glass reveal grid grid-cols-2 gap-px overflow-hidden rounded-3xl bg-white/5 p-0" style={delay(8)}>
        <Lucky label="ラッキーカラー">
          <span className="flex items-center justify-center gap-2">
            <span className="h-4 w-4 rounded-full border border-white/30" style={{ backgroundColor: r.luckyColor.hex }} aria-hidden />
            {r.luckyColor.name}
          </span>
        </Lucky>
        <Lucky label="ラッキータイム">{r.luckyTime}</Lucky>
        <Lucky label="ラッキーアイテム" wide>
          {r.luckyItem}
        </Lucky>
      </section>

      <section className="glass reveal rounded-3xl p-5 text-[13.5px] leading-relaxed" style={delay(9)}>
        <p className="text-ink">
          <span className="mr-2 rounded-full bg-gold-300/15 px-2 py-0.5 text-[11px] text-gold-200">今日の開運アクション</span>
          {r.action}
        </p>
      </section>

      {careItems.length ? (
        <section className="reveal rounded-3xl border border-violet-400/25 bg-violet-500/[0.06] p-5" style={delay(10)}>
          <h2 className="font-serif text-base font-bold text-violet-300">{r.rarity.key === "NEW_MOON" ? "新月の日の整え方" : "今日のひと工夫"}</h2>
          <dl className="mt-3 space-y-3 text-[13.5px] leading-relaxed">
            {careItems.map((c) => (
              <div key={c.label}>
                <dt className="text-[11px] tracking-wider text-violet-300/90">{c.label}</dt>
                <dd className="mt-0.5 text-ink">{c.text}</dd>
              </div>
            ))}
          </dl>
        </section>
      ) : null}
    </div>
  );
}

function SignRow({ label, symbol, name, reason, tone }: { label: string; symbol: string; name: string; reason: string; tone: "good" | "caution" }) {
  return (
    <div>
      <p className={`text-[11px] tracking-wider ${tone === "good" ? "text-gold-300" : "text-violet-300"}`}>{label}</p>
      <p className="mt-1 font-serif text-[16px] font-bold text-ink">
        <span className="mr-1.5" aria-hidden>
          {sym(symbol)}
        </span>
        {name}
      </p>
      <p className="mt-1 text-[13px] leading-relaxed text-ink-muted">{reason}</p>
    </div>
  );
}

function Lucky({ label, children, wide = false }: { label: string; children: React.ReactNode; wide?: boolean }) {
  return (
    <div className={`bg-night-800/60 px-3 py-4 text-center ${wide ? "col-span-2" : ""}`}>
      <p className="text-[10px] tracking-widest text-ink-faint">{label}</p>
      <div className="mt-1.5 text-[14px] font-bold text-ink">{children}</div>
    </div>
  );
}
