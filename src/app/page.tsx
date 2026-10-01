import Link from "next/link";
import { PublicShell } from "@/components/public/public-shell";
import { Hero } from "@/components/public/hero";
import { FortuneIcon } from "@/components/public/fortune-icons";
import { FortuneSelector } from "@/components/public/fortune-selector";
import { FORTUNE_CATALOG } from "@/lib/fortune/catalog";
import { resolveVisitorStore } from "@/lib/services/test-store";
import { isTestPaymentEnabled } from "@/lib/env";

// QR Cookie・テストモードで表示が変わるため毎回サーバーで描画
export const dynamic = "force-dynamic";

export default async function HomePage() {
  // QRで来た店舗、またはテストモード時はテスト店舗。どちらもなければ案内のみ
  const store = await resolveVisitorStore().catch((e) => {
    console.error("[home] store resolve failed", (e as Error).message);
    return null;
  });

  if (store) {
    return (
      <PublicShell storeName={store.name}>
        <Hero storeName={store.name} />
        <h2 className="mb-3 flex items-center gap-3 font-serif text-base tracking-widest text-ink-muted">
          <span className="hairline flex-1" />
          占いを選ぶ
          <span className="hairline flex-1" />
        </h2>
        <FortuneSelector testMode={isTestPaymentEnabled()} />
      </PublicShell>
    );
  }

  return (
    <PublicShell>
      <Hero />
      <div className="space-y-3">
        {(["BIRTHDAY", "ZODIAC", "BLOOD"] as const).map((t, i) => (
          <Link
            key={t}
            href="/fortune"
            className="glass fade-up flex items-center gap-4 rounded-3xl p-4 transition-colors hover:border-white/25 active:scale-[0.99]"
            style={{ animationDelay: `${i * 90}ms` }}
          >
            <FortuneIcon type={t} className="h-10 w-10 shrink-0" />
            <div>
              <p className="font-serif font-bold">{FORTUNE_CATALOG[t].label}</p>
              <p className="text-[12px] text-ink-muted">{FORTUNE_CATALOG[t].description}</p>
            </div>
          </Link>
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
