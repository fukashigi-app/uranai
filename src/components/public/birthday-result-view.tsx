import type { BirthdayResultV2 } from "@/lib/fortune/types";
import { RarityCard } from "./rarity-card";
import { CareBox, CategoryCards, LuckyCell, LuckyColor, OverallCard, revealDelay } from "./result-parts";

const sym = (s: string) => `${s}︎`;

/** 生年月日占い v2（星座・誕生数・今日の個人日数を組み合わせた本格占い） */
export function BirthdayResultView({ result: r }: { result: BirthdayResultV2 }) {
  return (
    <div className="space-y-3.5">
      <RarityCard
        rarity={r.rarity}
        overall={r.overall.stars}
        typeLabel="生年月日占い"
        dateLabel={r.dateLabel}
        subject={
          <>
            <span className="mr-1.5 text-gold-300">{sym(r.sign.symbol)}</span>
            {r.sign.name} × 誕生数{r.lifePath}
          </>
        }
      />
      {r.blessing ? (
        <p className="reveal rounded-3xl border border-gold-300/40 bg-gradient-to-br from-gold-300/15 to-violet-500/10 px-5 py-4 text-center font-serif text-[14.5px] leading-relaxed text-gold-50" style={revealDelay(0)}>
          {r.blessing}
        </p>
      ) : null}

      {/* あなたを表す3つのサイン */}
      <section className="reveal relative overflow-hidden rounded-[2rem] border border-violet-400/30 bg-gradient-to-b from-[#1d1840]/90 to-night-800/90 p-5" style={revealDelay(1)}>
        <div className="pointer-events-none absolute -right-10 -top-10 h-40 w-40 rounded-full bg-violet-500/15 blur-3xl" aria-hidden />
        <p className="relative text-center text-[11px] tracking-[0.3em] text-violet-300">あなたを表す3つのサイン</p>
        <ul className="relative mt-4 grid grid-cols-3 gap-2 text-center">
          <Medallion label="星座" ring="border-gold-300/60" big={<span className="text-[26px] text-gold-200">{sym(r.sign.symbol)}</span>} sub={r.sign.name} />
          <Medallion
            label="誕生数"
            ring="border-violet-300/60"
            big={<span className="font-display text-[30px] text-violet-300">{r.lifePath}</span>}
            sub={r.isMaster ? `${r.lifePathTitle}・マスター` : r.lifePathTitle}
          />
          <Medallion
            label="今日のナンバー"
            ring="border-dashed border-gold-200/70"
            big={<span className="font-display text-[30px] text-gold-50">{r.personalDay}</span>}
            sub={`テーマ「${r.theme.keyword}」`}
          />
        </ul>
        <div className="hairline relative my-5" />
        <p className="relative text-center text-[11px] tracking-[0.3em] text-ink-muted">あなたの基本タイプ</p>
        <p className="relative mt-2 text-center font-serif text-[22px] font-bold text-gold-gradient">{r.typeName}</p>
        <p className="relative mt-3 text-[13.5px] leading-relaxed text-ink">{r.typeDescription}</p>
      </section>

      <section className="glass reveal space-y-4 rounded-3xl p-5" style={revealDelay(2)}>
        <div>
          <p className="text-[11px] tracking-wider text-gold-300">あなたの強み</p>
          <p className="mt-1 text-[13.5px] leading-relaxed text-ink">{r.strengths}</p>
        </div>
        <div className="hairline" />
        <div>
          <p className="text-[11px] tracking-wider text-violet-300">気をつけたいところ</p>
          <p className="mt-1 text-[13.5px] leading-relaxed text-ink">{r.weakPoints}</p>
        </div>
      </section>

      <section className="reveal rounded-3xl border border-gold-300/30 bg-gold-300/[0.06] p-5" style={revealDelay(3)}>
        <div className="flex items-baseline gap-2">
          <p className="text-[11px] tracking-[0.25em] text-gold-300">今日のテーマ</p>
          <p className="font-serif text-[15px] font-bold text-gold-50">
            今日のナンバー <span className="font-display text-xl">{r.personalDay}</span>「{r.theme.keyword}」
          </p>
        </div>
        <p className="mt-2 text-[14px] leading-relaxed text-ink">{r.theme.text}</p>
      </section>

      <OverallCard overall={r.overall} delay={4} />
      <CategoryCards love={r.love} work={r.work} money={r.money} health={r.health} delay={5} />

      <section className="glass reveal space-y-4 rounded-3xl p-5" style={revealDelay(9)}>
        <Row label="今日起こりやすいこと" tone="violet" text={r.events} />
        <div className="hairline" />
        <Row label="今日おすすめの行動" tone="gold" text={r.action} />
        <div className="hairline" />
        <Row label="今日気をつけたいこと" tone="violet" text={r.caution} />
      </section>

      <section className="glass reveal grid grid-cols-2 gap-px overflow-hidden rounded-3xl bg-white/5 p-0" style={revealDelay(10)}>
        <LuckyCell label="ラッキーカラー">
          <LuckyColor color={r.luckyColor} />
        </LuckyCell>
        <LuckyCell label="ラッキーアイテム">{r.luckyItem}</LuckyCell>
        <LuckyCell label="ラッキーナンバー（今日のお守りの数字）" wide>
          <span className="font-display text-3xl text-gold-200">{r.luckyNumber}</span>
          <span className="mt-1 block text-[11px] font-normal text-ink-faint">{r.luckyNumberNote}</span>
        </LuckyCell>
      </section>

      <section className="reveal rounded-3xl border border-gold-300/25 bg-gold-300/[0.06] px-6 py-6 text-center" style={revealDelay(11)}>
        <p className="text-[11px] tracking-[0.3em] text-gold-300">あなたへの一言</p>
        <p className="mt-3 font-serif text-[16px] leading-loose text-gold-50">「{r.message}」</p>
      </section>

      <CareBox care={r.care} rarity={r.rarity.key} cautionLabel="今日注意すれば避けられること" delay={12} />
    </div>
  );
}

function Medallion({ label, ring, big, sub }: { label: string; ring: string; big: React.ReactNode; sub: string }) {
  return (
    <li className="flex flex-col items-center">
      <p className="text-[10px] tracking-wider text-ink-faint">{label}</p>
      <div className={`mt-1.5 flex h-16 w-16 items-center justify-center rounded-full border-2 bg-night-900/50 shadow-[0_0_24px_-6px_rgba(223,196,136,0.45)] ${ring}`}>{big}</div>
      <p className="mt-1.5 text-[11.5px] leading-snug text-ink">{sub}</p>
    </li>
  );
}

function Row({ label, tone, text }: { label: string; tone: "gold" | "violet"; text: string }) {
  return (
    <div>
      <p className={`text-[11px] tracking-wider ${tone === "gold" ? "text-gold-300" : "text-violet-300"}`}>{label}</p>
      <p className="mt-1 text-[14px] leading-relaxed text-ink">{text}</p>
    </div>
  );
}
