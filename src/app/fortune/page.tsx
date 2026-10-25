import Link from "next/link";
import { PublicShell, Notice, ServicePausedNotice } from "@/components/public/public-shell";
import { FortuneSelector } from "@/components/public/fortune-selector";
import { isFreeFortuneState, isServiceStopped, isTestStoreCode, resolveVisitorStore, testModeState } from "@/lib/services/test-store";
import { getQrStoreCode } from "@/lib/cookies";
import { stripeTestAccess } from "@/lib/payments/stripe-access";
import { stripeTestEntry } from "@/lib/payments/stripe-test-entry";
import { findActiveStoreByCode } from "@/lib/services/checkout";

// QR Cookie・公開状態（準備中など）で表示が変わるため毎回サーバーで描画（ビルド時の状態で固定しない）
export const dynamic = "force-dynamic";

export default async function FortuneSelectPage(props: PageProps<"/fortune">) {
  const testMode = await testModeState();
  // Stripe のテスト決済の専用の入口（/fortune?pay=stripe-test。運営アカウントだけ。それ以外の人には何も変わらない）
  const pay = (await props.searchParams).pay;
  if (pay !== undefined) {
    const qr = await getQrStoreCode();
    const entry = stripeTestEntry({ pay, stripeOk: (await stripeTestAccess()).ok, halted: testMode === "halted", realStoreCode: Boolean(qr && !isTestStoreCode(qr)) });
    if (entry !== "off") return <StripeTestSelect storeCode={entry === "stripe-test" ? qr : null} />;
  }
  if (isServiceStopped(testMode)) {
    return (
      <PublicShell>
        <ServicePausedNotice reason={testMode} />
      </PublicShell>
    );
  }
  const store = await resolveVisitorStore();
  if (!store || store.status !== "ACTIVE") {
    return (
      <PublicShell>
        <Notice title="お店のQRコードから始めてください" action={<Link href="/" className="btn-ghost inline-block rounded-xl px-5 py-2.5 text-sm">トップへ戻る</Link>}>
          この占いは、提携店舗のテーブルやレジ横にあるQRコードからご利用いただけます。
          <span className="mt-2 block text-[12px]">QRコードから開いてもこの画面になる場合は、ブラウザのCookieを有効にしてください。</span>
        </Notice>
      </PublicShell>
    );
  }
  return (
    <PublicShell storeName={store.name} step={1}>
      <h1 className="mb-1 font-serif text-2xl font-bold tracking-wide">占いを選ぶ</h1>
      <p className="mb-5 text-[13px] text-ink-muted">気になる占いをタップしてください。どれも1回100円です。</p>
      <FortuneSelector testMode={isFreeFortuneState(testMode)} />
    </PublicShell>
  );
}


/** Stripe のテスト決済で占いを選ぶ画面（運営アカウントだけ。有料の注文は実店舗だけ作れる） */
async function StripeTestSelect({ storeCode }: { storeCode: string | null }) {
  const store = storeCode ? await findActiveStoreByCode(storeCode) : null;
  if (!store || store.status !== "ACTIVE") {
    return (
      <PublicShell>
        <Notice title="実店舗のQRコードから開いてください" action={<Link href="/fortune" className="btn-ghost inline-block rounded-xl px-5 py-2.5 text-sm">占いの選択へ戻る</Link>}>
          Stripe のテスト決済は、管理画面で登録した稼働中の店舗の QR コード（/s/店舗コード）を開いてから、この画面（/fortune?pay=stripe-test）を開くと使えます。テスト店舗（/s/test）では使えません。
        </Notice>
      </PublicShell>
    );
  }
  return (
    <PublicShell storeName={store.name} step={1}>
      <h1 className="mb-1 font-serif text-2xl font-bold tracking-wide">占いを選ぶ</h1>
      <p className="mb-3 text-[13px] text-ink-muted">気になる占いをタップしてください。どれも1回100円です。</p>
      <p className="mb-5 rounded-xl border border-sky-400/30 bg-sky-500/10 px-3 py-2.5 text-[12px] leading-relaxed text-sky-200">
        Stripe Sandbox のテスト決済の画面です（運営アカウントのみ）。実際の請求は発生せず、売上・店舗の精算にも含まれません。
      </p>
      <FortuneSelector stripeTest />
    </PublicShell>
  );
}
