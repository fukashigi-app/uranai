import Link from "next/link";
import { Logo } from "@/components/ui/logo";

export function LegalPage({ title, updated, children }: { title: string; updated: string; children: React.ReactNode }) {
  return (
    <div className="mx-auto max-w-2xl px-5 py-8">
      <Link href="/" aria-label="トップへ">
        <Logo />
      </Link>
      <article className="glass mt-6 rounded-3xl p-6 text-[14px] leading-relaxed text-ink-muted sm:p-8 [&_h2]:mb-2 [&_h2]:mt-7 [&_h2]:font-serif [&_h2]:text-base [&_h2]:font-bold [&_h2]:text-ink [&_li]:ml-5 [&_li]:list-disc [&_p]:mt-2">
        <h1 className="font-serif text-2xl font-bold text-ink">{title}</h1>
        <p className="mt-1 text-[12px] text-ink-faint">最終更新日: {updated}</p>
        {children}
      </article>
    </div>
  );
}
