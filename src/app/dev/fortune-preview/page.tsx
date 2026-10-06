import Link from "next/link";
import { notFound } from "next/navigation";
import { PublicShell } from "@/components/public/public-shell";
import { ResultView } from "@/components/public/result-view";
import type { FortuneResultData } from "@/lib/db/schema";
import { birthdaySubject, generateBirthday } from "@/lib/fortune/birthday-fortune";
import { bloodSubject, generateBlood } from "@/lib/fortune/blood-fortune";
import { standardDay } from "@/lib/fortune/day-stars";
import { isFortunePreviewEnabled } from "@/lib/fortune/preview";
import { RARITY_TIERS } from "@/lib/fortune/rarity";
import { RARITY_KEYS, type BloodTypeValue, type RarityKey } from "@/lib/fortune/types";
import { BLOOD_TYPES } from "@/lib/fortune/zodiac";
import { generateZodiac, zodiacDay } from "@/lib/fortune/zodiac-fortune";
import { jstDateString } from "@/lib/time";

export const metadata = { title: "占い結果プレビュー（開発用）", robots: { index: false, follow: false } };
export const dynamic = "force-dynamic";

const KINDS = { zodiac: "12星座占い", blood: "血液型占い", birthday: "生年月日占い" } as const;
type Kind = keyof typeof KINDS;

/**
 * 開発用：各レア度の結果画面を確認する。
 * 本物の占いエンジンで「そのレア度になる日付と入力」を探して表示するだけで、
 * エンジンや API にレア度を指定する入口は作らない（本番ユーザーが好きなレア度を出すことはできない）。
 */
export default async function FortunePreviewPage({ searchParams }: { searchParams: Promise<{ rarity?: string; n?: string; type?: string }> }) {
  if (!isFortunePreviewEnabled()) notFound();
  const sp = await searchParams;
  const want = (RARITY_KEYS as readonly string[]).includes(sp.rarity ?? "") ? (sp.rarity as RarityKey) : "MIRACLE";
  const kind: Kind = sp.type === "blood" || sp.type === "birthday" ? sp.type : "zodiac";
  const nth = Math.min(20, Math.max(0, Number(sp.n) || 0));

  const result = kind === "blood" ? bloodExample(want, nth) : kind === "birthday" ? birthdayExample(want, nth) : zodiacExample(want, nth);
  if (!result) notFound();
  const q = (o: Record<string, string | number>) => "?" + new URLSearchParams(Object.entries(o).map(([k, v]) => [k, String(v)])).toString();

  return (
    <PublicShell storeName="プレビュー（開発用）">
      <nav className="mb-2 flex flex-wrap gap-1.5 text-[11px]">
        {(Object.keys(KINDS) as Kind[]).map((k) => (
          <Link key={k} href={q({ type: k, rarity: want })} className={`rounded-full border px-2.5 py-1 ${k === kind ? "border-violet-300 text-violet-300" : "border-white/15 text-ink-muted"}`}>
            {KINDS[k]}
          </Link>
        ))}
      </nav>
      <nav className="mb-4 flex flex-wrap gap-1.5 text-[11px]">
        {RARITY_KEYS.map((k) => (
          <Link key={k} href={q({ type: kind, rarity: k })} className={`rounded-full border px-2.5 py-1 ${k === want ? "border-gold-300 text-gold-200" : "border-white/15 text-ink-muted"}`}>
            {RARITY_TIERS[k].en}
          </Link>
        ))}
        <Link href={q({ type: kind, rarity: want, n: nth + 1 })} className="rounded-full border border-white/15 px-2.5 py-1 text-ink-muted">
          別の例
        </Link>
      </nav>
      <ResultView result={result} />
    </PublicShell>
  );
}

/** 見本を毎回同じにするため、基準日（2026-01-01）から順に探す */
const BASE = Date.UTC(2026, 0, 1, 3);
const dateAt = (i: number) => jstDateString(new Date(BASE + i * 86_400_000));
const at20 = (date: string) => new Date(`${date}T20:00:00+09:00`);

function zodiacExample(want: RarityKey, nth: number): FortuneResultData | null {
  let seen = 0;
  for (let i = 0; i < 3000; i++) {
    const date = dateAt(i);
    const hit = zodiacDay(date).find((d) => d.rarity === want);
    if (hit && seen++ === nth) return generateZodiac(hit.key, { now: at20(date), purchaseSeed: `preview-${nth}` });
  }
  return null;
}

function bloodExample(want: RarityKey, nth: number): FortuneResultData | null {
  let seen = 0;
  for (let i = 0; i < 3000; i++) {
    const date = dateAt(i);
    for (const bt of BLOOD_TYPES as readonly BloodTypeValue[]) {
      for (let mo = 1; mo <= 12; mo++) {
        if (standardDay(date, bloodSubject(bt, mo)).rarity === want && seen++ === nth) {
          return generateBlood(bt, mo, { now: at20(date), purchaseSeed: `preview-${nth}` });
        }
      }
    }
  }
  return null;
}

/** 見本用の生年月日（実在の利用者とは無関係の固定リスト） */
const SAMPLE_BIRTHDATES = Array.from({ length: 120 }, (_, i) => jstDateString(new Date(Date.UTC(1960, 0, 1) + i * 211 * 86_400_000)));

function birthdayExample(want: RarityKey, nth: number): FortuneResultData | null {
  let seen = 0;
  for (let i = 0; i < 3000; i++) {
    const date = dateAt(i);
    for (const b of SAMPLE_BIRTHDATES) {
      if (standardDay(date, birthdaySubject(b)).rarity === want && seen++ === nth) {
        return generateBirthday(b, { now: at20(date), purchaseSeed: `preview-${nth}` });
      }
    }
  }
  return null;
}
