import Link from "next/link";
import { Logo } from "@/components/ui/logo";

/** エラー画面の共通表示（クライアント/サーバー両方で使えるよう依存を持たない） */
export function ErrorPanel({ title, message, children }: { title: string; message: string; children?: React.ReactNode }) {
  return (
    <div className="mx-auto flex min-h-dvh w-full max-w-md flex-col px-5 pb-[max(1.5rem,env(safe-area-inset-bottom))] pt-[max(1rem,env(safe-area-inset-top))]">
      <header className="py-2">
        <Link href="/" aria-label="トップへ">
          <Logo />
        </Link>
      </header>
      <main className="glass mt-8 rounded-3xl p-7 text-center fade-up">
        <h1 className="font-serif text-xl font-bold text-gold-200">{title}</h1>
        <p className="mt-3 text-sm leading-relaxed text-ink-muted">{message}</p>
        <div className="mt-6 flex flex-col items-center gap-3">
          <Link href="/" className="btn-gold inline-flex h-12 items-center justify-center rounded-2xl px-6 text-[15px] font-bold">
            最初からやり直す
          </Link>
          {children}
        </div>
      </main>
    </div>
  );
}
