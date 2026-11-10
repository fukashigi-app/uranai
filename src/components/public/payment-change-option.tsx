import Link from "next/link";

/** 決済画面を開いた後（注文が PROCESSING）に、占いの種類を変更できない理由の案内 */
export const PAYMENT_CHANGE_LOCKED_NOTICE =
  "決済画面を開いた後は、お支払いの有効期限が切れるまで占いの種類を変更できません。お支払いを完了していない場合は、有効期限が切れた後に選び直せます。";

/**
 * 支払い画面の、購入内容（占いの種類）の訂正の導線。注文の状態はサーバーで読み取った値を渡す。
 *  - 決済画面をまだ開いていない注文（CREATED）… 「占いを選び直す」リンク（/fortune で新しい注文を作り直せる）
 *  - 決済画面を開いた後の注文（PROCESSING）… リンクを出さず、変更できない理由を案内する
 *    （二重の決済を防ぐため、/api/checkout は PROCESSING の注文があると新しい注文を作らず 409 を返して支払い画面に戻す）
 */
export function PaymentChangeOption({ processing }: { processing: boolean }) {
  if (processing) {
    return (
      <p data-payment-change-locked="" className="mt-4 rounded-xl bg-white/5 px-3 py-2.5 text-[12.5px] leading-relaxed text-ink-muted">
        {PAYMENT_CHANGE_LOCKED_NOTICE}
      </p>
    );
  }
  return (
    <p className="mt-4 text-center">
      <Link href="/fortune" className="text-[12px] text-ink-muted underline underline-offset-4">
        占いを選び直す
      </Link>
    </p>
  );
}
