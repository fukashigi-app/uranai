import { Card, PageHeader } from "@/components/console/shell";
import { PasswordForm } from "@/components/console/store-forms";
import { requireOperator } from "@/lib/auth/session";
import { env } from "@/lib/env";
import { DEFAULT_STORE_SHARE_BPS, PRICE_JPY, defaultFeeRateBps } from "@/config/pricing";
import { siteConfig } from "@/config/site";
import { changeAdminPasswordAction } from "../../actions";

export const metadata = { title: "設定" };

export default async function AdminSettingsPage() {
  const user = await requireOperator();
  const e = env();
  const mode = e.TEST_PAYMENT_ENABLED
    ? "テストモード（ENABLE_TEST_PAYMENT=true・無料で占える・売上には記録しない）"
    : e.PAYMENT_PROVIDER === "mock"
      ? "自動テスト用の疑似決済（PAYMENT_PROVIDER=mock）"
      : !e.PAYMENT_PROVIDER
      ? "未設定（決済を受け付けていません）"
      : e.PAYJP_SECRET_KEY?.startsWith("sk_live_")
        ? "本番（ライブ）"
        : "PAY.JP テストモード";
  const rows: [string, string][] = [
    ["サービス名", siteConfig.name],
    ["公開URL", e.APP_URL],
    ["価格（サーバー固定）", `${PRICE_JPY}円`],
    ["店舗配分率（既定）", `${DEFAULT_STORE_SHARE_BPS / 100}%（運営 ${100 - DEFAULT_STORE_SHARE_BPS / 100}%）`],
    ["決済手数料率（既定）", `${defaultFeeRateBps() / 100}%（PAY.JPは決済ごとの fee_rate を優先）`],
    ["決済プロバイダ", e.PAYMENT_PROVIDER ?? "—"],
    ["決済モード", mode],
    ["Webhook URL", e.PAYMENT_PROVIDER ? `${e.APP_URL}/api/webhooks/${e.PAYMENT_PROVIDER}` : "—"],
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
