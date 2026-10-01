import { notFound } from "next/navigation";
import { ConsoleShell } from "@/components/console/shell";
import { getSessionUser } from "@/lib/auth/session";
import { redirect } from "next/navigation";
import { adminLogoutAction } from "../actions";

export const metadata = { robots: { index: false } };

const NAV = [
  { href: "/admin", label: "ダッシュボード", exact: true },
  { href: "/admin/stores", label: "店舗" },
  { href: "/admin/transactions", label: "決済履歴" },
  { href: "/admin/settlements", label: "月次精算" },
  { href: "/admin/settings", label: "設定" },
];

export default async function AdminLayout({ children }: LayoutProps<"/admin">) {
  const user = await getSessionUser();
  if (!user) redirect("/admin/login");
  // 店舗アカウントには運営画面の存在自体を見せない
  if (user.role !== "OPERATOR") notFound();
  return (
    <ConsoleShell badge="ADMIN" title="運営管理" userName={user.name} nav={NAV} logoutAction={adminLogoutAction}>
      {children}
    </ConsoleShell>
  );
}
