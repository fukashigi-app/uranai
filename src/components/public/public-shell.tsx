import Link from "next/link";
import { Logo } from "@/components/ui/logo";
import { testModeState } from "@/lib/services/test-store";
import { describeProtection, getProtectionStatus } from "@/lib/services/vercel-protection";
import { CookieHint } from "./cookie-hint";

export async function PublicShell({
  children,
  storeName,
  step,
  fade = true,
}: {
  children: React.ReactNode;
  storeName?: string | null;
  /** 1:選ぶ 2:お支払い 3:入力 4:結果 */
  step?: 1 | 2 | 3 | 4;
  /** 本文をふわっと表示するか（結果画面はレア度演出で表示するため false） */
  fade?: boolean;
}) {
  const testMode = await testModeState();
  // 開発モードの運営にだけ、Vercel Authentication の状態を表示する（確認できなければ「未確認」。保護されているとは推測しない）
  const protection = testMode === "dev" ? await getProtectionStatus() : null;
  return (
    <div className="mx-auto flex min-h-dvh w-full max-w-md flex-col px-5 pb-[max(1.5rem,env(safe-area-inset-bottom))] pt-[max(1rem,env(safe-area-inset-top))]">
      {testMode === "on" ? (
        <p role="note" className="mb-2 rounded-xl border border-violet-400/40 bg-violet-500/15 px-3 py-1.5 text-center text-[11px] text-violet-300">
          テストモード：現在テストモードのため決済は発生しません
        </p>
      ) : null}
      {testMode === "dev" ? (
        <div role="note" data-dev-mode-banner className="mb-2 rounded-xl border border-sky-400/40 bg-sky-500/15 px-3 py-2 text-[11px] leading-relaxed text-sky-200">
          <p className="text-center font-bold">開発モード（運営アカウントのみ）</p>
          <p className="text-center">決済は発生しません。料金・売上・店舗/運営の取り分は0円です。テスト店舗（/s/test）と、稼働中の登録店舗の QR で使えます（店舗の無料テスト利用件数に記録）。</p>
          {protection ? (
            <p data-protection-state={protection.state} className={`mt-1 text-center ${protection.state === "unprotected" ? "font-bold text-danger" : "text-sky-100/80"}`}>
              Vercel Authentication：{describeProtection(protection)}
              {protection.state === "unprotected" ? "（一般の方もこのサイトを開けます）" : null}
            </p>
          ) : null}
        </div>
      ) : null}
      <CookieHint />
      <header className="flex items-center justify-between py-2">
        <Logo />
        {storeName ? (
          <span className="max-w-[45%] truncate rounded-full border border-white/10 bg-white/5 px-3 py-1 text-[11px] text-ink-muted" title={storeName}>
            {storeName}
          </span>
        ) : null}
      </header>
      {step ? <StepIndicator step={step} /> : null}
      <main className={`flex-1 ${fade ? "fade-in" : ""}`}>{children}</main>
      <footer className="mt-10 space-y-2 text-center text-[11px] text-ink-faint">
        <nav aria-label="規約・表記" className="flex flex-wrap justify-center gap-x-4 gap-y-1">
          <Link href="/terms" className="hover:text-ink-muted">利用規約</Link>
          <Link href="/privacy" className="hover:text-ink-muted">プライバシーポリシー</Link>
          <Link href="/commercial-transaction" className="hover:text-ink-muted">特定商取引法に基づく表記</Link>
        </nav>
        <p>占いの結果はエンターテインメントとしてお楽しみください。</p>
      </footer>
    </div>
  );
}

const STEPS = ["えらぶ", "お支払い", "入力", "結果"];

function StepIndicator({ step }: { step: number }) {
  return (
    <ol className="mb-5 mt-2 flex items-center gap-1.5" aria-label="進行状況">
      {STEPS.map((label, i) => {
        const n = i + 1;
        const active = n === step;
        const done = n < step;
        return (
          <li key={label} className="flex flex-1 flex-col items-center gap-1.5" aria-current={active ? "step" : undefined}>
            <span
              className={`h-1 w-full rounded-full transition-colors ${done || active ? "bg-gradient-to-r from-gold-200 to-gold-400" : "bg-white/10"}`}
            />
            <span className={`text-[10px] tracking-wider ${active ? "text-gold-200" : done ? "text-ink-muted" : "text-ink-faint"}`}>{label}</span>
          </li>
        );
      })}
    </ol>
  );
}

export function Notice({ title, children, action }: { title: string; children?: React.ReactNode; action?: React.ReactNode }) {
  return (
    <div className="glass mt-8 rounded-3xl p-7 text-center fade-up">
      <h1 className="font-serif text-xl font-bold text-gold-200">{title}</h1>
      {children ? <div className="mt-3 text-sm leading-relaxed text-ink-muted">{children}</div> : null}
      {action ? <div className="mt-6">{action}</div> : null}
    </div>
  );
}

/**
 * 占いの受付を止めているときに、一般の利用者へ表示する案内（無料・有料とも受け付けない）。
 * 開発モード（development）は、一般の方には準備中と同じ案内を表示する。
 */
export function ServicePausedNotice({ reason = "halted" }: { reason?: "halted" | "coming_soon" | "development" }) {
  return (
    <Notice title="ただいま準備中です">
      {reason === "coming_soon" || reason === "development" ? (
        <span data-service-paused={reason}>公開に向けて準備を進めています。公開まで今しばらくお待ちください。</span>
      ) : (
        <span data-service-paused="halted">現在、占いの受付を一時停止しています。お手数ですが、しばらくしてからもう一度お試しください。</span>
      )}
    </Notice>
  );
}

/** エラー・期限切れ時などに表示する「最初からやり直す」ボタン */
export function RestartButton({ label = "最初からやり直す" }: { label?: string }) {
  return (
    <Link href="/" className="btn-gold inline-flex h-12 items-center justify-center rounded-2xl px-6 text-[15px] font-bold">
      {label}
    </Link>
  );
}
