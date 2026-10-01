import Link from "next/link";
import { Logo } from "@/components/ui/logo";
import { NavLinks, type NavItem } from "./nav-links";

export function ConsoleShell({
  badge,
  title,
  userName,
  nav,
  logoutAction,
  children,
}: {
  badge: string;
  title: string;
  userName: string;
  nav: NavItem[];
  logoutAction: () => Promise<void>;
  children: React.ReactNode;
}) {
  return (
    <div className="min-h-dvh lg:grid lg:grid-cols-[240px_1fr]">
      <aside className="glass-strong sticky top-0 z-30 border-x-0 border-t-0 lg:h-dvh lg:border-b-0 lg:border-r">
        <div className="flex items-center justify-between px-4 py-3 lg:block lg:px-5 lg:py-6">
          <Link href={nav[0]?.href ?? "/"}>
            <Logo sub={badge} />
          </Link>
          <p className="hidden truncate pt-3 text-[12px] text-ink-muted lg:block">{title}</p>
          <form action={logoutAction} className="lg:hidden">
            <button className="text-[12px] text-ink-muted underline underline-offset-4">ログアウト</button>
          </form>
        </div>
        <NavLinks items={nav} />
        <div className="absolute inset-x-0 bottom-0 hidden border-t border-white/10 p-5 lg:block">
          <p className="truncate text-[12px] text-ink-muted">{userName}</p>
          <form action={logoutAction}>
            <button className="mt-2 text-[12px] text-ink-faint underline underline-offset-4 hover:text-ink-muted">ログアウト</button>
          </form>
        </div>
      </aside>
      <main className="mx-auto w-full max-w-6xl px-4 py-6 fade-in lg:px-8 lg:py-8">{children}</main>
    </div>
  );
}

export function PageHeader({ title, description, actions }: { title: string; description?: React.ReactNode; actions?: React.ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="font-serif text-2xl font-bold tracking-wide">{title}</h1>
        {description ? <p className="mt-1 text-[13px] text-ink-muted">{description}</p> : null}
      </div>
      {actions ? <div className="flex flex-wrap gap-2">{actions}</div> : null}
    </div>
  );
}

export function Card({ title, children, className = "", actions }: { title?: string; children: React.ReactNode; className?: string; actions?: React.ReactNode }) {
  return (
    <section className={`glass rounded-2xl p-5 ${className}`}>
      {title ? (
        <div className="mb-4 flex items-center justify-between gap-2">
          <h2 className="font-serif text-base font-bold">{title}</h2>
          {actions}
        </div>
      ) : null}
      {children}
    </section>
  );
}

export function Stat({ label, value, unit, sub, emphasis }: { label: string; value: string; unit?: string; sub?: string; emphasis?: boolean }) {
  return (
    <div className={`glass rounded-2xl p-5 ${emphasis ? "!border-gold-300/40" : ""}`}>
      <p className="text-[12px] text-ink-muted">{label}</p>
      <p className="mt-2 flex items-baseline gap-1">
        <span className={`font-display text-4xl font-semibold tabular-nums ${emphasis ? "text-gold-200" : "text-ink"}`}>{value}</span>
        {unit ? <span className="text-sm text-ink-muted">{unit}</span> : null}
      </p>
      {sub ? <p className="mt-1 text-[11px] text-ink-faint">{sub}</p> : null}
    </div>
  );
}

const BADGE: Record<string, string> = {
  ACTIVE: "border-success/30 bg-success/10 text-success",
  SUSPENDED: "border-danger/30 bg-danger/10 text-danger",
  UNPAID: "border-gold-300/30 bg-gold-300/10 text-gold-200",
  PROCESSING: "border-violet-400/30 bg-violet-500/10 text-violet-300",
  PAID: "border-success/30 bg-success/10 text-success",
  SUCCEEDED: "border-success/30 bg-success/10 text-success",
  REFUNDED: "border-danger/30 bg-danger/10 text-danger",
  PENDING: "border-white/15 bg-white/5 text-ink-muted",
  COMPLETED: "border-success/30 bg-success/10 text-success",
  EXPIRED: "border-white/15 bg-white/5 text-ink-faint",
};
const BADGE_LABEL: Record<string, string> = {
  ACTIVE: "稼働中",
  SUSPENDED: "停止中",
  UNPAID: "未払い",
  PROCESSING: "処理中",
  PAID: "支払済",
  SUCCEEDED: "決済済",
  REFUNDED: "返金",
  PENDING: "未占い",
  COMPLETED: "占い済",
  EXPIRED: "期限切れ",
};

export function StatusBadge({ status }: { status: string }) {
  return (
    <span className={`inline-flex items-center whitespace-nowrap rounded-full border px-2 py-0.5 text-[11px] ${BADGE[status] ?? "border-white/15 text-ink-muted"}`}>
      {BADGE_LABEL[status] ?? status}
    </span>
  );
}

export function Table({ head, children, empty }: { head: React.ReactNode[]; children: React.ReactNode; empty?: boolean }) {
  return (
    <div className="-mx-5 overflow-x-auto px-5">
      <table className="w-full min-w-[560px] text-left text-[13px]">
        <thead>
          <tr className="border-b border-white/10 text-[11px] text-ink-faint">
            {head.map((h, i) => (
              <th key={i} className="whitespace-nowrap px-2 py-2 font-normal">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="[&_td]:px-2 [&_td]:py-2.5 [&_tr]:border-b [&_tr]:border-white/5">{children}</tbody>
      </table>
      {empty ? <p className="py-8 text-center text-[13px] text-ink-faint">データがありません</p> : null}
    </div>
  );
}
