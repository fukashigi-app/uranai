import Link from "next/link";
import { Logo } from "@/components/ui/logo";

export const LEGAL_LINKS = [
  { href: "/commercial-transaction", label: "特定商取引法に基づく表記" },
  { href: "/terms", label: "利用規約" },
  { href: "/privacy", label: "プライバシーポリシー" },
] as const;

export function LegalPage({ title, updated, children }: { title: string; updated: string; children: React.ReactNode }) {
  return (
    <div className="mx-auto max-w-2xl px-4 py-8 sm:px-5">
      <Link href="/" aria-label="トップへ">
        <Logo />
      </Link>
      <article className="glass mt-6 break-words rounded-3xl p-5 text-[14px] leading-relaxed text-ink-muted sm:p-8 [&_a]:underline [&_a]:underline-offset-2 [&_h2]:mb-2 [&_h2]:mt-7 [&_h2]:font-serif [&_h2]:text-base [&_h2]:font-bold [&_h2]:text-ink [&_li]:ml-5 [&_li]:list-disc [&_ol>li]:list-decimal [&_p]:mt-2">
        <h1 className="font-serif text-2xl font-bold text-ink">{title}</h1>
        <p className="mt-1 text-[12px] text-ink-faint">最終更新日: {updated}</p>
        {children}
      </article>
      <nav aria-label="規約・表記" className="mt-6 flex flex-wrap justify-center gap-x-4 gap-y-2 text-[12px] text-ink-faint">
        {LEGAL_LINKS.map((l) => (
          <Link key={l.href} href={l.href} className="underline-offset-4 hover:text-ink-muted hover:underline">
            {l.label}
          </Link>
        ))}
        <Link href="/" className="underline-offset-4 hover:text-ink-muted hover:underline">
          トップへ
        </Link>
      </nav>
    </div>
  );
}
