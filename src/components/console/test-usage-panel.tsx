import type { TestUsage } from "@/lib/services/test-usage";

/**
 * 無料テストモードでの利用件数（お試し・決済なし）。
 * 有料の利用件数・売上・取り分とは別枠で表示し、テスト利用であることがひと目で分かるようにする。
 */
export function TestUsagePanel({ usage, testModeOn, note, className = "" }: { usage: TestUsage; testModeOn: boolean; note?: string; className?: string }) {
  return (
    <section className={`rounded-2xl border border-dashed border-violet-400/40 bg-violet-500/[0.06] p-5 ${className}`} aria-label="無料テストモードでの利用件数" data-test-usage>
      <p className="flex flex-wrap items-center gap-2 text-[12px] text-violet-300">
        <span className="rounded-full border border-violet-400/50 px-2 py-0.5 text-[11px] font-bold">無料テスト</span>
        無料テストモードでの利用（お試し・決済なし）
        <span className="text-ink-faint">{testModeOn ? "現在：テストモード ON" : "現在：テストモード OFF（過去の記録）"}</span>
      </p>
      <div className="mt-3 flex flex-wrap gap-x-8 gap-y-2">
        <p className="flex items-baseline gap-1">
          <span className="text-[12px] text-ink-muted">今月</span>
          <span className="font-display text-3xl font-semibold tabular-nums text-violet-300" data-test-usage-month>
            {usage.thisMonth.toLocaleString("ja-JP")}
          </span>
          <span className="text-sm text-ink-muted">回</span>
        </p>
        <p className="flex items-baseline gap-1">
          <span className="text-[12px] text-ink-muted">累計</span>
          <span className="font-display text-3xl font-semibold tabular-nums text-violet-300" data-test-usage-total>
            {usage.total.toLocaleString("ja-JP")}
          </span>
          <span className="text-sm text-ink-muted">回</span>
        </p>
      </div>
      <p className="mt-2 text-[11px] leading-relaxed text-ink-faint">
        お試し利用のため、上の利用件数・売上・取り分には含まれません。{note ?? ""}
      </p>
    </section>
  );
}
