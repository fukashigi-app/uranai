import { LegalPage } from "@/components/public/legal";
import { siteConfig } from "@/config/site";

export const metadata = { title: "特定商取引法に基づく表記" };

export default function CommercialTransactionPage() {
  const op = siteConfig.operator;
  const rows: [string, React.ReactNode][] = [
    ["販売事業者", op.name],
    ["運営責任者", op.representative],
    ["所在地", op.address],
    ["電話番号", op.phone],
    ["メールアドレス", op.email],
    ["販売価格", "占い1回 100円（税込）"],
    ["商品代金以外の必要料金", "インターネット接続に必要な通信料はお客様のご負担となります"],
    ["支払方法", "クレジットカード（決済代行: PAY.JP）"],
    ["支払時期", "ご注文時に即時決済"],
    ["商品の引渡時期", "決済完了後、ただちに占いをご利用いただけます（決済後24時間以内）"],
    ["返品・キャンセル", "デジタルコンテンツの性質上、決済完了後の返品・キャンセルはお受けできません。当社の不具合により結果が提供されなかった場合は、お問い合わせください。"],
    ["動作環境", "iOS Safari / Android Chrome の最新版を推奨"],
  ];
  return (
    <LegalPage title="特定商取引法に基づく表記" updated="2026年10月1日">
      <dl className="mt-5 divide-y divide-white/10">
        {rows.map(([k, v]) => (
          <div key={k} className="grid gap-1 py-3 sm:grid-cols-[180px_1fr]">
            <dt className="font-bold text-ink">{k}</dt>
            <dd>{v}</dd>
          </div>
        ))}
      </dl>
    </LegalPage>
  );
}
