import Link from "next/link";
import { notFound } from "next/navigation";
import { PublicShell } from "@/components/public/public-shell";
import { ResultView } from "@/components/public/result-view";
import { isFortunePreviewEnabled } from "@/lib/fortune/preview";
import { RARITY_TIERS } from "@/lib/fortune/rarity";
import { RARITY_KEYS, type RarityKey } from "@/lib/fortune/types";
import { generateZodiac, zodiacDay } from "@/lib/fortune/zodiac-fortune";
import { jstDateString } from "@/lib/time";

export const metadata = { title: "占い結果プレビュー（開発用）", robots: { index: false, follow: false } };
export const dynamic = "force-dynamic";

/**
 * 開発用：各レア度の結果画面を確認する。
 * 本物の占いエンジンで「そのレア度になる日付と星座」を探して表示するだけで、
 * エンジンや API にレア度を指定する入口は作らない（本番ユーザーが好きなレア度を出すことはできない）。
 */
export default async function FortunePreviewPage({ searchParams }: { searchParams: Promise<{ rarity?: string; n?: string }> }) {
  if (!isFortunePreviewEnabled()) notFound();
  const sp = await searchParams;
  const want = (RARITY_KEYS as readonly string[]).includes(sp.rarity ?? "") ? (sp.rarity as RarityKey) : "MIRACLE";
  const nth = Math.min(20, Math.max(0, Number(sp.n) || 0));

  const found = findExample(want, nth);
  if (!found) notFound();
  const result = generateZodiac(found.key, { now: new Date(`${found.date}T20:00:00+09:00`), purchaseSeed: `preview-${nth}` });

  return (
    <PublicShell storeName="プレビュー（開発用）">
      <nav className="mb-4 flex flex-wrap gap-1.5 text-[11px]">
        {RARITY_KEYS.map((k) => (
          <Link key={k} href={`?rarity=${k}`} className={`rounded-full border px-2.5 py-1 ${k === want ? "border-gold-300 text-gold-200" : "border-white/15 text-ink-muted"}`}>
            {RARITY_TIERS[k].en}
          </Link>
        ))}
        <Link href={`?rarity=${want}&n=${nth + 1}`} className="rounded-full border border-white/15 px-2.5 py-1 text-ink-muted">
          別の例
        </Link>
      </nav>
      <ResultView result={result} />
    </PublicShell>
  );
}

/** 2026-01-01 から順に、指定のレア度になる「日付と星座」を探す（見本を毎回同じにするため基準日は固定） */
function findExample(want: RarityKey, nth: number): { date: string; key: Parameters<typeof generateZodiac>[0] } | null {
  const base = Date.UTC(2026, 0, 1, 3);
  let seen = 0;
  for (let i = 0; i < 3000; i++) {
    const date = jstDateString(new Date(base + i * 86_400_000));
    const hit = zodiacDay(date).find((d) => d.rarity === want);
    if (hit && seen++ === nth) return { date, key: hit.key };
  }
  return null;
}
