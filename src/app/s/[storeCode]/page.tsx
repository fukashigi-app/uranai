import type { Metadata } from "next";
import { PublicShell, Notice, RestartButton } from "@/components/public/public-shell";
import { Hero } from "@/components/public/hero";
import { FortuneSelector } from "@/components/public/fortune-selector";
import { findActiveStoreByCode } from "@/lib/services/checkout";
import { isPlausibleStoreCode } from "@/lib/security/crypto";
import { isTestPaymentEnabled } from "@/lib/env";
import { isTestStoreCode, TEST_STORE, type VisitorStore } from "@/lib/services/test-store";

export const metadata: Metadata = { robots: { index: false } };

/** QRコードの着地ページ = 店舗専用トップ（そのまま占いを選べる）。/s/test はテストモード時のテスト店舗 */
export default async function StoreTopPage(props: PageProps<"/s/[storeCode]">) {
  const { storeCode } = await props.params;
  const testMode = isTestPaymentEnabled();

  let store: VisitorStore | null = null;
  if (isTestStoreCode(storeCode)) {
    // テスト店舗はテストモード時のみ（DB不要の仮想店舗）
    store = testMode ? TEST_STORE : { ...TEST_STORE, status: "SUSPENDED" };
  } else if (isPlausibleStoreCode(storeCode)) {
    store = await findActiveStoreByCode(storeCode);
  }

  if (!store) {
    return (
      <PublicShell>
        <Notice title="QRコードを確認できませんでした" action={<RestartButton />}>
          お手数ですが、お店に設置されているQRコードをもう一度読み込んでください。
          <br />
          解決しない場合はお店のスタッフにお声がけください。
        </Notice>
      </PublicShell>
    );
  }
  if (store.status !== "ACTIVE") {
    return (
      <PublicShell storeName={store.name}>
        <Notice title="現在ご利用いただけません" action={<RestartButton label="トップへ戻る" />}>
          こちらの店舗では、ただいま占いを休止しています。またのご利用をお待ちしております。
        </Notice>
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
      <FortuneSelector testMode={testMode} />
    </PublicShell>
  );
}
