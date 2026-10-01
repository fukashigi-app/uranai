import Link from "next/link";
import { PublicShell } from "@/components/public/public-shell";
import { Hero } from "@/components/public/hero";
import { FortuneIcon } from "@/components/public/fortune-icons";
import { FORTUNE_CATALOG } from "@/lib/fortune/catalog";

export default function HomePage() {
  return (
    <PublicShell>
      <Hero />
      <div className="space-y-3">
        {(["BIRTHDAY", "ZODIAC", "BLOOD"] as const).map((t, i) => (
          <div key={t} className="glass fade-up flex items-center gap-4 rounded-3xl p-4" style={{ animationDelay: `${i * 90}ms` }}>
            <FortuneIcon type={t} className="h-10 w-10 shrink-0" />
            <div>
              <p className="font-serif font-bold">{FORTUNE_CATALOG[t].label}</p>
              <p className="text-[12px] text-ink-muted">{FORTUNE_CATALOG[t].description}</p>
            </div>
          </div>
        ))}
      </div>
      <div className="glass mt-6 rounded-3xl p-5 text-center text-[13px] leading-relaxed text-ink-muted">
        <p className="font-serif text-base text-gold-200">ご利用方法</p>
        <p className="mt-2">提携店舗のテーブルやレジ横にあるQRコードをスマートフォンで読み込んでください。会員登録は不要です。</p>
      </div>
      <p className="mt-6 text-center text-[12px] text-ink-faint">
        店舗の方は <Link href="/store/login" className="text-ink-muted underline underline-offset-4">店舗管理画面</Link> へ
      </p>
    </PublicShell>
  );
}
