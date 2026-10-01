import type { Metadata } from "next";
import { PublicShell, Notice } from "@/components/public/public-shell";
import { Hero } from "@/components/public/hero";
import { FortuneSelector } from "@/components/public/fortune-selector";
import { findActiveStoreByCode } from "@/lib/services/checkout";
import { isPlausibleStoreCode } from "@/lib/security/crypto";
import { isTestPaymentEnabled } from "@/lib/env";
import { isTestStoreCode } from "@/lib/services/test-store";

export const metadata: Metadata = { robots: { index: false } };

/** QRコードの着地ページ = 店舗専用トップ（そのまま占いを選べる） */
export default async function StoreTopPage(props: PageProps<"/s/[storeCode]">) {
  const { storeCode } = await props.params;
  const store = isPlausibleStoreCode(storeCode) ? await findActiveStoreByCode(storeCode) : null;

  if (!store) {
    return (
      <PublicShell>
        <Notice title="QRコードを確認できませんでした">
          お手数ですが、お店に設置されているQRコードをもう一度読み込んでください。
          <br />
          解決しない場合はお店のスタッフにお声がけください。
        </Notice>
      </PublicShell>
    );
  }
  if (store.status !== "ACTIVE" || (isTestStoreCode(store.storeCode) && !isTestPaymentEnabled())) {
    return (
      <PublicShell storeName={store.name}>
        <Notice title="現在ご利用いただけません">こちらの店舗では、ただいま占いを休止しています。またのご利用をお待ちしております。</Notice>
      </PublicShell>
    );
  }
  return (
    <PublicShell storeName={store.name}>
      <Hero storeName={store.name} />
      <h2 className="mb-3 flex items-center gap-3 font-serif text-base tracking-widest text-ink-muted">
        <span className="hairline flex-1" />
        占いを選ぶ
        <span className="hairline flex-1" />
      </h2>
      <FortuneSelector />
    </PublicShell>
  );
}
