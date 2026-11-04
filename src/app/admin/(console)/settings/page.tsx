import { Card, PageHeader } from "@/components/console/shell";
import { isStripeProviderSelected, stripePublicCheckoutAccess } from "@/lib/payments/stripe-access";
import { stripeLiveConfig } from "@/lib/payments/stripe-guard";
import { PasswordForm } from "@/components/console/store-forms";
import { requireOperator } from "@/lib/auth/session";
import { env, isDevModeLiveKeyConflict, isPaidFlowBlocked, siteStatus } from "@/lib/env";
import { describeProtection, getProtectionStatus } from "@/lib/services/vercel-protection";
import { STORE_SHARE_BPS, PRICE_JPY, defaultFeeRateBps } from "@/config/pricing";
import { siteConfig } from "@/config/site";
import { changeAdminPasswordAction } from "../../actions";
import { isSandboxV2Environment, STRIPE_ACCOUNT_DIAGNOSTICS_ERROR_LABEL } from "@/lib/ops/stripe-account-diagnostics";
import { STRIPE_TEST_DENY_MESSAGE } from "@/lib/payments/stripe-guard";
import { StripeAccountDiagnosticsPanel } from "@/components/console/stripe-account-diagnostics";

export const metadata = { title: "設定" };

export default async function AdminSettingsPage() {
  const user = await requireOperator();
  const e = env();
  const status = siteStatus().status;
  const live = stripeLiveConfig();
  const liveAudience = live.ok ? live.audience : null;
  const mode = isDevModeLiveKeyConflict()
    ? "開発モードなのに本番用の決済キーが設定されているため、占いの受付を停止中（開発モードの無料占いも利用不可）"
    : isPaidFlowBlocked()
    ? "危険な設定（本番の ENABLE_TEST_PAYMENT=true・PAYMENT_PROVIDER=mock、または運営だけの本番決済テストの条件の不足）のため、占いの受付を停止中（運営・店舗アカウントも利用不可）"
    : liveAudience === "operator"
    ? "開発モードの、運営アカウントだけの Stripe 本番決済テスト（STRIPE_LIVE_OPERATOR_TEST=on）：実際に請求され、売上・精算に含まれます。一般の方の決済は受け付けていません。確認の後は返金し、公開の前にこの設定を削除してください"
    : status === "development"
    ? "開発モード（SITE_STATUS=development）：決済は誰に対しても受け付けていません。運営アカウントだけ、テスト店舗（/s/test）と稼働中の登録店舗の QR で無料の占いを確認できます（売上・取り分は0円。店舗の無料テスト利用件数に記録）"
    : status === "coming_soon"
    ? "準備中（SITE_STATUS=coming_soon）：無料テスト・決済とも受け付けていません"
    : e.TEST_PAYMENT_ENABLED
    ? "テストモード（ENABLE_TEST_PAYMENT=true・無料で占える・売上には記録しない）"
    : isStripeProviderSelected()
    ? stripePublicCheckoutAccess().ok
      ? (stripePublicCheckoutAccess() as { mode?: string }).mode === "live"
        ? "Stripe の本番決済：一般のお客さんの決済を受け付けています（売上・店舗の精算の対象）"
        : "Stripe のテスト決済（Sandbox）：一般のお客さんも利用可能。実際の請求は発生せず、売上・店舗の精算には含めない"
      : "Stripe（PAYMENT_PROVIDER=stripe）：決済を受け付けていません（設定の不足。/api/health・運営ダッシュボードの設定の問題を確認してください）"
    : e.PAYMENT_PROVIDER === "mock"
      ? "自動テスト用の疑似決済（PAYMENT_PROVIDER=mock）"
      : "未設定（決済を受け付けていません。決済は Stripe だけです）";
  const protection = status === "development" ? await getProtectionStatus() : null;
  const rows: [string, string][] = [
    ["サービス名", siteConfig.name],
    ["公開URL", e.APP_URL],
    ["価格（サーバー固定）", `${PRICE_JPY}円`],
    ["店舗の取り分（全店舗一律・固定）", `${STORE_SHARE_BPS / 100}%（運営 ${100 - STORE_SHARE_BPS / 100}%。決済手数料は運営の負担）`],
    ["決済手数料率（既定）", `${defaultFeeRateBps() / 100}%（推定値。Stripe の手数料が確定したら確定値に更新。手数料は運営の負担）`],
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
      {isSandboxV2Environment() ? (
        <Card title="Stripe アカウントの照合の診断（Sandbox v2 専用）" className="mt-4">
          <StripeAccountDiagnosticsPanel
            errorLabels={{
              ...STRIPE_ACCOUNT_DIAGNOSTICS_ERROR_LABEL,
              ...Object.fromEntries(Object.entries(STRIPE_TEST_DENY_MESSAGE).map(([k, v]) => [`config_${k}`, v])),
            }}
          />
        </Card>
      ) : null}
      <Card title="パスワード変更" className="mt-4">
        <p className="mb-2 text-[13px] text-ink-muted">{user.email}</p>
        <PasswordForm action={changeAdminPasswordAction} />
      </Card>
    </>
  );
}
