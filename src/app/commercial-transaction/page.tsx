import Link from "next/link";
import { LegalPage } from "@/components/public/legal";
import { siteConfig } from "@/config/site";
import { PAY_BUTTON_LABEL } from "@/lib/legal/labels";
import {
  CHECKOUT_MINUTES,
  DISCLOSE_ON_REQUEST,
  DISCLOSURE_CONDITIONS,
  DISCLOSURE_REPLY_NOTE,
  FORTUNE_USE_HOURS,
  LEGAL_UPDATED,
  operatorInfo,
  PAYMENT_METHODS_LABEL,
  PAYMENT_PROCESSOR,
  paymentTimingText,
  PRICE_LABEL,
  REFUND_CASES,
  REFUND_REQUEST_NOTE,
  REPLY_NOTE,
  RESULT_VIEW_HOURS,
} from "@/lib/legal/policy";

export const metadata = { title: "特定商取引法に基づく表記" };

function mailTo(email: string, marker: "data-operator-email" | "data-disclosure-email") {
  return (
    <a href={`mailto:${email}`} {...{ [marker]: "" }}>
      {email}
    </a>
  );
}

export default function CommercialTransactionPage() {
  const op = operatorInfo();
  const mail = mailTo(op.email, "data-operator-email");
  const rows: [string, React.ReactNode][] = [
    [
      "販売事業者",
      `${op.tradeName}（${op.businessType}）`,
    ],
    ["事業者の氏名（運営統括責任者）", op.ownerName ?? DISCLOSE_ON_REQUEST],
    ["所在地", op.address ?? DISCLOSE_ON_REQUEST],
    [
      "電話番号",
      <>
        {op.phone ?? DISCLOSE_ON_REQUEST}
        <span className="mt-1 block">お問い合わせは、下記のメールアドレスにお願いいたします。</span>
      </>,
    ],
    ...(op.ownerName && op.address && op.phone
      ? []
      : ([
          [
            "開示のご請求方法",
            <>
              <p className="!mt-0">
                事業者の氏名・所在地・電話番号は、{mailTo(op.email, "data-disclosure-email")}
                宛てに、件名または本文に「特定商取引法に基づく表記の開示請求」と記載してご請求ください。
              </p>
              <p>{DISCLOSURE_CONDITIONS}</p>
              <p>{DISCLOSURE_REPLY_NOTE}</p>
            </>,
          ],
        ] as [string, React.ReactNode][])),
    [
      "メールアドレス",
      <>
        {mail}
        <span className="mt-1 block">一般のお問い合わせ：{REPLY_NOTE}</span>
      </>,
    ],
    ["サービス名", siteConfig.name],
    ["販売価格", `占い1回 ${PRICE_LABEL}`],
    ["商品代金以外の必要料金", "インターネット接続にかかる通信料は、お客様のご負担となります。"],
    ["支払方法", `${PAYMENT_METHODS_LABEL}（決済代行：${PAYMENT_PROCESSOR}）`],
    ["支払時期", `${paymentTimingText(PAY_BUTTON_LABEL)}カード会社など、お支払い方法の提供会社からのご請求・お引き落としの時期は、各社の規約に従います。`],
    ["提供時期・提供方法", "決済の完了後、ただちにウェブ画面に入力画面を表示し、入力後すぐに占い結果を表示します。"],
    ["お申込みの有効期限", `お支払い画面を開いてから${CHECKOUT_MINUTES}分以内にお支払いください。期限を過ぎた場合、決済は行われません。`],
    ["占いのご利用期限", `決済の完了から${FORTUNE_USE_HOURS}時間以内に占いを実行してください。期限を過ぎると、その回の占いはご利用いただけません。`],
    [
      "結果の再表示",
      `占い結果は、占いを実行してから${RESULT_VIEW_HOURS}時間、お支払いをした同じブラウザでのみ再表示できます（Cookieを使用します）。期間を過ぎると表示できません。`,
    ],
    ["購入回数", "1回のお支払いにつき、占いは1回です。"],
    [
      "返品・キャンセル・返金",
      <>
        <p className="!mt-0">デジタルコンテンツの性質上、占い結果が正常に提供された後の返品・キャンセル・返金はお受けしていません。ただし、次の場合は返金いたします。</p>
        <ol className="mt-1">
          {REFUND_CASES.map((c) => (
            <li key={c}>{c}</li>
          ))}
        </ol>
        <p>決済日時・金額・ご利用の店舗名を記載のうえ、上記のメールアドレスにご連絡ください。確認のうえ、決済の取消または返金を行います。返金がカードのご利用明細に反映される時期は、カード会社によって異なります。</p>
        <p>{REFUND_REQUEST_NOTE}</p>
        <p>カード番号やセキュリティコードをメールに記載しないでください。</p>
      </>,
    ],
    ["動作環境", "iOS Safari／Android Chrome の最新版を推奨します。Cookieを有効にしてご利用ください。"],
    [
      "特記事項",
      <>
        本サービスは娯楽を目的とした占いです。提携店舗はQRコードの設置場所を提供しているものであり、本サービスの販売事業者は上記の運営者です。詳しくは<Link href="/terms">利用規約</Link>をご確認ください。
      </>,
    ],
  ];
  return (
    <LegalPage title="特定商取引法に基づく表記" updated={LEGAL_UPDATED}>
      <dl className="mt-5 divide-y divide-white/10">
        {rows.map(([k, v]) => (
          <div key={k} className="grid gap-1 py-3 sm:grid-cols-[200px_1fr]">
            <dt className="font-bold text-ink">{k}</dt>
            <dd>{v}</dd>
          </div>
        ))}
      </dl>
    </LegalPage>
  );
}
