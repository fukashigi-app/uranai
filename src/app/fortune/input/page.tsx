import { redirect } from "next/navigation";
import { PublicShell, Notice, RestartButton } from "@/components/public/public-shell";
import { getTestSession } from "@/lib/services/test-store";
import { FortuneInputForm } from "@/components/public/fortune-input-form";
import { getAccessToken } from "@/lib/cookies";
import { getFortuneSession } from "@/lib/services/fortune";
import { FORTUNE_CATALOG } from "@/lib/fortune/catalog";
import { entitlementNoticeFor, EXISTING_ENTITLEMENT_BODY, EXISTING_ENTITLEMENT_PARAM, EXISTING_ENTITLEMENT_TITLE, isExistingEntitlementHint } from "@/lib/fortune/entitlement-notice";
import { formatDateTimeJa } from "@/lib/time";

// 権利の状態・時刻で案内が変わるため毎回サーバーで描画する
export const dynamic = "force-dynamic";

export default async function FortuneInputPage(props: PageProps<"/fortune/input">) {
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
  // 「お支払いが完了しました」は、この権利の決済の確定の直後だけ（サーバーの記録で判定）。以前の支払いの権利を使うときは、新しい支払いが無いことを案内する
  const notice = entitlementNoticeFor({
    paidAt: session.paidAt,
    restored: session.restored,
    reuseHint: isExistingEntitlementHint((await props.searchParams)[EXISTING_ENTITLEMENT_PARAM]),
    now: new Date(),
  });
  return (
    <PublicShell storeName={session.storeName} step={3}>
      {notice === "payment_completed" ? (
        <div data-entitlement-notice="payment_completed" className="mb-5 flex items-center gap-2 rounded-2xl border border-success/25 bg-success/10 px-4 py-2.5 text-[13px] text-success fade-up">
          <span aria-hidden>✓</span> お支払いが完了しました
        </div>
      ) : (
        <div data-entitlement-notice="existing_entitlement" role="status" className="mb-5 rounded-2xl border border-sky-400/30 bg-sky-500/10 px-4 py-3 text-[13px] leading-relaxed text-sky-200 fade-up">
          <p className="font-bold">{EXISTING_ENTITLEMENT_TITLE}</p>
          <p className="mt-1">{EXISTING_ENTITLEMENT_BODY}</p>
          <p className="mt-1 text-[12px] text-sky-200/80">
            この権利で占えるのは「{item.label}」です（有効期限：{formatDateTimeJa(session.expiresAt)}）。
          </p>
        </div>
      )}
      <h1 className="mb-1 font-serif text-2xl font-bold tracking-wide">{item.label}</h1>
      <p className="mb-5 text-[13px] text-ink-muted">{item.inputLabel}を選んで「占ってみる」を押してください。</p>
      <FortuneInputForm type={session.fortuneType} />
    </PublicShell>
  );
}
