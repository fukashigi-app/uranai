import type { ProductionConfigIssue } from "@/lib/env";
import type { MaintenanceStatus } from "@/lib/services/maintenance-status";
import { formatDateTimeJa } from "@/lib/time";

/**
 * 運営ダッシュボード用：本番環境の危険な設定と、定期処理の実行状況。設定値（秘密鍵など）は表示しない。
 * 何も問題がなければ表示しない。
 */
export function SystemStatusNotice({
  issues,
  maintenance,
  production,
  className = "",
}: {
  issues: ProductionConfigIssue[];
  maintenance: MaintenanceStatus | null;
  /** Vercel の本番か（定期処理が止まっている警告は本番でだけ出す） */
  production: boolean;
  className?: string;
}) {
  const lines: { level: "error" | "warning"; text: string }[] = issues.map((i) => ({ level: i.level, text: `${i.key}：${i.message}` }));
  if (production && maintenance?.tracked) {
    if (!maintenance.lastSuccessAt) {
      lines.push({ level: "error", text: "定期処理がまだ一度も成功していません。Vercel の Cron Jobs の設定と CRON_SECRET を確認してください。" });
    } else if (maintenance.stale) {
      lines.push({ level: "error", text: `定期処理が止まっている可能性があります（最後の成功：${formatDateTimeJa(maintenance.lastSuccessAt)}）。` });
    }
    if (maintenance.lastStatus === "failure") {
      lines.push({ level: "warning", text: `前回の定期処理が失敗しました（${maintenance.lastFailureAt ? formatDateTimeJa(maintenance.lastFailureAt) : "日時不明"}・${maintenance.lastErrorCode ?? "原因不明"}）。Vercel のログを確認してください。` });
    }
  }
  if (!lines.length) return null;
  const hasError = lines.some((l) => l.level === "error");
  return (
    <section
      aria-label="本番環境の設定と定期処理"
      data-system-status-notice
      className={`rounded-2xl border px-4 py-3 text-[13px] leading-relaxed ${hasError ? "border-danger/40 bg-danger/10 text-danger" : "border-gold-300/30 bg-gold-300/[0.06] text-gold-50"} ${className}`}
    >
      <p className="font-bold">{hasError ? "⚠ 本番環境の設定を確認してください" : "本番環境の確認事項"}</p>
      <ul className="mt-1 list-disc space-y-0.5 pl-5">
        {lines.map((l) => (
          <li key={l.text}>{l.text}</li>
        ))}
      </ul>
      <p className="mt-1.5 text-[12px] opacity-80">設定は Vercel の環境変数で変更します。状態は /api/health でも確認できます。</p>
    </section>
  );
}
