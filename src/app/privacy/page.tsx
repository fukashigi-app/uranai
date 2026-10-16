import Link from "next/link";
import { LegalPage } from "@/components/public/legal";
import { siteConfig } from "@/config/site";
import {
  DISCLOSE_ON_REQUEST,
  DISCLOSURE_CONDITIONS,
  DISCLOSURE_REPLY_NOTE,
  FORTUNE_USE_HOURS,
  LEGAL_UPDATED,
  operatorInfo,
  PAYMENT_PROCESSOR,
  REPLY_NOTE,
  RESULT_VIEW_HOURS,
} from "@/lib/legal/policy";

export const metadata = { title: "プライバシーポリシー" };

/**
 * 記載内容は実装と一致させること（保存期間: src/lib/firestore/misc.ts / src/lib/services/maintenance.ts の runMaintenance、
 * Cookie: src/lib/cookies.ts・src/proxy.ts・src/lib/services/test-store.ts・src/lib/auth、店舗の表示: src/app/store/(portal)/sales）。
 * 保存期間が決まっていない記録に、架空の期限を書かないこと。
 */
export default function PrivacyPage() {
  const op = operatorInfo();
  const cookies: [string, string, string][] = [
    ["qr_store", "読み込んだQRコードの店舗を識別するため", "6時間"],
    ["fx_access", `お支払いと占いの権利・結果をこのブラウザに結びつけるため（運営者のサーバーには、元に戻せない形に変換した値のみを保存します）`, "3日"],
    ["fx_test", "無料テストモードでの体験の状態を保持するため。入力した内容（生年月日などを含みます）がこのCookieに含まれ、運営者のデータベースには保存しません", "24時間（無料テストモードのときのみ）"],
    ["sid / __Host-sid", "運営者・提携店舗の管理画面のログイン状態を保持するため（占いの利用者には使用しません）", "運営者12時間・提携店舗14日"],
    ["ブラウザの保存領域（localStorage）", "占い結果の演出を表示済みかどうかの印を保存するため（結果の内容は保存しません）", "ブラウザで削除するまで"],
  ];
  return (
    <LegalPage title="プライバシーポリシー" updated={LEGAL_UPDATED}>
      <p>
        {op.tradeName}（以下「運営者」）は、「{siteConfig.name}」（以下「本サービス」）で取り扱う利用者および提携店舗の情報について、個人情報の保護に関する法律その他の法令を守り、次のとおり取り扱います。
      </p>

      <h2>1. 事業者の情報</h2>
      <ul>
        <li>
          名称：{op.tradeName}（{op.businessType}）
        </li>
        <li>事業者の氏名：{op.ownerName ?? DISCLOSE_ON_REQUEST}</li>
        <li>住所：{op.address ?? DISCLOSE_ON_REQUEST}</li>
        {op.ownerName && op.address ? null : (
          <li data-disclosure-guide>
            事業者の氏名・住所のご請求は、<a href={`mailto:${op.email}`}>{op.email}</a>
            宛てにお送りください。{DISCLOSURE_CONDITIONS}
            {DISCLOSURE_REPLY_NOTE}（ご請求の方法は<Link href="/commercial-transaction">特定商取引法に基づく表記</Link>
            もご覧ください。）
          </li>
        )}
        <li>
          お問い合わせ先：<a href={`mailto:${op.email}`}>{op.email}</a>
        </li>
      </ul>

      <h2>2. 取得する情報と利用目的</h2>
      <h3 className="mt-4 font-bold text-ink">(1) 占いの入力情報（星座・血液型・生まれた月・生年月日）</h3>
      <ul>
        <li>占い結果の作成にのみ使用します。</li>
        <li>生年月日そのものは、データベースに保存せず、ログにも記録しません。結果の作成に使った後は破棄します。</li>
        <li>保存する占い結果には、生年月日そのものではなく、星座・誕生数・生まれた月など、生年月日から導いた情報のみが含まれます。</li>
        <li>血液型占いでは、生まれた日は取得せず、生まれた月（1〜12月）のみを使用します。</li>
        <li>氏名・住所・電話番号・メールアドレスなどの入力や会員登録は必要ありません。</li>
      </ul>
      <h3 className="mt-4 font-bold text-ink">(2) 占い結果・占いの種類・利用日時</h3>
      <ul>
        <li>
          結果の再表示（占いを実行してから{RESULT_VIEW_HOURS}時間）と、不具合が起きた際の確認のために保存します。占いの権利（決済の完了から{FORTUNE_USE_HOURS}
          時間）の状態も記録します。
        </li>
        <li>占い結果の本文は、作成から30日を過ぎたものを毎日の定期処理で削除します。</li>
      </ul>
      <h3 className="mt-4 font-bold text-ink">(3) 利用した店舗の情報</h3>
      <p>読み込んだQRコードの店舗を、利用状況・売上の集計と提携店舗への報酬の精算のために記録します。</p>
      <h3 className="mt-4 font-bold text-ink">(4) 決済に関する情報</h3>
      <p>
        決済代行サービスの決済識別番号・金額・決済日時・決済の状況・返金の有無・利用店舗・占いの種類を、売上の管理、提携店舗への報酬の精算、返金などのお問い合わせへの対応、不正利用の防止のために保存します。
      </p>
      <h3 className="mt-4 font-bold text-ink">(5) お問い合わせの情報</h3>
      <p>メールでお問い合わせいただいた際のメールアドレス・お名前（ご記載があった場合）・お問い合わせの内容を、回答と返金などの対応のために使用します。</p>
      <h3 className="mt-4 font-bold text-ink">(6) アクセスに関する情報</h3>
      <ul>
        <li>不正利用や過度なアクセスを防ぐため、IPアドレスを元に戻せない形に変換（ハッシュ化）した値を、回数の制限に使用します。この値は、1日を過ぎたものを毎日の定期処理で削除します。</li>
        <li>サーバーの運用のため、ホスティング事業者（Vercel）のシステムで、アクセスの記録（IPアドレス・ブラウザの種類・日時など）が記録されることがあります。</li>
      </ul>
      <h3 className="mt-4 font-bold text-ink">(7) 提携店舗の担当者の情報</h3>
      <p>
        提携店舗の店舗名・担当者名・連絡先（住所・電話番号・メールアドレス）・ログイン情報・振込先口座を、店舗アカウントの管理、提携店舗へのご連絡、報酬の精算、不正防止のための操作履歴の記録に使用します。振込先口座は暗号化して保管し、パスワードは元に戻せない形に変換して保管します。
      </p>

      <h2>3. Cookie・ブラウザへの保存</h2>
      <p>本サービスでは、次のCookieなどを使用します。広告や行動分析を目的としたCookieは使用していません。Cookieを無効にすると、お支払い後の占いや結果の表示ができません。</p>
      <div className="mt-3 space-y-2">
        {cookies.map(([name, purpose, period]) => (
          <div key={name} className="rounded-2xl border border-white/10 px-4 py-3">
            <p className="!mt-0 font-mono text-[12.5px] text-ink">{name}</p>
            <p className="!mt-1">{purpose}</p>
            <p className="!mt-1 text-[12px] text-ink-faint">保存期間：{period}</p>
          </div>
        ))}
      </div>

      <h2>4. クレジットカード情報</h2>
      <ul>
        <li>カード情報は、決済代行サービス（{PAYMENT_PROCESSOR}）の入力フォームで直接処理され、運営者のサーバーには送信されず、保存もしません。</li>
        <li>3Dセキュア（本人認証）のために入力されたメールアドレスは、決済代行サービスとカード会社に送信され、運営者は保存しません。</li>
        <li>決済代行サービスでの情報の取扱いは、同サービスのプライバシーポリシーに従います。</li>
      </ul>

      <h2>5. 提携店舗に表示する情報</h2>
      <ul>
        <li>提携店舗の管理画面には、その店舗のQRコードから利用された取引ごとの日時・占いの種類・金額・店舗の取り分・状態と、その集計を表示します。</li>
        <li>占いの入力内容、占い結果の本文、利用者を特定できる情報は、提携店舗に表示・提供しません。</li>
      </ul>

      <h2>6. 第三者への提供</h2>
      <p>法令に基づく場合などを除き、ご本人の同意なく個人データを第三者に提供しません。</p>

      <h2>7. 利用する外部サービス（業務の委託）</h2>
      <p>本サービスの運営のため、次の事業者のサービスを利用し、必要な範囲で情報の取扱いを委託しています。</p>
      <ul>
        <li>Google LLC（Firebase / Cloud Firestore）：データの保存</li>
        <li>Vercel Inc.：本サービスの配信・サーバーの実行</li>
        <li>{PAYMENT_PROCESSOR}：クレジットカード決済</li>
        <li>Google LLC（Gmail）：お問い合わせへの対応</li>
      </ul>
      <p>これらの事業者には米国の事業者が含まれ、情報が日本国外のサーバーで取り扱われる場合があります。</p>

      <h2>8. 保存期間</h2>
      <ul>
        <li>占い結果の本文：作成から30日を過ぎたものを毎日の定期処理で削除します。</li>
        <li>お支払いが完了しなかったお申込みの記録：7日を過ぎたものを毎日の定期処理で削除します。</li>
        <li>決済代行サービスからの通知の処理記録：90日を過ぎたものを毎日の定期処理で削除します。</li>
        <li>アクセス回数の制限に使う値：1日を過ぎたものを毎日の定期処理で削除します。</li>
        <li>
          取引の記録（決済・占いの権利）、無料テストモードの利用記録（店舗コード・占いの種類・日時）、管理画面の操作履歴：現在は自動で削除する仕組みがなく、保存を続けています。税務・法令上の保存の要件を確認したうえで、保存期間を定める予定です。
        </li>
        <li>提携店舗の担当者の情報：店舗アカウントがある間、保存します。</li>
      </ul>

      <h2>9. 安全管理のための措置</h2>
      <ul>
        <li>通信の暗号化（HTTPS）</li>
        <li>振込先口座の暗号化、パスワードやログイン・決済の権利の元に戻せない形での保存</li>
        <li>管理画面へのアクセス制限と操作履歴の記録</li>
        <li>アクセス回数の制限</li>
        <li>生年月日をデータベースやログに残さない設計</li>
      </ul>

      <h2>10. 開示・訂正・利用停止などのご請求</h2>
      <ul>
        <li>
          ご本人から、保有個人データの利用目的の通知、開示、訂正・追加・削除、利用停止・消去、第三者への提供の停止などのご請求があった場合は、法令に従って対応します。
        </li>
        <li>
          ご請求は、下記のお問い合わせ先にメールでご連絡ください。占いのご購入はご請求の条件ではありません。ご本人の情報を取り違えないよう、ご請求の内容に応じて、確認に必要な範囲で情報をお伺いすることがあります。
        </li>
        <li>回答の目安：{REPLY_NOTE}</li>
        <li>占いの利用者については、氏名などをお預かりしていないため、ご請求の内容によっては、ご本人の情報を特定できない場合があります。</li>
      </ul>

      <h2>11. お問い合わせ先</h2>
      <p>
        {op.tradeName}
        <br />
        メールアドレス：<a href={`mailto:${op.email}`}>{op.email}</a>
        <br />
        {REPLY_NOTE}
      </p>

      <h2>12. 改定</h2>
      <p>
        本ポリシーの内容を変更する場合は、本サービス上でお知らせします。関連する<Link href="/terms">利用規約</Link>もあわせてご確認ください。
      </p>
    </LegalPage>
  );
}
