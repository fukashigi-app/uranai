import Link from "next/link";
import type { OperatorIssue } from "@/config/operator";

/**
 * 運営ダッシュボード用：特商法表記などに表示する運営者情報の設定状況。
 * 値そのもの（氏名・住所など）は表示しない。設定の不備（error）と、公開前に確認が必要な事項（notice）を分けて表示する。
 */
export function OperatorInfoNotice({ issues, className = "" }: { issues: OperatorIssue[]; className?: string }) {
  if (!issues.length) return null;
  const errors = issues.filter((i) => i.level === "error");
  const notices = issues.filter((i) => i.level === "notice");
  return (
    <section
      aria-label="運営者情報の設定"
      data-operator-info-notice
      className={`rounded-2xl border px-4 py-3 text-[13px] leading-relaxed ${errors.length ? "border-danger/40 bg-danger/10 text-danger" : "border-gold-300/30 bg-gold-300/[0.06] text-gold-50"} ${className}`}
    >
      <p className="font-bold">{errors.length ? "⚠ 運営者情報の設定に不備があります" : "運営者情報（特定商取引法に基づく表記など）の確認事項"}</p>
      <ul className="mt-1 list-disc space-y-0.5 pl-5">
        {[...errors, ...notices].map((i) => (
          <li key={`${i.level}:${i.key}`}>{i.message}</li>
        ))}
      </ul>
      <p className="mt-1.5 text-[12px] opacity-80">
        表示内容は{" "}
        <Link href="/commercial-transaction" className="underline underline-offset-2" target="_blank">
          特定商取引法に基づく表記
        </Link>{" "}
        で確認できます。設定は Vercel の環境変数（OPERATOR_*）で行います。
      </p>
    </section>
  );
}
