import Link from "next/link";
import { Logo } from "@/components/ui/logo";
import { isTestPaymentEnabled } from "@/lib/env";

export function PublicShell({
  children,
  storeName,
  step,
}: {
  children: React.ReactNode;
  storeName?: string | null;
  /** 1:選ぶ 2:お支払い 3:入力 4:結果 */
  step?: 1 | 2 | 3 | 4;
}) {
  return (
    <div className="mx-auto flex min-h-dvh w-full max-w-md flex-col px-5 pb-[max(1.5rem,env(safe-area-inset-bottom))] pt-[max(1rem,env(safe-area-inset-top))]">
      {isTestPaymentEnabled() ? (
        <p role="note" className="mb-2 rounded-xl border border-violet-400/40 bg-violet-500/15 px-3 py-1.5 text-center text-[11px] text-violet-300">
          テストモード：実際の決済は行われません（動作確認用）
        </p>
      ) : null}
      <header className="flex items-center justify-between py-2">
        <Logo />
        {storeName ? (
          <span className="max-w-[45%] truncate rounded-full border border-white/10 bg-white/5 px-3 py-1 text-[11px] text-ink-muted" title={storeName}>
            {storeName}
          </span>
        ) : null}
      </header>
      {step ? <StepIndicator step={step} /> : null}
      <main className="flex-1 fade-in">{children}</main>
      <footer className="mt-10 space-y-2 text-center text-[11px] text-ink-faint">
        <nav className="flex justify-center gap-4">
          <Link href="/terms" className="hover:text-ink-muted">利用規約</Link>
          <Link href="/privacy" className="hover:text-ink-muted">プライバシー</Link>
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
