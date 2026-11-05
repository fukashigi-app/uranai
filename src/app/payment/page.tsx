import Link from "next/link";
import { redirect } from "next/navigation";
import { PublicShell, Notice, ServicePausedNotice } from "@/components/public/public-shell";
import { serviceStopReason } from "@/lib/env";
import { MockPaymentForm } from "@/components/public/mock-payment-form";
import { PurchaseSummary } from "@/components/public/purchase-summary";
import { FortuneIcon } from "@/components/public/fortune-icons";
import { getAccessToken } from "@/lib/cookies";
import { getCheckoutByToken } from "@/lib/services/checkout";
import { activeProvider, PaymentUnavailableError } from "@/lib/payments";
import { FORTUNE_CATALOG } from "@/lib/fortune/catalog";
import { isStripeNewCheckoutPaused, stripeCheckoutAccess } from "@/lib/payments/stripe-access";
import { NEW_CHECKOUT_PAUSED_MESSAGE } from "@/lib/payments/stripe-public";
import { refundedNotice } from "@/lib/payments/refunded-notice";
import { StripeCheckoutButton } from "@/components/public/stripe-checkout-button";
import { PAY_BUTTON_LABEL, STRIPE_TEST_PAY_BUTTON_LABEL } from "@/lib/legal/labels";

// 決済の状態・公開状態（準備中など）で表示が変わるため毎回サーバーで描画（ビルド時の状態で固定しない）
export const dynamic = "force-dynamic";

export default async function PaymentPage(props: PageProps<"/payment">) {
  const canceled = (await props.searchParams).canceled === "1";
  // Stripe の決済：運営アカウントのテスト決済は開発モード・準備中でも使える。一般のお客さんは公開中で PAYMENT_PROVIDER=stripe のときだけ
  // （危険な設定・設定の不足ではどちらも使えない）
  const stripe = await stripeCheckoutAccess();
  const stop = serviceStopReason();
  if (stop && !stripe.ok) {
    return (
      <PublicShell>
        <ServicePausedNotice reason={stop === "dangerous_config" ? "halted" : stop} />
      </PublicShell>
    );
  }
  const found = await getCheckoutByToken(await getAccessToken());
  if (!found) redirect("/fortune");
  const { checkout, storeName } = found;
  if (checkout.status === "SUCCEEDED") redirect("/fortune/input");
  if (checkout.status === "REFUNDED") {
    // 返金済み・チャージバック：決済画面も占いも開かない（期限切れの「お支払いは行われていません」より先に判断する）
    const n = refundedNotice(checkout.refundReason);
    return (
      <PublicShell storeName={storeName}>
        <Notice title={n.title} action={<Link href="/fortune" className="btn-gold inline-block rounded-2xl px-6 py-3 font-bold">占いの選択へ</Link>}>
          {n.body}
        </Notice>
      </PublicShell>
    );
  }

  const expired = checkout.status === "EXPIRED" || (checkout.status !== "PROCESSING" && checkout.expiresAt <= new Date());
  if (expired) {
    return (
      <PublicShell storeName={storeName}>
        <Notice title="お支払いの有効期限が切れました" action={<Link href="/fortune" className="btn-gold inline-block rounded-2xl px-6 py-3 font-bold">占いを選び直す</Link>}>
          お支払いは行われていません。お手数ですが、もう一度占いを選んでください。
        </Notice>
      </PublicShell>
    );
  }

  const item = FORTUNE_CATALOG[checkout.fortuneType];
  if (checkout.provider === "stripe") {
    if (!stripe.ok && isStripeNewCheckoutPaused()) {
      // 新規の決済の受付を止めている：決済画面は開かない。支払いの確定待ち（PayPay など）の注文は、確認の画面で状態を確かめられる
      const sessionId = checkout.status === "PROCESSING" && /^cs_(test|live)_[A-Za-z0-9_]{1,200}$/.test(checkout.providerPaymentId ?? "") ? checkout.providerPaymentId! : null;
      return (
        <PublicShell storeName={storeName}>
          <Notice
            title="新しいお支払いの受付を一時停止しています"
            action={
              sessionId ? (
                <Link href={`/payment/return?session_id=${encodeURIComponent(sessionId)}`} className="btn-gold inline-block rounded-2xl px-6 py-3 font-bold">
                  お支払いの状況を確認する
                </Link>
              ) : (
                <Link href="/fortune" className="btn-gold inline-block rounded-2xl px-6 py-3 font-bold">占いの選択へ</Link>
              )
            }
          >
            {sessionId ? "お支払いの確認中の注文は、確認の画面で状況を確かめられます。" : `${NEW_CHECKOUT_PAUSED_MESSAGE}この注文のお支払いは行われていません。`}
          </Notice>
        </PublicShell>
      );
    }
    if (!stripe.ok) {
      return (
        <PublicShell storeName={storeName}>
          <Notice title="ただいまお支払いを受け付けていません">お支払いは行われていません。お手数ですが、占いの選択からやり直してください。</Notice>
        </PublicShell>
      );
    }
    return (
      <PublicShell storeName={storeName} step={2}>
        <h1 className="mb-4 font-serif text-2xl font-bold tracking-wide">お支払い</h1>
        <PaymentHeader fortuneType={checkout.fortuneType} label={item.label} storeName={storeName} amount={checkout.amount} />
        <PurchaseSummary fortuneLabel={item.label} inputLabel={item.inputLabel} expiresAt={checkout.expiresAt} mode={stripe.mode === "test" ? "stripe_test" : "stripe"} payButtonLabel={stripe.mode === "test" ? STRIPE_TEST_PAY_BUTTON_LABEL : PAY_BUTTON_LABEL} />
        <StripeCheckoutButton canceled={canceled} variant={stripe.audience === "operator_test" ? (stripe.mode === "live" ? "operator_live" : "operator_test") : stripe.mode === "test" ? "public_test" : "live"} />
        <p className="mt-4 text-center">
          <Link href="/fortune" className="text-[12px] text-ink-muted underline underline-offset-4">
            占いを選び直す
          </Link>
        </p>
      </PublicShell>
    );
  }
  if (stop) {
    return (
      <PublicShell>
        <ServicePausedNotice reason={stop === "dangerous_config" ? "halted" : stop} />
      </PublicShell>
    );
  }

  // Stripe 以外の注文は、自動テスト用の疑似決済（PAYMENT_PROVIDER=mock）だけ。
  // 過去の PAY.JP の注文（provider=payjp）などには決済の画面を出さない（PAY.JP は廃止した）
  let mockAvailable = false;
  try {
    mockAvailable = checkout.provider === "mock" && activeProvider().id === "mock";
  } catch (e) {
    if (!(e instanceof PaymentUnavailableError)) throw e;
  }
  if (!mockAvailable) {
    return (
      <PublicShell storeName={storeName}>
        <Notice title="ただいまお支払いを受け付けていません" action={<Link href="/fortune" className="btn-gold inline-block rounded-2xl px-6 py-3 font-bold">占いを選び直す</Link>}>
          お支払いは行われていません。お手数ですが、占いの選択からやり直してください。
        </Notice>
      </PublicShell>
    );
  }
  return (
    <PublicShell storeName={storeName} step={2}>
      <h1 className="mb-4 font-serif text-2xl font-bold tracking-wide">お支払い</h1>
      <PaymentHeader fortuneType={checkout.fortuneType} label={item.label} storeName={storeName} amount={checkout.amount} />
      <section className="mb-4 rounded-3xl border border-gold-300/25 bg-gold-300/[0.05] px-5 py-4 fade-up" aria-labelledby="learn-heading">
        <h2 id="learn-heading" className="text-[12px] tracking-[0.2em] text-gold-300">
          この占いでわかること
        </h2>
        <ul className="mt-2 space-y-1 text-[14px] text-ink">
          {item.learn.map((x) => (
            <li key={x} className="flex gap-2">
              <span className="text-gold-300" aria-hidden>
                ✦
              </span>
              {x}
            </li>
          ))}
        </ul>
        <p className="mt-2 text-[11.5px] text-ink-muted">お支払い後、{item.inputLabel}を入力するとすぐに結果が表示されます。</p>
      </section>
      <PurchaseSummary fortuneLabel={item.label} inputLabel={item.inputLabel} expiresAt={checkout.expiresAt} mode="mock" />
      <MockPaymentForm initialStatus={checkout.status === "PROCESSING" ? "processing" : checkout.status === "FAILED" ? "failed" : "created"} />
      <p className="mt-4 text-center">
        <Link href="/fortune" className="text-[12px] text-ink-muted underline underline-offset-4">
          占いを選び直す
        </Link>
      </p>
    </PublicShell>
  );
}

function PaymentHeader({ fortuneType, label, storeName, amount }: { fortuneType: Parameters<typeof FortuneIcon>[0]["type"]; label: string; storeName: string; amount: number }) {
  return (
    <div className="glass mb-4 flex items-center gap-4 rounded-3xl p-4 fade-up">
      <FortuneIcon type={fortuneType} className="h-11 w-11 shrink-0" />
      <div className="flex-1">
        <p className="font-serif font-bold">{label}</p>
        <p className="text-[12px] text-ink-muted">{storeName}</p>
      </div>
      <p className="text-right">
        <span className="font-display text-3xl font-semibold text-gold-200">{amount}</span>
        <span className="text-sm text-gold-200">円</span>
        <span className="block text-[10px] text-ink-faint">税込</span>
      </p>
    </div>
  );
}
