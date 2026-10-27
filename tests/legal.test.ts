import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OPERATOR_DEFAULTS, readOperatorInfo } from "@/config/operator";
import CommercialTransactionPage from "@/app/commercial-transaction/page";
import TermsPage from "@/app/terms/page";
import PrivacyPage from "@/app/privacy/page";
import { PurchaseSummary } from "@/components/public/purchase-summary";
import { PAY_BUTTON_LABEL, TEST_PAY_BUTTON_LABEL } from "@/lib/legal/labels";

const OPERATOR_KEYS = [
  "OPERATOR_TRADE_NAME",
  "OPERATOR_EMAIL",
  "OPERATOR_OWNER_NAME",
  "OPERATOR_ADDRESS",
  "OPERATOR_PHONE",
  "NEXT_PUBLIC_OPERATOR_NAME",
  "NEXT_PUBLIC_OPERATOR_REPRESENTATIVE",
  "NEXT_PUBLIC_OPERATOR_ADDRESS",
  "NEXT_PUBLIC_OPERATOR_PHONE",
  "NEXT_PUBLIC_OPERATOR_EMAIL",
];

/** タグを除いた本文 */
const text = (el: React.ReactElement) =>
  renderToStaticMarkup(el)
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'");

const page = (Page: () => React.ReactElement) => text(createElement(Page));

/** 未確定事項を確定した事実や架空の値として表示していないこと（全ページ共通） */
// 本番の Stripe アカウントで利用できるか未確認の支払い方法を、利用できると断定しない
const FORBIDDEN = ["PayPay", "Apple Pay", "Google Pay", "example.com", "【", "】", "[要", "要設定", "要確認", "設定してください", "PAY.JP", "pay.jp", "7年", "一切の責任", "専属的合意管轄", "法令に基づき省略", "適法"];

beforeEach(() => {
  for (const k of OPERATOR_KEYS) vi.stubEnv(k, "");
});
afterEach(() => vi.unstubAllEnvs());

describe("運営者情報の設定", () => {
  it("未設定なら確定済みの屋号・問い合わせ先を使い、氏名・住所・電話は架空の値で埋めない", () => {
    const { info, issues } = readOperatorInfo(process.env);
    expect(info.tradeName).toBe("Hobby shop FUKASHIGI");
    expect(info.email).toBe("koyomi100yen@gmail.com");
    expect([info.ownerName, info.address, info.phone]).toEqual([null, null, null]);
    expect(issues.filter((i) => i.level === "error")).toEqual([]);
    // 請求時開示の表示は「法令上の条件は未確認」として通知される
    const disclosure = issues.find((i) => i.key === "disclosure");
    expect(disclosure?.level).toBe("notice");
    expect(disclosure?.message).toContain("未確認");
  });

  it("仮の値（example.com・【…】）や不正な形式は表示に使わず、エラーとして報告する（値そのものは出さない）", () => {
    const { info, issues } = readOperatorInfo({
      NEXT_PUBLIC_OPERATOR_EMAIL: "support@example.com",
      NEXT_PUBLIC_OPERATOR_NAME: "【運営事業者名を設定してください】",
      OPERATOR_ADDRESS: "【所在地（請求があれば遅滞なく開示）】",
      OPERATOR_PHONE: "電話番号",
    });
    expect(info.email).toBe(OPERATOR_DEFAULTS.email);
    expect(info.tradeName).toBe(OPERATOR_DEFAULTS.tradeName);
    expect(info.address).toBeNull();
    expect(info.phone).toBeNull();
    const errors = issues.filter((i) => i.level === "error").map((i) => i.key);
    expect(errors.sort()).toEqual(["NEXT_PUBLIC_OPERATOR_EMAIL", "NEXT_PUBLIC_OPERATOR_NAME", "OPERATOR_ADDRESS", "OPERATOR_PHONE"].sort());
    expect(JSON.stringify(issues)).not.toContain("support@example.com");
  });

  it("以前の NEXT_PUBLIC_OPERATOR_* の値は使うが、移行を促す通知を出す", () => {
    const { info, issues } = readOperatorInfo({ NEXT_PUBLIC_OPERATOR_ADDRESS: "東京都千代田区1-1-1" });
    expect(info.address).toBe("東京都千代田区1-1-1");
    expect(issues.some((i) => i.level === "notice" && i.key === "NEXT_PUBLIC_OPERATOR_ADDRESS")).toBe(true);
  });

  it("氏名・住所・電話番号がすべて設定されれば、その値を表示し請求時開示の通知は出ない", () => {
    vi.stubEnv("OPERATOR_OWNER_NAME", "山田 太郎");
    vi.stubEnv("OPERATOR_ADDRESS", "東京都千代田区1-1-1");
    vi.stubEnv("OPERATOR_PHONE", "03-0000-0000");
    expect(readOperatorInfo(process.env).issues).toEqual([]);
    const t = page(CommercialTransactionPage);
    expect(t).toContain("山田 太郎");
    expect(t).toContain("東京都千代田区1-1-1");
    expect(t).toContain("03-0000-0000");
    expect(t).not.toContain("開示のご請求方法");
    expect(t).not.toContain("ご請求があれば");
  });
});

describe("特定商取引法に基づく表記", () => {
  it("確定した運営方針と実装の値を表示する", () => {
    const t = page(CommercialTransactionPage);
    for (const s of [
      "Hobby shop FUKASHIGI（個人事業主）",
      "koyomi100yen@gmail.com",
      "100円占い",
      "占い1回 100円（税込）",
      "クレジットカードなど、決済画面に表示されるお支払い方法（決済代行：Stripe）",
      `「${PAY_BUTTON_LABEL}」ボタンを押すと、Stripeの決済画面に移動します。決済画面でお支払いの手続きを完了した時点で決済されます。`,
      "カード会社など、お支払い方法の提供会社からのご請求",
      "30分以内にお支払いください",
      "決済の完了から24時間以内に占いを実行",
      "占いを実行してから24時間、お支払いをした同じブラウザでのみ再表示",
      "重複して決済された場合",
      "占い結果が提供されなかった場合",
      "重大な誤り",
      "決済日から30日以内を目安",
      "法令上お客様に認められる返金・解除などの権利を制限するものではありません",
      "原則として3営業日以内",
      "遅滞なく対応すべき場合は、それに従います",
      "ご請求があれば、遅滞なく開示いたします。",
      "開示のご請求方法",
      "販売事業者は上記の運営者",
    ]) {
      expect(t, s).toContain(s);
    }
    for (const s of FORBIDDEN) expect(t, s).not.toContain(s);
  });
});

describe("事業者情報の開示請求", () => {
  const html = (Page: () => React.ReactElement) => renderToStaticMarkup(createElement(Page));
  const DISCLOSURE_MUST = [
    "ご購入の前後を問わず、どなたでもご請求いただけます",
    "ご購入や本人確認書類の提出は必要ありません",
    "原則として受付当日中、遅くとも翌営業日中",
    "目標としています",
    "法令により遅滞なく対応すべき場合は、それに従います",
  ];
  // 購入・本人確認を一律の条件にする表現、法令上の条件を満たしていると断定する表現は使わない
  const DISCLOSURE_FORBIDDEN = ["購入者に限り", "ご購入者のみ", "本人確認が必要", "本人確認書類をご提出", "ご本人であることを確認したうえで", "法令上認められて", "省略が認められ", "省略しています"];

  it("特商法表記：開示請求先・条件・回答の目標を表示する", () => {
    const h = html(CommercialTransactionPage);
    const t = page(CommercialTransactionPage);
    expect(h).toMatch(/<a href="mailto:koyomi100yen@gmail.com" data-disclosure-email="">koyomi100yen@gmail.com<\/a>/);
    expect(t).toContain("事業者の氏名・所在地・電話番号は、koyomi100yen@gmail.com宛てに");
    expect(t).toContain("「特定商取引法に基づく表記の開示請求」と記載");
    for (const s of DISCLOSURE_MUST) expect(t, s).toContain(s);
    for (const s of DISCLOSURE_FORBIDDEN) expect(t, s).not.toContain(s);
    // 一般の問い合わせは3営業日の目安
    expect(t).toContain("一般のお問い合わせ：原則として3営業日以内");
  });

  it("プライバシーポリシー：事業者情報の開示請求の案内が特商法表記と一致し、個人情報の開示請求も購入・本人確認を一律の条件にしない", () => {
    const h = html(PrivacyPage);
    const t = page(PrivacyPage);
    expect(h).toContain('data-disclosure-guide');
    expect(h).toContain('href="mailto:koyomi100yen@gmail.com"');
    expect(h).toContain('href="/commercial-transaction"');
    for (const s of DISCLOSURE_MUST) expect(t, s).toContain(s);
    expect(t).toContain("占いのご購入はご請求の条件ではありません");
    expect(t).toContain("確認に必要な範囲で情報をお伺いすることがあります");
    expect(t).toContain("回答の目安：原則として3営業日以内");
    for (const s of DISCLOSURE_FORBIDDEN) expect(t, s).not.toContain(s);
  });

  it("問い合わせ先に仮の値が設定されていても、開示請求先は確定済みのメールアドレスを表示する", () => {
    vi.stubEnv("OPERATOR_EMAIL", "support@example.com");
    for (const Page of [CommercialTransactionPage, PrivacyPage, TermsPage]) {
      const h = html(Page);
      expect(h).toContain("koyomi100yen@gmail.com");
      expect(h).not.toContain("example.com");
    }
  });

  it("氏名・住所・電話番号をすべて掲載した場合は、開示請求の案内を出さない", () => {
    vi.stubEnv("OPERATOR_OWNER_NAME", "山田 太郎");
    vi.stubEnv("OPERATOR_ADDRESS", "東京都千代田区1-1-1");
    vi.stubEnv("OPERATOR_PHONE", "03-0000-0000");
    expect(html(CommercialTransactionPage)).not.toContain("data-disclosure-email");
    expect(html(PrivacyPage)).not.toContain("data-disclosure-guide");
  });
});

describe("利用規約", () => {
  it("娯楽目的・販売者・料金と期限・返金・未成年・責任・規約変更・問い合わせ先を含み、全面免責や合意管轄・賠償上限を定めない", () => {
    const t = page(TermsPage);
    for (const s of [
      "娯楽を目的",
      "提携店舗はQRコードの設置場所を提供しているものであり、本サービスの販売者ではありません",
      "利用者と運営者との間で成立",
      "占い1回につき100円（税込）",
      "決済代行サービス（Stripe）を通じたクレジットカードなど、決済画面に表示されるお支払い方法によります",
      "Stripeの決済画面に移動します。決済画面でお支払いの手続きを完了した時点で決済されます",
      "決済の完了から24時間以内に占いを実行",
      "同じブラウザでのみ再表示",
      "重複して決済された場合",
      "決済日から30日以内を目安",
      "法定代理人の同意",
      "法令に従ってその損害を賠償",
      "効力が生じる日を定め、その日より前に",
      "法令の定めに従い管轄を有する裁判所",
      "koyomi100yen@gmail.com",
      "原則として3営業日以内",
    ]) {
      expect(t, s).toContain(s);
    }
    for (const s of [...FORBIDDEN, "上限", "責任を負いません。通信環境"]) expect(t, s).not.toContain(s);
  });
});

describe("プライバシーポリシー", () => {
  it("実際の保存内容・表示内容に合わせて記載し、未決定の保存期間に架空の期限を書かない", () => {
    const t = page(PrivacyPage);
    for (const s of [
      "生年月日そのものは、データベースに保存せず",
      "作成から30日を過ぎたものを毎日の定期処理で削除",
      "取引ごとの日時・占いの種類・金額・店舗の取り分・状態",
      "占いの入力内容、占い結果の本文、利用者を特定できる情報は、提携店舗に表示・提供しません",
      "qr_store",
      "fx_access",
      "fx_test",
      "入力した内容（生年月日などを含みます）がこのCookieに含まれ",
      "localStorage",
      "Firebase",
      "Vercel",
      "Gmail",
      "Stripe：クレジットカードなど、決済画面に表示されるお支払い方法の決済",
      "決済画面で入力されたカード情報はStripeが直接処理し、運営者のサーバーには送信されず",
      "本サービスのデータベースにこれらを保存しません",
      "異議申し立て（チャージバック）の状況",
      "売上の管理、提携店舗への報酬の精算",
      "振込先口座は暗号化して保管",
      "現在は自動で削除する仕組みがなく、保存を続けています",
      "保存期間を定める予定",
      "開示、訂正・追加・削除、利用停止・消去",
      "koyomi100yen@gmail.com",
    ]) {
      expect(t, s).toContain(s);
    }
    for (const s of [...FORBIDDEN, "集計値のみ"]) expect(t, s).not.toContain(s);
  });
});

describe("購入画面の確認事項", () => {
  const expiresAt = new Date("2026-10-16T03:30:00Z"); // JST 12:30
  it("購入内容・価格・支払方法と時期・提供時期・期限・キャンセルと返金・未成年・3文書へのリンクを表示する", () => {
    const html = renderToStaticMarkup(createElement(PurchaseSummary, { fortuneLabel: "星座占い", inputLabel: "星座", expiresAt, mode: "stripe" }));
    const t = text(createElement(PurchaseSummary, { fortuneLabel: "星座占い", inputLabel: "星座", expiresAt, mode: "stripe" }));
    for (const s of [
      "星座占い（1回分）",
      "100円（税込）",
      "クレジットカードなど、決済画面に表示されるお支払い方法（決済代行：Stripe）",
      "カード情報はStripeが処理し、当サービスには送信・保存されません",
      `「${PAY_BUTTON_LABEL}」ボタンを押すと、Stripeの決済画面に移動します。決済画面でお支払いの手続きを完了した時点で決済されます`,
      "決済画面でお支払いの手続きを完了する前であれば、画面を閉じるだけで料金はかかりません",
      "決済の完了後すぐに",
      "24時間以内",
      "このブラウザでのみ再表示",
      "30分以内（12:30まで）",
      "閉じるだけで料金はかかりません",
      "重複して決済された場合",
      "法令上の権利を制限するものではありません",
      "保護者など法定代理人の同意",
    ]) {
      expect(t, s).toContain(s);
    }
    for (const href of ["/commercial-transaction", "/terms", "/privacy"]) expect(html).toContain(`href="${href}"`);
    for (const s of FORBIDDEN) expect(t, s).not.toContain(s);
  });

  it("テスト用の決済では、請求が発生しないことと実際のボタン名を表示する", () => {
    const t = text(createElement(PurchaseSummary, { fortuneLabel: "血液型占い", inputLabel: "血液型", expiresAt, mode: "mock" }));
    expect(t).toContain("テスト用の疑似決済（実際の請求は発生しません）");
    expect(t).toContain(`「${TEST_PAY_BUTTON_LABEL}」ボタンを押した時点で決済されます（テスト用）`);
    expect(t).not.toContain("PAY.JP");
    const st = text(createElement(PurchaseSummary, { fortuneLabel: "血液型占い", inputLabel: "血液型", expiresAt, mode: "stripe_test", payButtonLabel: "同意して100円を支払う（テスト）" }));
    expect(st).toContain("Stripeのテスト決済（実際の請求は発生しません）");
    expect(st).toContain("「同意して100円を支払う（テスト）」ボタンを押すと、Stripeの決済画面に移動します");
  });
});
