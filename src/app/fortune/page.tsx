import Link from "next/link";
import { PublicShell, Notice } from "@/components/public/public-shell";
import { FortuneSelector } from "@/components/public/fortune-selector";
import { resolveVisitorStore } from "@/lib/services/test-store";

export default async function FortuneSelectPage() {
  const store = await resolveVisitorStore();
  if (!store || store.status !== "ACTIVE") {
    return (
      <PublicShell>
        <Notice title="お店のQRコードから始めてください" action={<Link href="/" className="btn-ghost inline-block rounded-xl px-5 py-2.5 text-sm">トップへ戻る</Link>}>
          この占いは、提携店舗のテーブルやレジ横にあるQRコードからご利用いただけます。
        </Notice>
      </PublicShell>
    );
  }
  return (
    <PublicShell storeName={store.name} step={1}>
      <h1 className="mb-1 font-serif text-2xl font-bold tracking-wide">占いを選ぶ</h1>
      <p className="mb-5 text-[13px] text-ink-muted">気になる占いをタップしてください。どれも1回100円です。</p>
      <FortuneSelector />
    </PublicShell>
  );
}
