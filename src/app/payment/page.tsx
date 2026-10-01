import Link from "next/link";
import { redirect } from "next/navigation";
import { PublicShell, Notice } from "@/components/public/public-shell";
import { PaymentForm } from "@/components/public/payment-form";
import { FortuneIcon } from "@/components/public/fortune-icons";
import { getAccessToken } from "@/lib/cookies";
import { getCheckoutByToken } from "@/lib/services/checkout";
import { activeProvider } from "@/lib/payments";
import { FORTUNE_CATALOG } from "@/lib/fortune/catalog";

export default async function PaymentPage() {
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

  const { provider, publicKey } = activeProvider().publicConfig();
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
      <PaymentForm
        provider={provider}
        publicKey={publicKey}
        initialStatus={checkout.status === "PROCESSING" ? "processing" : checkout.status === "FAILED" ? "failed" : "created"}
      />
      <ul className="mt-5 space-y-1.5 text-[11px] leading-relaxed text-ink-faint">
        <li>・カード情報は決済代行会社（PAY.JP）が安全に処理し、当サービスには保存されません。</li>
        <li>・お支払い後24時間以内に占いをご利用ください。デジタルコンテンツの性質上、返品・返金はお受けできません。</li>
        <li>
          ・<Link href="/commercial-transaction" className="underline underline-offset-2">特定商取引法に基づく表記</Link>・
          <Link href="/terms" className="underline underline-offset-2">利用規約</Link>に同意のうえお支払いください。
        </li>
      </ul>
      <p className="mt-4 text-center">
        <Link href="/fortune" className="text-[12px] text-ink-muted underline underline-offset-4">
          占いを選び直す
        </Link>
      </p>
    </PublicShell>
  );
}
