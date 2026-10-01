import Link from "next/link";
import { redirect } from "next/navigation";
import { PublicShell, Notice } from "@/components/public/public-shell";
import { FortuneInputForm } from "@/components/public/fortune-input-form";
import { getAccessToken } from "@/lib/cookies";
import { getFortuneSession } from "@/lib/services/fortune";
import { FORTUNE_CATALOG } from "@/lib/fortune/catalog";

export default async function FortuneInputPage() {
  const session = await getFortuneSession(await getAccessToken());
  if (session.state === "used") redirect("/fortune/result");
  if (session.state === "none") {
    return (
      <PublicShell>
        <Notice title="お支払いが確認できません" action={<Link href="/fortune" className="btn-gold inline-block rounded-2xl px-6 py-3 font-bold">占いを選ぶ</Link>}>
          占いのご利用にはお支払いが必要です。お支払い済みの場合は、お支払いをしたブラウザで開いてください。
        </Notice>
      </PublicShell>
    );
  }
  if (session.state === "expired") {
    return (
      <PublicShell>
        <Notice title="有効期限が切れています">お支払いから24時間が経過したため、この占いはご利用いただけません。</Notice>
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
      <p className="mb-5 text-[13px] text-ink-muted">{item.inputLabel}を選んで「占う」を押してください。</p>
      <FortuneInputForm type={session.fortuneType} />
    </PublicShell>
  );
}
