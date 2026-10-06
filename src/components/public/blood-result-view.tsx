import type { BloodResultV2 } from "@/lib/fortune/types";
import { RarityCard } from "./rarity-card";
import { CareBox, CategoryCards, LuckyCell, LuckyColor, OverallCard, revealDelay } from "./result-parts";

/** 血液型占い v2（血液型×誕生月の48タイプ） */
export function BloodResultView({ result: r }: { result: BloodResultV2 }) {
  return (
    <div className="space-y-3.5">
      <RarityCard
        rarity={r.rarity}
        overall={r.overall.stars}
        typeLabel="血液型占い"
        dateLabel={r.dateLabel}
        subject={
          <>
            <span className="font-display text-xl text-gold-200">{r.bloodType}</span>型 × {r.birthMonth}月生まれ
          </>
        }
      />

      <section className="glass reveal rounded-3xl p-5 text-center" style={revealDelay(0)}>
        <p className="text-[11px] tracking-[0.3em] text-ink-muted">あなたのタイプ</p>
        <p className="mt-2 font-serif text-[22px] font-bold leading-snug text-gold-gradient">{r.typeName}</p>
        <p className="mt-1.5 font-serif text-[14px] text-gold-200">「{r.typeCatch}」</p>
        <div className="hairline my-4" />
        <p className="text-left text-[13.5px] leading-relaxed text-ink-muted">{r.typeFeature}</p>
        <p className="mt-3 rounded-2xl bg-gold-300/[0.07] px-4 py-3 text-left text-[13.5px] leading-relaxed text-gold-50">{r.typeToday}</p>
      </section>

      <OverallCard overall={r.overall} delay={1} />
      <CategoryCards love={r.love} work={r.work} money={r.money} health={r.health} delay={2} />

      <section className="glass reveal space-y-4 rounded-3xl p-5" style={revealDelay(6)}>
        <div>
          <p className="text-[11px] tracking-wider text-gold-300">今日うまくいく行動</p>
          <p className="mt-1 text-[14px] leading-relaxed text-ink">{r.goodAction}</p>
        </div>
        <div className="hairline" />
        <div>
          <p className="text-[11px] tracking-wider text-violet-300">今日気をつけたいこと</p>
          <p className="mt-1 text-[14px] leading-relaxed text-ink">{r.caution}</p>
        </div>
      </section>

      <section className="glass reveal rounded-3xl p-5" style={revealDelay(7)}>
        <p className="text-[11px] tracking-wider text-gold-300">今日相性のいい血液型</p>
        <p className="mt-1 font-serif text-[16px] font-bold text-ink">
          <span className="font-display text-2xl text-gold-200">{r.goodBlood.type}</span>型
        </p>
        <p className="mt-1 text-[13px] leading-relaxed text-ink-muted">{r.goodBlood.reason}</p>
      </section>

      <section className="glass reveal grid grid-cols-2 gap-px overflow-hidden rounded-3xl bg-white/5 p-0" style={revealDelay(8)}>
        <LuckyCell label="ラッキーカラー">
          <LuckyColor color={r.luckyColor} />
        </LuckyCell>
        <LuckyCell label="ラッキーナンバー">
          <span className="font-display text-2xl text-gold-200">{r.luckyNumber}</span>
        </LuckyCell>
        <LuckyCell label="ラッキーアイテム" wide>
          {r.luckyItem}
        </LuckyCell>
      </section>

      <section className="reveal rounded-3xl border border-gold-300/25 bg-gold-300/[0.06] px-6 py-6 text-center" style={revealDelay(9)}>
        <p className="text-[11px] tracking-[0.3em] text-gold-300">今日の一言</p>
        <p className="mt-3 font-serif text-[16px] leading-loose text-gold-50">「{r.message}」</p>
      </section>

      <CareBox care={r.care} rarity={r.rarity.key} cautionLabel="注意すれば避けられること" delay={10} />
    </div>
  );
}
