"use client";

import { useState } from "react";

type Result = {
  environment: "sandbox_v2";
  secretKeySet: boolean;
  secretKeyIsTest: boolean;
  accountIdSet: boolean;
  webhookSecretSet: boolean;
  accountIdHasSurroundingWhitespace: boolean;
  apiAuth: "success" | "failure" | "not_run";
  accountMatch: "match" | "mismatch" | "not_run";
  mismatchHint: { returnedLast4: string; configuredLast4: string; differsOnlyByCase: boolean } | null;
  error: string | null;
  checkedAt: string;
};

const yesNo = (v: boolean) => (v ? "あり" : "なし");

/**
 * Sandbox v2 専用：Stripe のアカウントの照合の診断（ボタンを押したときだけ、サーバーが Stripe に GET /v1/account を1回送る）。
 * 表示するのは真偽値・分類・日時と、不一致のときのアカウントの ID の末尾4文字だけ（キー・Webhook の秘密は表示しない）。
 */
export function StripeAccountDiagnosticsPanel({ errorLabels }: { errorLabels: Record<string, string> }) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Result | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  async function run() {
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch("/api/admin/stripe-account-diagnostics", { method: "POST", cache: "no-store", credentials: "same-origin" });
      if (res.status === 429) {
        setMessage("診断の回数の上限に達しました。1分ほど待ってから再度お試しください。");
        return;
      }
      if (res.status === 404) {
        setMessage("この環境では診断できません（実行環境：その他。Sandbox v2 の Preview でだけ使えます）。");
        return;
      }
      if (!res.ok) {
        setMessage("診断を実行できませんでした。少し待ってから再度お試しください。");
        return;
      }
      setResult((await res.json()) as Result);
    } catch {
      setMessage("診断を実行できませんでした（通信の失敗）。");
    } finally {
      setBusy(false);
    }
  }

  const rows: [string, string][] = result
    ? [
        ["Stripe API認証", result.apiAuth === "success" ? "成功" : result.apiAuth === "failure" ? "失敗" : "未実行（設定の不足）"],
        [
          "Stripeアカウント照合",
          result.accountMatch === "match"
            ? "一致"
            : result.accountMatch === "mismatch"
            ? `不一致（Stripe から返った ID の末尾：${result.mismatchHint?.returnedLast4 ?? "—"}・STRIPE_ACCOUNT_ID の末尾：${result.mismatchHint?.configuredLast4 ?? "—"}${result.mismatchHint?.differsOnlyByCase ? "・大文字と小文字だけの違い" : ""}）`
            : "未実行",
        ],
        ["APIキー設定", `${yesNo(result.secretKeySet)}${result.secretKeySet ? (result.secretKeyIsTest ? "（テスト用 sk_test_）" : "（テスト用ではない）") : ""}`],
        ["アカウントID設定", `${yesNo(result.accountIdSet)}${result.accountIdHasSurroundingWhitespace ? "（前後に空白・改行あり。アプリは取り除いて使います）" : ""}`],
        ["Webhookシークレット設定", yesNo(result.webhookSecretSet)],
        ["実行環境", result.environment === "sandbox_v2" ? "Sandbox v2" : "その他"],
        ["診断日時", new Date(result.checkedAt).toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" })],
        ["エラー種別", result.error ? `${result.error}${errorLabels[result.error] ? `：${errorLabels[result.error]}` : ""}` : "なし"],
      ]
    : [];

  return (
    <div className="text-[13px]">
      <p className="mb-3 text-ink-muted">
        ボタンを押すと、決済の処理と同じ Stripe のキーで「キーの持ち主のアカウント」（GET /v1/account）だけを問い合わせ、STRIPE_ACCOUNT_ID と比べます。
        決済画面の作成・返金・Webhook の再送・データベースの変更はしません。キーとアカウントの ID の値は表示しません。
      </p>
      <button type="button" onClick={run} disabled={busy} className="btn-ghost inline-flex h-10 items-center rounded-xl px-4 disabled:opacity-50">
        {busy ? "診断中…" : "Stripe アカウントの照合を診断する"}
      </button>
      {message ? <p className="mt-3 text-amber-300">{message}</p> : null}
      {result ? (
        <dl className="mt-3 divide-y divide-white/5">
          {rows.map(([k, v]) => (
            <div key={k} className="grid gap-1 py-2.5 sm:grid-cols-[200px_1fr]">
              <dt className="text-ink-muted">{k}</dt>
              <dd className="break-all">{v}</dd>
            </div>
          ))}
        </dl>
      ) : null}
    </div>
  );
}
