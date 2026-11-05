"use client";

import { useRef, useState } from "react";

const ERROR_LABEL: Record<string, string> = {
  not_configured: "送信先（OPS_ALERT_WEBHOOK_URL）が登録されていません",
  invalid_url: "送信先が Discord の Webhook の形ではありません",
  rate_limited: "短い時間に続けて送ることはできません。10分ほどあけてください",
  timeout: "Discord の応答がありませんでした（時間切れ）",
  network_error: "Discord に接続できませんでした",
  http_401: "Discord が送信を拒否しました（送信先のトークンの誤りの可能性）",
  http_403: "Discord が送信を拒否しました（権限）",
  http_404: "送信先の Webhook が見つかりません（削除された可能性）",
  http_429: "Discord の送信の回数の制限にかかりました。時間をあけてください",
};

/**
 * Sandbox v2 専用：Discord の「テスト異常」の通知（POST /api/admin/test-alert）。
 *  - 「通知内容を確認」… 送る本文を表示するだけ（送信しない）
 *  - 「テスト異常を送信」… 確認の後に1回だけ送る。送信中はボタンを無効にし、二重に送らない。失敗しても自動では送り直さない
 * 送信先の URL・トークンは表示しない。
 */
export function TestAlertPanel() {
  const [content, setContent] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);

  async function call(mode: "preview" | "send") {
    if (inFlight.current) return; // 二重の操作を防ぐ（状態の更新を待たずに止める）
    inFlight.current = true;
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch("/api/admin/test-alert", { method: "POST", cache: "no-store", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify({ mode }) });
      if (res.status === 404) return setMessage("この環境では使えません（Sandbox v2 の Preview の運営アカウントだけ）。");
      if (res.status === 403) return setMessage("送信元を確認できませんでした。画面を開き直してください。");
      const json = (await res.json().catch(() => null)) as { mode?: string; content?: string; webhook?: string; result?: string; error?: string } | null;
      if (mode === "preview") {
        if (!json?.content) return setMessage("本文を作れませんでした。");
        setContent(json.content);
        return setMessage(json.webhook === "configured" ? "送信先は登録済みです（送信はまだしていません）。" : `送信できない状態です：${ERROR_LABEL[json.webhook ?? ""] ?? json.webhook}`);
      }
      if (json?.result === "sent") return setMessage("テスト異常を1通送りました。Discord の Sandbox v2 のチャンネルを確認してください。");
      const err = json?.error ?? `http_${res.status}`;
      setMessage(`送信できませんでした：${ERROR_LABEL[err] ?? err}（自動では送り直しません）`);
    } catch {
      setMessage("通信に失敗しました（自動では送り直しません）。");
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  function send() {
    const ok = window.confirm("Discord の Sandbox v2 のチャンネルに「【テスト異常】」の通知を1通送ります。実際の障害ではないことを本文に書きます。送信しますか？");
    if (ok) void call("send");
  }

  return (
    <div className="text-[13px]">
      <p className="mb-3 text-ink-muted">
        本番の通知と同じ判定・本文の組み立て・送信の処理に、作り物の異常を通して、Discord への届き方を確かめます。定期処理・決済監視は動かさず、データベースの記録・決済のデータは変更しません。
      </p>
      <div className="flex flex-wrap gap-2">
        <button type="button" onClick={() => void call("preview")} disabled={busy} className="btn-ghost inline-flex h-10 items-center rounded-xl px-4 disabled:opacity-50">
          通知内容を確認
        </button>
        <button type="button" onClick={send} disabled={busy} className="btn-ghost inline-flex h-10 items-center rounded-xl px-4 disabled:opacity-50">
          {busy ? "処理中…" : "テスト異常を送信"}
        </button>
      </div>
      {message ? <p className="mt-3 text-amber-300">{message}</p> : null}
      {content ? <pre className="mt-3 whitespace-pre-wrap break-all rounded-xl border border-white/10 p-3 text-[12px]">{content}</pre> : null}
    </div>
  );
}
