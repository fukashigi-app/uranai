/**
 * 運営者への異常の通知（Discord の Incoming Webhook）。この部品は Firestore に依存しない（判定・本文の組み立て・送信だけ）。
 *
 *  - 送信先は環境変数 OPS_ALERT_WEBHOOK_URL。Discord の正規の送信先（https://discord.com/api/webhooks/{ID}/{トークン}）だけを許可する
 *    （http・別のホスト・ポート・利用者名・クエリ・フラグメント・形の違うパスは拒否。送信先の URL・トークンはログ・記録・本文に出さない）
 *  - 環境（Sandbox v2・本番など）ごとに別の送信先を登録する（Vercel のブランチ専用の変数・Production の変数）。本文の先頭に環境を書く
 *  - 本文に入れるのは異常の種類・件数・段階の結果・エラーの識別子・運営画面への案内だけ。決済の ID・店舗・個人情報・秘密の値は入れない
 *  - メンション（@everyone など）は無効にする。本文は Discord の上限（2000文字）より短く切る
 */

type Env = Record<string, string | undefined>;

export const DISCORD_WEBHOOK_HOSTS: ReadonlySet<string> = new Set(["discord.com", "discordapp.com"]);
const WEBHOOK_PATH_RE = /^\/api\/webhooks\/(\d{17,20})\/([A-Za-z0-9_-]{60,100})$/;
export const DISCORD_CONTENT_LIMIT = 1900;
export const ALERT_SEND_TIMEOUT_MS = 5000;

/** 正規の Discord の Webhook の URL なら正規化した URL、違えば null（理由は返さない。値を表示しない） */
export function parseDiscordWebhookUrl(raw: string | undefined): string | null {
  const s = (raw ?? "").trim();
  if (!s || s.length > 300) return null;
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" || !DISCORD_WEBHOOK_HOSTS.has(u.hostname) || u.port !== "" || u.username || u.password || u.search || u.hash) return null;
  if (!WEBHOOK_PATH_RE.test(u.pathname)) return null;
  return `https://${u.hostname}${u.pathname}`;
}

/** 送信先の設定の状態（値は返さない） */
export function alertWebhookStatus(e: Env = process.env): "configured" | "not_configured" | "invalid" {
  if (!(e.OPS_ALERT_WEBHOOK_URL ?? "").trim()) return "not_configured";
  return parseDiscordWebhookUrl(e.OPS_ALERT_WEBHOOK_URL) ? "configured" : "invalid";
}

export type AlertIssue = { severity: "error" | "warn"; text: string };

type PhaseLike = { name: string; status: string; reason: string | null; errorCode: string | null; abortSettled?: boolean | null };

const PHASE_LABEL: Record<string, string> = {
  maintenance: "メンテナンス",
  webhookRecovery: "Webhook の自動復旧",
  recheckRecovery: "決済確定の後の自動再確認",
  paymentMonitor: "決済監視",
};

const safeCode = (v: unknown) => (typeof v === "string" && /^[A-Za-z0-9_.:-]{1,60}$/.test(v) ? v : null);
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);

/** 定期処理の1回の結果から、通知すべき異常を集める（件数・状態・エラーの識別子だけ） */
export function collectCronIssues(r: {
  runStatus: string;
  unsettled: boolean;
  phases: readonly PhaseLike[];
  webhookRecovery?: unknown;
  recheckRecovery?: unknown;
  paymentMonitor?: { status: string } | null;
}): AlertIssue[] {
  const out: AlertIssue[] = [];
  if (r.runStatus === "lock_lost") out.push({ severity: "error", text: "定期処理のロックを失ったため、残りの段階を実行しませんでした" });
  if (r.unsettled) out.push({ severity: "error", text: "中止の合図の後も止まらなかった段階があります（ロックは期限で外れます）" });
  for (const p of r.phases) {
    const label = PHASE_LABEL[p.name] ?? p.name;
    const code = safeCode(p.errorCode);
    if (p.status === "failed") out.push({ severity: "error", text: `${label}：失敗${code ? `（${code}）` : ""}` });
    else if (p.status === "timed_out") out.push({ severity: "error", text: `${label}：時間切れ${p.abortSettled === false ? "（止まらずに続いている可能性）" : ""}` });
    else if (p.status === "skipped" && p.reason === "deadline" && p.name !== "paymentMonitor") out.push({ severity: "warn", text: `${label}：時間不足で実行しませんでした` });
  }
  const wr = (r.webhookRecovery ?? {}) as Record<string, unknown>;
  if (num(wr.failed) > 0) out.push({ severity: "error", text: `Webhook の自動復旧：処理できなかった通知 ${num(wr.failed)}件` });
  else if (wr.status === "partial") out.push({ severity: "warn", text: "Webhook の自動復旧：上限・時間で処理しきれず、次回に残りました" });
  const rr = (r.recheckRecovery ?? {}) as Record<string, unknown>;
  if (num(rr.error) > 0) out.push({ severity: "error", text: `自動再確認：失敗 ${num(rr.error)}件` });
  if (num(rr.rejected) > 0) out.push({ severity: "warn", text: `自動再確認：拒否 ${num(rr.rejected)}件` });
  const pm = r.paymentMonitor?.status;
  const pmText: Record<string, [AlertIssue["severity"], string]> = {
    failed: ["error", "決済監視：点検に失敗しました"],
    lock_failed: ["error", "決済監視：点検のロックを取れませんでした"],
    timed_out: ["error", "決済監視：時間切れ"],
    partial: ["warn", "決済監視：一部の項目を確認できませんでした"],
    skipped_time: ["warn", "決済監視：時間不足で点検しませんでした"],
    skipped_lock_lost: ["warn", "決済監視：定期処理のロックを失ったため点検しませんでした"],
  };
  if (pm && pmText[pm]) out.push({ severity: pmText[pm][0], text: pmText[pm][1] });
  return out;
}

/** 前回までに通知した ID と、今の未確認の一覧から、新しいもの（まだ通知していないもの）と次の状態を求める */
export function diffOpenItems<T extends { id: string }>(notified: readonly string[], open: readonly T[]): { fresh: T[]; next: string[] } {
  const prev = new Set(notified);
  return { fresh: open.filter((o) => !prev.has(o.id)), next: open.map((o) => o.id) };
}

/** 種類とモードでまとめて「ラベル（モード）×件数」の行にする（ID は出さない） */
export function groupLines(items: readonly { label: string; mode?: string | null }[]): string[] {
  const m = new Map<string, number>();
  for (const it of items) {
    const label = it.label.length > 70 ? `${it.label.slice(0, 69)}…` : it.label;
    const key = `${label}${it.mode ? `（${it.mode}）` : ""}`;
    m.set(key, (m.get(key) ?? 0) + 1);
  }
  return [...m.entries()].map(([k, n]) => `・${k} ×${n}`);
}

export type DiscordPayload = { content: string; allowed_mentions: { parse: [] } };

export function buildAlertMessage(o: {
  envLabel: string;
  at: Date;
  issues: readonly AlertIssue[];
  newAlerts: readonly { label: string; mode?: string | null }[];
  newReviews: readonly { label: string; mode?: string | null }[];
  /** 削除の遅れ：続いた回数と、処理ごとの説明（確認できた事実だけ。推測の件数は入れない） */
  deletionDelay?: { runs: number; items: string[] } | null;
  /** 未確認の一覧が取得の上限を超えた（確定）か。超えたときは、一部の異常を通知できていない可能性があることを書く */
  listsExceeded?: { alerts: boolean; reviews: boolean; limit: number } | null;
  adminUrl?: string | null;
}): DiscordPayload {
  const at = o.at.toLocaleString("ja-JP", { timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
  const hasError = o.issues.some((i) => i.severity === "error") || o.newAlerts.length > 0 || o.newReviews.length > 0;
  const lines: string[] = [`【${hasError ? "要対応" : "注意"}】100円占い・決済の運用（${o.envLabel}） ${at}`];
  const errs = o.issues.filter((i) => i.severity === "error");
  const warns = o.issues.filter((i) => i.severity === "warn");
  if (o.newAlerts.length) lines.push(`■ 新しい未確認の決済監視の異常：${o.newAlerts.length}件`, ...groupLines(o.newAlerts));
  if (o.newReviews.length) lines.push(`■ 新しい決済要確認：${o.newReviews.length}件`, ...groupLines(o.newReviews));
  if (errs.length) lines.push("■ 定期処理の異常", ...errs.map((i) => `・${i.text}`));
  if (warns.length) lines.push("■ 注意", ...warns.map((i) => `・${i.text}`));
  if (o.listsExceeded && (o.listsExceeded.alerts || o.listsExceeded.reviews)) {
    const which = [o.listsExceeded.alerts ? "決済監視の異常" : null, o.listsExceeded.reviews ? "決済要確認" : null].filter(Boolean).join("・");
    lines.push(`■ 未確認の${which}が${o.listsExceeded.limit}件を超えています。一部の異常を通知できていない可能性があります（運営画面で確認してください）`);
  }
  if (o.deletionDelay) lines.push(`■ データの削除の遅れ（${o.deletionDelay.runs}回続けて）`, ...o.deletionDelay.items.map((i) => `・${i}`));
  if (o.adminUrl) lines.push(`確認：${o.adminUrl}`);
  let content = lines.join("\n");
  if (content.length > DISCORD_CONTENT_LIMIT) content = `${content.slice(0, DISCORD_CONTENT_LIMIT - 20)}\n…（以下省略）`;
  return { content, allowed_mentions: { parse: [] } };
}

/**
 * 週1回の正常の報告（異常が無い回だけ）。値は記録から得たものだけを書く（取得できないものは「取得不可」）。
 * この報告が届かないことに、運営者が気づく必要がある（届かないことを自動で検知する仕組みは無い）
 */
export function buildHeartbeatMessage(o: {
  envLabel: string;
  at: Date;
  /** 直近7日の実行の回数（記録から数えた値。null は取得不可）。since … 履歴を取り始めた時刻（7日より新しければ、その時刻からの回数） */
  runs7d: { count: number; since: Date | null } | null;
  openAlerts: { count: number; exceeded: boolean } | null;
  openReviews: { count: number; exceeded: boolean } | null;
  adminUrl?: string | null;
}): DiscordPayload {
  const fmt = (d: Date) => d.toLocaleString("ja-JP", { timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
  const count = (c: { count: number; exceeded: boolean } | null) => (c ? `${c.count}件${c.exceeded ? "以上" : ""}` : "取得不可");
  const weekAgo = o.at.getTime() - 7 * 86_400_000;
  const runs = !o.runs7d
    ? "取得不可"
    : o.runs7d.since && o.runs7d.since.getTime() > weekAgo
      ? `${o.runs7d.count}回（今回を含む。記録は ${fmt(o.runs7d.since)} から）`
      : `${o.runs7d.count}回（今回を含む）`;
  const lines = [
    `【正常】100円占い・決済の運用（${o.envLabel}） 週1回の定期報告 ${fmt(o.at)}`,
    `・最終実行：今回（${fmt(o.at)}）。この回の定期処理に異常はありませんでした`,
    `・直近7日の実行：${runs}`,
    `・未確認：決済監視の異常 ${count(o.openAlerts)}・決済要確認 ${count(o.openReviews)}`,
    "・この報告は異常が無いときに7日に1回送ります。7日を過ぎても届かない場合は、定期処理が止まっている可能性があります（届かないことは自動では検知できません）",
  ];
  if (o.adminUrl) lines.push(`確認：${o.adminUrl}`);
  return { content: lines.join("\n").slice(0, DISCORD_CONTENT_LIMIT), allowed_mentions: { parse: [] } };
}

export type SendResult = { ok: true } | { ok: false; error: string };

/** 送信する（時間切れ・失敗は例外にしない。エラーは種類・状態コードだけ。URL は返さない・出さない） */
export async function sendDiscordAlert(url: string, payload: DiscordPayload, opts: { fetchImpl?: typeof fetch; timeoutMs?: number; /** 呼び出し側の中止の合図（全体の時間切れ）。送信中でも中止する */ signal?: AbortSignal } = {}): Promise<SendResult> {
  const valid = parseDiscordWebhookUrl(url);
  if (!valid) return { ok: false, error: "invalid_url" };
  if (opts.signal?.aborted) return { ok: false, error: "aborted" }; // 中止の後は新しい送信を始めない
  const f = opts.fetchImpl ?? fetch;
  const timeout = AbortSignal.timeout(opts.timeoutMs ?? ALERT_SEND_TIMEOUT_MS);
  try {
    const res = await f(valid, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: opts.signal ? AbortSignal.any([timeout, opts.signal]) : timeout,
      redirect: "error",
    });
    if (res.ok) return { ok: true };
    return { ok: false, error: `http_${res.status}` };
  } catch (e) {
    const name = (e as Error)?.name;
    if (opts.signal?.aborted) return { ok: false, error: "aborted" };
    return { ok: false, error: name === "TimeoutError" || name === "AbortError" ? "timeout" : "network_error" };
  }
}

/** 本文の先頭に書く環境の名前（値から決める。送信先の取り違えに気づけるように） */
export function environmentLabelOf(e: Env, isSandboxV2: boolean): string {
  if (e.VERCEL_ENV === "production") return "本番";
  if (isSandboxV2) return "Sandbox v2・テスト";
  if (e.VERCEL_ENV === "preview") return "Preview・テスト";
  return "ローカル";
}
