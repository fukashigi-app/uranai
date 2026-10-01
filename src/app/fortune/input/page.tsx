import { redirect } from "next/navigation";
import { PublicShell, Notice, RestartButton } from "@/components/public/public-shell";
import { getTestSession } from "@/lib/services/test-store";
import { FortuneInputForm } from "@/components/public/fortune-input-form";
import { getAccessToken } from "@/lib/cookies";
import { getFortuneSession } from "@/lib/services/fortune";
import { FORTUNE_CATALOG } from "@/lib/fortune/catalog";

export default async function FortuneInputPage() {
  // テストモード（決済スキップ）で開始した占い
  const test = await getTestSession();
  if (test) {
    if (test.status === "done") redirect("/fortune/result");
    const item = FORTUNE_CATALOG[test.type];
    return (
      <PublicShell storeName={test.storeName} step={3}>
        <div className="mb-5 flex items-center gap-2 rounded-2xl border border-violet-400/30 bg-violet-500/10 px-4 py-2.5 text-[13px] text-violet-300 fade-up">
          <span aria-hidden>✓</span> テストモードのため決済をスキップしました
        </div>
        <h1 className="mb-1 font-serif text-2xl font-bold tracking-wide">{item.label}</h1>
        <p className="mb-5 text-[13px] text-ink-muted">{item.inputLabel}を選んで「占ってみる」を押してください。</p>
        <FortuneInputForm type={test.type} />
      </PublicShell>
    );
  }

  const session = await getFortuneSession(await getAccessToken());
  if (session.state === "used") redirect("/fortune/result");
  if (session.state === "none") {
    return (
      <PublicShell>
        <Notice title="占いの情報が見つかりません" action={<RestartButton />}>
          トップページから占いを選んでください。お支払い済みの場合は、お支払いをしたブラウザで開いてください。
        </Notice>
      </PublicShell>
    );
  }
  if (session.state === "expired") {
    return (
      <PublicShell>
        <Notice title="有効期限が切れています" action={<RestartButton />}>
          お支払いから24時間が経過したため、この占いはご利用いただけません。
        </Notice>
      </PublicShell>
    );
  }
  const item = FORTUNE_CATALOG[session.fortuneType];
  return (
    <PublicShell storeName={session.storeName} step={3}>
      <div className="mb-5 flex items-center gap-2 rounded-2xl border border-success/25 bg-success/10 px-4 py-2.5 text-[13px] text-success fade-up">
        <span aria-hidden>✓</span> お支払いが完了しました
      </div>
      <h1 className="mb-1 font-serif text-2xl font-bold tracking-wide">{item.label}</h1>
      <p className="mb-5 text-[13px] text-ink-muted">{item.inputLabel}を選んで「占ってみる」を押してください。</p>
      <FortuneInputForm type={session.fortuneType} />
    </PublicShell>
  );
}
