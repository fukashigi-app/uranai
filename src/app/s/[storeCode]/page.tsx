import type { Metadata } from "next";
import { PublicShell, Notice, RestartButton, ServicePausedNotice } from "@/components/public/public-shell";
import { Hero } from "@/components/public/hero";
import { FortuneSelector } from "@/components/public/fortune-selector";
import { findActiveStoreByCode } from "@/lib/services/checkout";
import { isPlausibleStoreCode } from "@/lib/security/crypto";
import { isFreeFortuneState, isServiceStopped, isTestStoreCode, TEST_STORE, testModeState, type VisitorStore } from "@/lib/services/test-store";

export const metadata: Metadata = { robots: { index: false } };

/**
 * QRコードの着地ページ = 店舗専用トップ（そのまま占いを選べる）。/s/test はテストモード・開発モード時のテスト店舗。
 * 開発モードの運営は、登録済み・稼働中の実店舗の QR からも無料で占える（その店舗の無料テスト利用件数に数える）
 */
export default async function StoreTopPage(props: PageProps<"/s/[storeCode]">) {
  const { storeCode } = await props.params;
  const state = await testModeState();
  if (isServiceStopped(state)) {
    return (
      <PublicShell>
        <ServicePausedNotice reason={state} />
      </PublicShell>
    );
  }
  const testMode = isFreeFortuneState(state);

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
      <h2 className="mb-2.5 flex items-center gap-3 font-serif text-[15px] tracking-widest text-ink-muted">
        <span className="hairline flex-1" />
        占いを選ぶ
        <span className="hairline flex-1" />
      </h2>
      <FortuneSelector testMode={testMode} />
    </PublicShell>
  );
}
