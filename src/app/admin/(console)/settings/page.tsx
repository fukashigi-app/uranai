import { Card, PageHeader } from "@/components/console/shell";
import { isStripeProviderSelected, stripePublicCheckoutAccess } from "@/lib/payments/stripe-access";
import { PasswordForm } from "@/components/console/store-forms";
import { requireOperator } from "@/lib/auth/session";
import { env, isDevModeLiveKeyConflict, isPaidFlowBlocked, siteStatus } from "@/lib/env";
import { describeProtection, getProtectionStatus } from "@/lib/services/vercel-protection";
import { DEFAULT_STORE_SHARE_BPS, PRICE_JPY, defaultFeeRateBps } from "@/config/pricing";
import { siteConfig } from "@/config/site";
import { changeAdminPasswordAction } from "../../actions";

export const metadata = { title: "設定" };

export default async function AdminSettingsPage() {
  const user = await requireOperator();
  const e = env();
  const status = siteStatus().status;
  const mode = isDevModeLiveKeyConflict()
    ? "開発モードなのに本番用の決済キーが設定されているため、占いの受付を停止中（開発モードの無料占いも利用不可）"
    : isPaidFlowBlocked()
    ? "本番で危険な設定（ENABLE_TEST_PAYMENT=true または PAYMENT_PROVIDER=mock）のため、占いの受付を停止中（運営・店舗アカウントも利用不可）"
    : status === "development"
    ? "開発モード（SITE_STATUS=development）：決済は誰に対しても受け付けていません。運営アカウントだけ、テスト店舗（/s/test）と稼働中の登録店舗の QR で無料の占いを確認できます（売上・取り分は0円。店舗の無料テスト利用件数に記録）"
    : status === "coming_soon"
    ? "準備中（SITE_STATUS=coming_soon）：無料テスト・決済とも受け付けていません"
    : e.TEST_PAYMENT_ENABLED
    ? "テストモード（ENABLE_TEST_PAYMENT=true・無料で占える・売上には記録しない）"
    : isStripeProviderSelected()
    ? stripePublicCheckoutAccess().ok
      ? "Stripe のテスト決済（Sandbox）：一般のお客さんも利用可能。実際の請求は発生せず、売上・店舗の精算には含めない"
      : "Stripe（PAYMENT_PROVIDER=stripe）：決済を受け付けていません（本番決済は未実装、または設定の不足）"
    : e.PAYMENT_PROVIDER === "mock"
      ? "自動テスト用の疑似決済（PAYMENT_PROVIDER=mock）"
      : !e.PAYMENT_PROVIDER
      ? "未設定（決済を受け付けていません）"
      : e.PAYJP_SECRET_KEY?.startsWith("sk_live_")
        ? "本番（ライブ）"
        : "PAY.JP テストモード";
  const protection = status === "development" ? await getProtectionStatus() : null;
  const rows: [string, string][] = [
    ["サービス名", siteConfig.name],
    ["公開URL", e.APP_URL],
    ["価格（サーバー固定）", `${PRICE_JPY}円`],
    ["店舗配分率（既定）", `${DEFAULT_STORE_SHARE_BPS / 100}%（運営 ${100 - DEFAULT_STORE_SHARE_BPS / 100}%）`],
    ["決済手数料率（既定）", `${defaultFeeRateBps() / 100}%（PAY.JPは決済ごとの fee_rate を優先）`],
    ["決済プロバイダ", isStripeProviderSelected() ? "stripe" : (e.PAYMENT_PROVIDER ?? "—")],
    ["決済モード", mode],
    ["Webhook URL", isStripeProviderSelected() ? `${e.APP_URL}/api/webhooks/stripe` : e.PAYMENT_PROVIDER ? `${e.APP_URL}/api/webhooks/${e.PAYMENT_PROVIDER}` : "—"],
    ["公開状態（SITE_STATUS）", status === "development" ? "開発モード（development）" : status === "coming_soon" ? "準備中（coming_soon）" : "公開中（open）"],
    ...(status === "development"
      ? ([["Vercel Authentication", `${describeProtection(protection!)} — ${protection!.detail}`]] as [string, string][])
      : []),
    ["定期メンテナンス", e.CRON_SECRET ? "設定済み（/api/cron/maintenance）" : "未設定（CRON_SECRET を設定してください）"],
  ];
  return (
    <>
      <PageHeader title="設定" description="価格・配分率・決済キーは環境変数とサーバー設定で管理しています（画面からは変更できません）。" />
      <Card title="システム設定">
        <dl className="divide-y divide-white/5 text-[13px]">
          {rows.map(([k, v]) => (
            <div key={k} className="grid gap-1 py-2.5 sm:grid-cols-[200px_1fr]">
              <dt className="text-ink-muted">{k}</dt>
              <dd className="break-all">{v}</dd>
            </div>
          ))}
        </dl>
      </Card>
      <Card title="パスワード変更" className="mt-4">
        <p className="mb-2 text-[13px] text-ink-muted">{user.email}</p>
        <PasswordForm action={changeAdminPasswordAction} />
      </Card>
    </>
  );
}
