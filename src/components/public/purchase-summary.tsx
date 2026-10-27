import Link from "next/link";
import { PAY_BUTTON_LABEL, TEST_PAY_BUTTON_LABEL } from "@/lib/legal/labels";
import {
  CHECKOUT_MINUTES,
  FORTUNE_USE_HOURS,
  PAYMENT_METHODS_LABEL,
  PAYMENT_PROCESSOR,
  paymentTimingText,
  PRICE_LABEL,
  REFUND_CASES,
  REFUND_REQUEST_DAYS,
  RESULT_VIEW_HOURS,
} from "@/lib/legal/policy";

/**
 * 購入確定前の確認事項（特定商取引法 12条の6 の最終確認画面で表示すべき事項を想定）。
 * 分量・価格・支払の時期と方法・提供の時期・期限・申込みの撤回（キャンセル）と返金 を、購入ボタンの前に表示する。
 *  mode … stripe（Stripe Checkout の決済）・stripe_test（Stripe のテスト決済。実際の請求なし）・mock（自動テスト用の疑似決済）
 */
export function PurchaseSummary({
  fortuneLabel,
  inputLabel,
  expiresAt,
  mode,
  payButtonLabel,
}: {
  fortuneLabel: string;
  inputLabel: string;
  expiresAt: Date;
  mode: "stripe" | "stripe_test" | "mock";
  /** 購入ボタンの文言（省略時は mode に合わせた文言） */
  payButtonLabel?: string;
}) {
  const label = payButtonLabel ?? (mode === "mock" ? TEST_PAY_BUTTON_LABEL : PAY_BUTTON_LABEL);
  const viaStripe = mode !== "mock";
  const deadline = expiresAt.toLocaleTimeString("ja-JP", { timeZone: "Asia/Tokyo", hour: "2-digit", minute: "2-digit" });
  const rows: [string, React.ReactNode][] = [
    ["ご購入内容", `${fortuneLabel}（1回分）`],
    [
      "販売価格",
      <>
        <span className="font-bold text-ink">{PRICE_LABEL}</span>
        <span className="block text-[12px] text-ink-faint">このほかの料金はかかりません（通信料はお客様のご負担です）。</span>
      </>,
    ],
    [
      "お支払い方法",
      mode === "mock" ? (
        "テスト用の疑似決済（実際の請求は発生しません）"
      ) : mode === "stripe_test" ? (
        `${PAYMENT_PROCESSOR}のテスト決済（実際の請求は発生しません）`
      ) : (
        <>
          {`${PAYMENT_METHODS_LABEL}（決済代行：${PAYMENT_PROCESSOR}）`}
          <span className="block text-[12px] text-ink-faint">{`お支払いは${PAYMENT_PROCESSOR}の決済画面で行います。カード情報は${PAYMENT_PROCESSOR}が処理し、当サービスには送信・保存されません。`}</span>
        </>
      ),
    ],
    ["お支払い時期", viaStripe ? paymentTimingText(label).replace("お支払い画面の", "下の") : `下の「${label}」ボタンを押した時点で決済されます（テスト用）。`],
    ["提供方法・時期", `決済の完了後すぐに、この画面から${inputLabel}を入力すると、占い結果が表示されます。`],
    [
      "ご利用期限",
      <>
        決済の完了から<strong className="text-ink">{FORTUNE_USE_HOURS}時間以内</strong>に占ってください。結果は占ってから{RESULT_VIEW_HOURS}
        時間、このブラウザでのみ再表示できます。
      </>,
    ],
    [
      "お申込み期限",
      <>
        この画面を開いてから{CHECKOUT_MINUTES}分以内（{deadline}まで）。期限を過ぎると決済は行われません。
      </>,
    ],
    [
      "キャンセル・返金",
      <>
        {viaStripe ? "決済画面でお支払いの手続きを完了する前であれば、画面を閉じるだけで料金はかかりません。" : "ボタンを押す前であれば、この画面を閉じるだけで料金はかかりません。"}
        占い結果をお届けした後の返金は、原則お受けしていません。
        <span className="mt-1 block">ただし、次の場合は返金します（決済日から{REFUND_REQUEST_DAYS}日以内を目安にご連絡ください。法令上の権利を制限するものではありません）。</span>
        <ul className="mt-1 space-y-0.5 text-[12px]">
          {REFUND_CASES.map((c) => (
            <li key={c} className="flex gap-1.5">
              <span aria-hidden>・</span>
              {c}
            </li>
          ))}
        </ul>
      </>,
    ],
  ];

  return (
    <section className="mb-4 rounded-3xl border border-white/10 bg-white/[0.03] px-4 py-4 fade-up sm:px-5" aria-labelledby="confirm-heading" data-purchase-summary>
      <h2 id="confirm-heading" className="font-serif text-[15px] font-bold text-ink">
        お申込み内容の確認
      </h2>
      <dl className="mt-2 divide-y divide-white/10 text-[13px] leading-relaxed text-ink-muted">
        {rows.map(([k, v]) => (
          <div key={k} className="py-2.5">
            <dt className="text-[11.5px] tracking-wider text-gold-300">{k}</dt>
            <dd className="mt-0.5">{v}</dd>
          </div>
        ))}
      </dl>
      <p className="mt-3 rounded-2xl border border-gold-300/30 bg-gold-300/[0.06] px-3 py-2.5 text-[12.5px] leading-relaxed text-gold-50" data-minor-notice>
        未成年の方は、保護者など法定代理人の同意を得てからお支払いください。
      </p>
      <p className="mt-3 text-[12.5px] leading-relaxed text-ink-muted">
        <Link href="/commercial-transaction" className="underline underline-offset-2">
          特定商取引法に基づく表記
        </Link>
        ・
        <Link href="/terms" className="underline underline-offset-2">
          利用規約
        </Link>
        ・
        <Link href="/privacy" className="underline underline-offset-2">
          プライバシーポリシー
        </Link>
        をご確認のうえ、内容に同意される場合は下のボタンからお支払いください。
      </p>
    </section>
  );
}
