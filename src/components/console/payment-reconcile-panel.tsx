"use client";

import { useState } from "react";

type Item = { kind: string; details: string[]; paymentIntentId: string; chargeId: string | null; checkoutId: string | null; transactionId: string; storeId: string | null; created: number; existingReview: boolean; delta?: number };
type Ref = { paymentIntentId: string; checkoutId: string | null; created: number; scope?: string; reason?: string; chargeId?: string | null; transactionId?: string | null };
type Result = {
  runId: string;
  mode: "test" | "live";
  from: number;
  to: number;
  startedAt: number;
  verdict: "incomplete" | "issues" | "needs_review" | "pending" | "ok";
  stoppedBy: string | null;
  done: boolean;
  pages: number;
  segmentPages: number;
  counts: Record<string, number>;
  byKind: Record<string, number>;
  anomalies: Item[];
  pendingItems: Ref[];
  reviewItems: Ref[];
  truncated: { anomalies: boolean; pending: boolean; review: boolean; dupIndex: boolean; checked: boolean };
  phase: "payments" | "refunds" | "disputes";
  token: string | null;
};

export type ReconcileLabels = {
  kind: Record<string, string>;
  detail: Record<string, string>;
  stop: Record<string, string>;
  error: Record<string, string>;
  review: Record<string, string>;
  pending: Record<string, string>;
};

const PHASE_LABEL: Record<string, string> = { payments: "決済の一覧", refunds: "返金の一覧", disputes: "異議申し立ての一覧" };

const VERDICT: Record<Result["verdict"], { label: string; cls: string; text: string }> = {
  ok: { label: "異常なし", cls: "border-success/40 text-success", text: "期間内のすべてのページを読み、この環境の支払い済みの決済は、すべて注文・取引の記録と一致しました。" },
  pending: { label: "処理待ちあり", cls: "border-gold-300/50 text-gold-200", text: "異常は見つかりませんでしたが、支払いの直後で記録がまだ無い決済があります。時間をおいて、もう一度照合してください。" },
  needs_review: { label: "要確認", cls: "border-gold-300/50 text-gold-200", text: "異常は見つかりませんでしたが、照合できなかった支払い済みの決済があります（下の一覧）。Stripe のダッシュボードで確認してください。" },
  issues: { label: "異常あり", cls: "border-danger/40 text-danger", text: "Stripe で支払い済みなのに、記録と一致しない決済があります。下の一覧の ID で、Stripe のダッシュボードと Firestore の記録を確認してください（自動では修正しません）。" },
  incomplete: { label: "未完了", cls: "border-danger/40 text-danger", text: "すべてのページを読み終えていません。ここまでの結果だけでは「異常なし」とは言えません。「続きから照合する」で再開してください。" },
};

const fmt = (sec: number) => new Date(sec * 1000).toLocaleString("ja-JP", { timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
const jstToday = () => new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);
const jstDaysAgo = (n: number) => new Date(Date.now() + 9 * 3600_000 - n * 86_400_000).toISOString().slice(0, 10);

/**
 * Stripe 起点の決済照合（読み取り専用）。ボタンを押したときだけ、サーバーが Stripe の PaymentIntent の一覧を読み、
 * Firestore の注文・取引と照合する。表示するのは件数・分類・Stripe と Firestore の ID だけ（個人情報・キーは表示しない）。
 * 未完了の照合は、サーバーが署名した再開用の値で続きから再開する（期間・環境は変えられない）。
 */
export function PaymentReconcilePanel({ mode, labels }: { mode: "test" | "live" | null; labels: ReconcileLabels }) {
  const [from, setFrom] = useState(jstDaysAgo(6));
  const [to, setTo] = useState(jstToday());
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Result | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  async function call(body: Record<string, unknown>) {
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch("/api/admin/payment-reconcile", { method: "POST", cache: "no-store", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      if (!res.ok) {
        let code = "";
        try {
          code = String(((await res.json()) as { error?: unknown }).error ?? "");
        } catch {
          code = "";
        }
        setMessage(res.status === 429 ? labels.error.rate_limited : (labels.error[code] ?? "照合を実行できませんでした。異常の有無は確認できていません。"));
        return;
      }
      setResult((await res.json()) as Result);
    } catch {
      setMessage("照合を実行できませんでした（通信の失敗）。異常の有無は確認できていません。");
    } finally {
      setBusy(false);
    }
  }

  const v = result ? VERDICT[result.verdict] : null;
  const c = result?.counts ?? {};
  return (
    <div className="text-[13px]">
      {mode === "live" ? (
        <p className="mb-3 rounded-lg border border-amber-400/30 bg-amber-400/10 px-3 py-2 text-amber-200">本番（Live）の Stripe の決済を読み取って照合します。課金・返金・データの変更はしません。</p>
      ) : null}
      {mode === null ? <p className="mb-3 text-amber-300">この環境では Stripe に接続できないため、照合できません。</p> : null}
      <div className="flex flex-wrap items-end gap-3">
        <label className="grid gap-1">
          <span className="text-[11px] text-ink-faint">開始日（日本時間）</span>
          <input type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} className="h-10 rounded-xl border border-white/10 bg-transparent px-3" />
        </label>
        <label className="grid gap-1">
          <span className="text-[11px] text-ink-faint">終了日（この日を含む）</span>
          <input type="date" value={to} min={from} onChange={(e) => setTo(e.target.value)} className="h-10 rounded-xl border border-white/10 bg-transparent px-3" />
        </label>
        <button type="button" disabled={busy || mode === null} onClick={() => call({ action: "start", from, to })} className="btn-gold inline-flex h-10 items-center rounded-xl px-4 font-bold disabled:opacity-50">
          {busy ? "照合中…" : "照合する（読み取りのみ）"}
        </button>
        {result?.token ? (
          <button type="button" disabled={busy} onClick={() => call({ action: "resume", token: result.token })} className="btn-ghost inline-flex h-10 items-center rounded-xl px-4 disabled:opacity-50">
            続きから照合する
          </button>
        ) : null}
      </div>
      <p className="mt-2 text-[11px] text-ink-faint">期間は最長31日です。1回の実行は約40秒・30ページ（3,000件）までで区切り、続きから再開できます。再開できるのは開始から2時間までです。</p>
      {message ? (
        <p role="alert" className="mt-3 text-amber-300">
          {message}
        </p>
      ) : null}
      {result && v ? (
        <div className="mt-4 space-y-4" data-reconcile-verdict={result.verdict}>
          <div>
            <p>
              <span className={`mr-2 inline-flex rounded-full border px-2 py-0.5 text-[11px] ${v.cls}`}>{v.label}</span>
              {v.text}
            </p>
            {result.stoppedBy ? <p className="mt-1 text-danger">{`止まった理由：${labels.stop[result.stoppedBy] ?? result.stoppedBy}（${PHASE_LABEL[result.phase] ?? result.phase}の途中）`}</p> : null}
            {result.truncated.checked ? <p className="mt-1 text-gold-200">返金・異議申し立てを確かめる件数の上限を超えたため、一部の決済は確かめていません（「要確認」に表示）。</p> : null}
            {result.truncated.dupIndex ? (
              <p data-reconcile-dup-truncated="true" className="mt-1 text-gold-200">
                未確定の支払い済みの決済が重複の判定の上限（1,000件）を超えたため、超えた分は同じ注文への重複を判定していません。重複が無いとは言えません（期間を短くして照合し直してください）。
              </p>
            ) : null}
            <p className="mt-1 text-[12px] text-ink-faint">{`期間：${fmt(result.from)} 〜 ${fmt(result.to)}（${result.mode === "live" ? "本番" : "テスト"}）・読んだページ ${result.pages}（今回 ${result.segmentPages}）・照合 ID ${result.runId}`}</p>
          </div>
          <dl className="grid gap-x-6 gap-y-1 sm:grid-cols-2">
            {(
              [
                ["読んだ PaymentIntent", c.scanned],
                ["この環境の決済", c.inScope],
                ["記録と一致", c.matched],
                ["異常のある決済", c.anomalyPayments],
                ["処理待ち（支払いの直後）", c.pending],
                ["要確認（照合できなかった支払い済み）", c.needsReview],
                ["支払いが完了していない（照合しない）", c.notPaid],
                ["返金・異議申し立てを確かめた決済", c.adjustmentChecks],
                ["返金・異議申し立ての異常がある決済", c.adjustmentIssues],
                ["返金の一覧・異議申し立ての一覧で読んだ件数", (c.refundsSeen ?? 0) + (c.disputesSeen ?? 0)],
                ["返金の処理中（取引にも反映済み・正常な一時状態）", c.refundInProgress],
                ["異議申し立ての対応中（取引にも反映済み）", c.disputeOpen],
                ["精算の調整を確かめた取引（確定済みの精算）", c.settlementChecked],
                ["対象外：別の環境", c.otherEnv],
                ["対象外：モードが違う", c.otherMode],
                ["環境を表す値が無い・形が違う（全状態）", (c.untagged ?? 0) + (c.badTag ?? 0)],
              ] as [string, number | undefined][]
            ).map(([k, n]) => (
              <div key={k} className="flex justify-between gap-3 border-b border-white/5 py-1">
                <dt className="text-ink-muted">{k}</dt>
                <dd className="tabular-nums">{n ?? 0}</dd>
              </div>
            ))}
          </dl>
          {result.anomalies.length ? (
            <section>
              <h3 className="mb-2 font-bold">{`異常（${c.anomalies}件）`}</h3>
              <ul className="mb-2 flex flex-wrap gap-2 text-[12px]">
                {Object.entries(result.byKind)
                  .filter(([, n]) => n > 0)
                  .map(([k, n]) => (
                    <li key={k} className="rounded-full border border-danger/40 px-2 py-0.5 text-danger">{`${labels.kind[k] ?? k}：${n}件`}</li>
                  ))}
              </ul>
              <div className="-mx-5 overflow-x-auto px-5">
                <table className="w-full min-w-[640px] text-left text-[12px]">
                  <thead>
                    <tr className="border-b border-white/10 text-[11px] text-ink-faint">
                      <th className="py-2 pr-3">支払い日時</th>
                      <th className="py-2 pr-3">種類</th>
                      <th className="py-2 pr-3">Stripe の ID</th>
                      <th className="py-2">Firestore の ID</th>
                    </tr>
                  </thead>
                  <tbody>
                    {result.anomalies.map((a, i) => (
                      <tr key={`${a.paymentIntentId}:${a.kind}:${i}`} data-reconcile-kind={a.kind} className="border-b border-white/5 align-top">
                        <td className="whitespace-nowrap py-2 pr-3 tabular-nums">{fmt(a.created)}</td>
                        <td className="py-2 pr-3">
                          {labels.kind[a.kind] ?? a.kind}
                          {a.details.length ? <span className="block text-ink-faint">{a.details.map((d) => labels.detail[d] ?? d).join("・")}</span> : null}
                          {a.existingReview ? <span className="block text-gold-200">決済要確認に記録済み（同じ決済）</span> : null}
                          {typeof a.delta === "number" && a.delta !== 0 ? <span className="block text-ink-faint">{`差額 ${a.delta}円（今の取り分 − 支払った額 − 調整の合計）`}</span> : null}
                        </td>
                        <td className="py-2 pr-3 font-mono text-[11px] text-ink-faint">
                          <span className="block">{`PaymentIntent: ${a.paymentIntentId}`}</span>
                          {a.chargeId ? <span className="block">{`Charge: ${a.chargeId}`}</span> : null}
                        </td>
                        <td className="py-2 font-mono text-[11px] text-ink-faint">
                          <span className="block">{`注文: ${a.checkoutId ?? "（metadata に無い）"}`}</span>
                          <span className="block">{`取引: ${a.transactionId}`}</span>
                          {a.storeId ? <span className="block">{`店舗: ${a.storeId}`}</span> : null}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {(result.byKind.refund_mismatch ?? 0) + (result.byKind.dispute_mismatch ?? 0) > 0 ? (
                <p className="mt-1 text-[11px] text-ink-faint">返金・異議申し立ての状態が変わった直後（処理中→成功など）は、Stripe に変わった日時が無いため、取引への反映の前に異常として出ることがあります。時間をおいて照合し直してください。</p>
              ) : null}
              {result.truncated.anomalies ? <p className="mt-1 text-[11px] text-gold-200">{`表示の上限を超えたため、一部だけを表示しています（件数はすべて数えています）。`}</p> : null}
            </section>
          ) : null}
          {result.reviewItems.length ? (
            <section>
              <h3 className="mb-2 font-bold">{`要確認：正常とは判断できなかった決済（${c.needsReview}件）`}</h3>
              <p className="mb-1 text-[11px] text-ink-faint">環境を表す値が無い決済・返金や異議申し立ての内容を確認できない決済・部分返金や返金の失敗・以前の仕組みで確定した精算など、照合で正常と判断できなかったものです。</p>
              <ul className="space-y-1 font-mono text-[11px] text-ink-faint">
                {result.reviewItems.map((r, i) => (
                  <li key={`${r.paymentIntentId}:${r.reason ?? r.scope}:${i}`} data-reconcile-review={r.scope ?? r.reason} data-reconcile-review-reason={r.reason ?? r.scope}>{`${fmt(r.created)}  PaymentIntent: ${r.paymentIntentId}${r.chargeId ? `  Charge: ${r.chargeId}` : ""}  注文: ${r.checkoutId ?? "—"}${r.transactionId ? `  取引: ${r.transactionId}` : ""}  （${labels.review[r.reason ?? r.scope ?? ""] ?? r.reason ?? r.scope}）`}</li>
                ))}
              </ul>
              {result.truncated.review ? <p className="mt-1 text-[11px] text-gold-200">表示の上限を超えたため、一部だけを表示しています。</p> : null}
            </section>
          ) : null}
          {result.pendingItems.length ? (
            <section>
              <h3 className="mb-2 font-bold">{`処理待ち（${c.pending}件）`}</h3>
              <ul className="space-y-1 font-mono text-[11px] text-ink-faint">
                {result.pendingItems.map((r, i) => (
                  <li key={`${r.paymentIntentId}:${r.reason ?? "payment"}:${i}`} data-reconcile-pending={r.reason ?? "payment"}>{`${fmt(r.created)}  PaymentIntent: ${r.paymentIntentId}${r.chargeId ? `  Charge: ${r.chargeId}` : ""}  注文: ${r.checkoutId ?? "—"}  （${labels.pending[r.reason ?? "payment"] ?? r.reason}）`}</li>
                ))}
              </ul>
              {result.truncated.pending ? <p className="mt-1 text-[11px] text-gold-200">表示の上限を超えたため、一部だけを表示しています。</p> : null}
            </section>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
