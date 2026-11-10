import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PAYMENT_CHANGE_LOCKED_NOTICE, PaymentChangeOption } from "@/components/public/payment-change-option";

describe("支払い画面の、占いの種類の訂正の導線", () => {
  it("決済画面をまだ開いていない注文（CREATED）：「占いを選び直す」リンクを表示し、変更できない案内は出さない", () => {
    const html = renderToStaticMarkup(createElement(PaymentChangeOption, { processing: false }));
    expect(html).toContain('href="/fortune"');
    expect(html).toContain("占いを選び直す");
    expect(html).not.toContain(PAYMENT_CHANGE_LOCKED_NOTICE);
  });

  it("決済画面を開いた後の注文（PROCESSING）：リンクを出さず、変更できない理由を案内する", () => {
    const html = renderToStaticMarkup(createElement(PaymentChangeOption, { processing: true }));
    expect(html).not.toContain("占いを選び直す");
    expect(html).not.toContain('href="/fortune"');
    expect(html).toContain(
      "決済画面を開いた後は、お支払いの有効期限が切れるまで占いの種類を変更できません。お支払いを完了していない場合は、有効期限が切れた後に選び直せます。",
    );
  });
});
