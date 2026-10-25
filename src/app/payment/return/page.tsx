import Link from "next/link";
import { redirect } from "next/navigation";
import { PublicShell, Notice } from "@/components/public/public-shell";
import { getAccessToken } from "@/lib/cookies";
import { stripeTestConfig } from "@/lib/payments/stripe-guard";
import { confirmStripeReturn } from "@/lib/payments/stripe-confirm";
import { StripeReturnStatus } from "@/components/public/stripe-return-status";

export const dynamic = "force-dynamic";
export const metadata = { title: "お支払いの確認", robots: { index: false } };

/**
 * Stripe の決済画面から戻ってきたところ（テスト決済）。
 * URL の session_id は信用せず、このブラウザの注文と紐付いた Session か確かめてから、Stripe API で照合して確定する。
 * 同時に Webhook が動いても、決済記録と占い権利は1回だけ作られる。
 * まだ確定していなければ（PayPay などの非同期の支払い）、権利は付与せず、確認中の表示で待つ。
 */
export default async function StripeReturnPage(props: PageProps<"/payment/return">) {
  const raw = (await props.searchParams).session_id;
  const sessionId = typeof raw === "string" ? raw : "";
  if (!stripeTestConfig().ok) {
    return (
      <PublicShell>
        <Notice title="ただいまお支払いを受け付けていません">お支払いの確認ができませんでした。お手数ですが、占いの選択からやり直してください。</Notice>
      </PublicShell>
    );
  }
  let status: string;
  try {
    status = (await confirmStripeReturn(await getAccessToken(), sessionId)).status;
  } catch (e) {
    console.error("[payment/return] confirm failed", (e as Error).name);
    status = "error";
  }
  if (status === "confirmed" || status === "duplicate") redirect("/fortune/input");
  if (status === "not_paid" || status === "error") {
    // Stripe 側で確定待ち（PayPay など）・一時的なエラー：状態をくり返し確認し、確定したら占いの入力へ進む
    return (
      <PublicShell step={2}>
        <StripeReturnStatus />
      </PublicShell>
    );
  }
  return (
    <PublicShell>
      <Notice title="お支払いを確認できませんでした" action={<Link href="/fortune" className="btn-gold inline-block rounded-2xl px-6 py-3 font-bold">占いを選び直す</Link>}>
        このブラウザのお支払い情報と一致しませんでした。お手数ですが、占いの選択からやり直してください。
      </Notice>
    </PublicShell>
  );
}
