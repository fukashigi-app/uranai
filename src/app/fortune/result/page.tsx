import Link from "next/link";
import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { PublicShell, Notice, RestartButton } from "@/components/public/public-shell";
import { getTestSession } from "@/lib/services/test-store";
import { getFortuneEngine } from "@/lib/fortune/engine";
import type { FortuneResultData, FortuneTypeValue } from "@/lib/db/schema";
import { ResultView } from "@/components/public/result-view";
import { ShareButton } from "@/components/public/share-button";
import { getAccessToken } from "@/lib/cookies";
import { getFortuneSession } from "@/lib/services/fortune";
import { FORTUNE_CATALOG } from "@/lib/fortune/catalog";
import { siteConfig } from "@/config/site";

export const metadata = { title: "占い結果", robots: { index: false } };

/** 共有用のトップURL（設定に依存せず、アクセス中のドメインから作る） */
async function siteOrigin(): Promise<string> {
  const h = await headers();
  const host = (h.get("x-forwarded-host") ?? h.get("host") ?? "localhost:3000").split(",")[0].trim();
  const proto = (h.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https")).split(",")[0].trim();
  return `${proto}://${host}`;
}

export default async function FortuneResultPage() {
  // テストモード: Cookie に保存した入力と日付から、同じ結果を再生成して表示（DB不要）
  const test = await getTestSession();
  if (test) {
    if (test.status !== "done" || !test.input || !test.date) redirect("/fortune/input");
    let result: FortuneResultData;
    try {
      result = await getFortuneEngine().generate(test.input, new Date(`${test.date}T12:00:00+09:00`));
    } catch (e) {
      console.error("[result:test] generate failed", (e as Error).message);
      return (
        <PublicShell>
          <Notice title="結果を表示できませんでした" action={<RestartButton />}>
            お手数ですが、最初からやり直してください。
          </Notice>
        </PublicShell>
      );
    }
    return <ResultScreen result={result} fortuneType={test.type} storeName={test.storeName} testMode />;
  }

  const session = await getFortuneSession(await getAccessToken());
  if (session.state === "paid") redirect("/fortune/input");
  if (session.state !== "used" || !session.result) {
    return (
      <PublicShell>
        <Notice title="結果を表示できません" action={<RestartButton />}>
          {session.state === "used"
            ? "結果の表示期間（24時間）が終了しました。"
            : "占い結果はお支払いをしたブラウザでのみ表示できます。"}
        </Notice>
      </PublicShell>
    );
  }
  return <ResultScreen result={session.result} fortuneType={session.fortuneType} storeName={session.storeName} />;
}

async function ResultScreen({
  result: r,
  fortuneType,
  storeName,
  testMode = false,
}: {
  result: FortuneResultData;
  fortuneType: FortuneTypeValue;
  storeName: string;
  testMode?: boolean;
}) {
  const shareText = `${FORTUNE_CATALOG[fortuneType].label}で今日の総合運は${"★".repeat(r.overall.stars)}${"☆".repeat(5 - r.overall.stars)}でした！ラッキーアイテムは「${r.luckyItem}」 #${siteConfig.name}`;
  return (
    <PublicShell storeName={storeName} step={4}>
      <h1 className="sr-only">占い結果</h1>
      <ResultView result={r} />
      <div className="mt-6 space-y-3 fade-up" style={{ animationDelay: "1.8s" }}>
        <ShareButton text={shareText} url={await siteOrigin()} />
        <Link href="/" className="btn-gold flex h-14 items-center justify-center rounded-2xl text-base font-bold">
          {testMode ? "別の占いも試す（無料）" : "別の占いもしてみる（100円）"}
        </Link>
        <p className="text-center text-[11px] leading-relaxed text-ink-faint">この結果は24時間、このブラウザで再表示できます。</p>
      </div>
    </PublicShell>
  );
}
