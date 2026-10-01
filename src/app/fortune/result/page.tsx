import Link from "next/link";
import { redirect } from "next/navigation";
import { PublicShell, Notice } from "@/components/public/public-shell";
import { ResultView } from "@/components/public/result-view";
import { ShareButton } from "@/components/public/share-button";
import { getAccessToken } from "@/lib/cookies";
import { getFortuneSession } from "@/lib/services/fortune";
import { FORTUNE_CATALOG } from "@/lib/fortune/catalog";
import { siteConfig } from "@/config/site";
import { env } from "@/lib/env";

export const metadata = { title: "占い結果", robots: { index: false } };

export default async function FortuneResultPage() {
  const session = await getFortuneSession(await getAccessToken());
  if (session.state === "paid") redirect("/fortune/input");
  if (session.state !== "used" || !session.result) {
    return (
      <PublicShell>
        <Notice
          title="結果を表示できません"
          action={
            <Link href="/fortune" className="btn-gold inline-block rounded-2xl px-6 py-3 font-bold">
              占いを選ぶ
            </Link>
          }
        >
          {session.state === "used"
            ? "結果の表示期間（24時間）が終了しました。"
            : "占い結果はお支払いをしたブラウザでのみ表示できます。"}
        </Notice>
      </PublicShell>
    );
  }
  const r = session.result;
  const shareText = `${FORTUNE_CATALOG[session.fortuneType].label}で今日の総合運は${"★".repeat(r.overall.stars)}${"☆".repeat(5 - r.overall.stars)}でした！ラッキーアイテムは「${r.luckyItem}」 #${siteConfig.name}`;
  return (
    <PublicShell storeName={session.storeName} step={4}>
      <h1 className="sr-only">占い結果</h1>
      <ResultView result={r} />
      <div className="mt-6 space-y-3 fade-up" style={{ animationDelay: "1.8s" }}>
        <ShareButton text={shareText} url={env().APP_URL} />
        <Link href="/fortune" className="btn-gold flex h-14 items-center justify-center rounded-2xl text-base font-bold">
          別の占いもしてみる（100円）
        </Link>
        <p className="text-center text-[11px] leading-relaxed text-ink-faint">この結果は24時間、このブラウザで再表示できます。</p>
      </div>
    </PublicShell>
  );
}
