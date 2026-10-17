import Link from "next/link";
import { redirect } from "next/navigation";
import { PublicShell, Notice, ServicePausedNotice } from "@/components/public/public-shell";
import { isPaidFlowBlocked } from "@/lib/env";
import { PaymentForm } from "@/components/public/payment-form";
import { PurchaseSummary } from "@/components/public/purchase-summary";
import { FortuneIcon } from "@/components/public/fortune-icons";
import { getAccessToken } from "@/lib/cookies";
import { getCheckoutByToken } from "@/lib/services/checkout";
import { activeProvider, PaymentUnavailableError } from "@/lib/payments";
import { FORTUNE_CATALOG } from "@/lib/fortune/catalog";

export default async function PaymentPage() {
  if (isPaidFlowBlocked()) {
    return (
      <PublicShell>
        <ServicePausedNotice />
      </PublicShell>
    );
  }
  const found = await getCheckoutByToken(await getAccessToken());
  if (!found) redirect("/fortune");
  const { checkout, storeName } = found;
  if (checkout.status === "SUCCEEDED") redirect("/fortune/input");

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

  let config: ReturnType<ReturnType<typeof activeProvider>["publicConfig"]>;
  try {
    config = activeProvider().publicConfig();
  } catch (e) {
    if (!(e instanceof PaymentUnavailableError)) throw e;
    return (
      <PublicShell storeName={storeName}>
        <Notice title="ただいまお支払いを受け付けていません">お支払いは行われていません。お手数ですが、お店のスタッフにお知らせください。</Notice>
      </PublicShell>
    );
  }
  const { provider, publicKey } = config;
  const item = FORTUNE_CATALOG[checkout.fortuneType];
  return (
    <PublicShell storeName={storeName} step={2}>
      <h1 className="mb-4 font-serif text-2xl font-bold tracking-wide">お支払い</h1>
      <div className="glass mb-4 flex items-center gap-4 rounded-3xl p-4 fade-up">
        <FortuneIcon type={checkout.fortuneType} className="h-11 w-11 shrink-0" />
        <div className="flex-1">
          <p className="font-serif font-bold">{item.label}</p>
          <p className="text-[12px] text-ink-muted">{storeName}</p>
        </div>
        <p className="text-right">
          <span className="font-display text-3xl font-semibold text-gold-200">{checkout.amount}</span>
          <span className="text-sm text-gold-200">円</span>
          <span className="block text-[10px] text-ink-faint">税込</span>
        </p>
      </div>
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
      <PurchaseSummary fortuneLabel={item.label} inputLabel={item.inputLabel} expiresAt={checkout.expiresAt} testPayment={provider === "mock"} />
      <PaymentForm
        provider={provider}
        publicKey={publicKey}
        initialStatus={checkout.status === "PROCESSING" ? "processing" : checkout.status === "FAILED" ? "failed" : "created"}
      />
      <p className="mt-4 text-center">
        <Link href="/fortune" className="text-[12px] text-ink-muted underline underline-offset-4">
          占いを選び直す
        </Link>
      </p>
    </PublicShell>
  );
}
