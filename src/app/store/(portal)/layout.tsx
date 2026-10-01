import { ConsoleShell } from "@/components/console/shell";
import { requireStoreUser } from "@/lib/auth/session";
import { storeLogoutAction } from "../actions";

export const metadata = { robots: { index: false } };

const NAV = [
  { href: "/store/dashboard", label: "ダッシュボード" },
  { href: "/store/sales", label: "売上" },
  { href: "/store/settlements", label: "振込状況" },
  { href: "/store/qr", label: "店舗QRコード" },
  { href: "/store/profile", label: "店舗情報" },
  { href: "/store/bank", label: "振込先" },
];

export default async function StorePortalLayout({ children }: LayoutProps<"/store">) {
  const { user, store } = await requireStoreUser();
  return (
    <ConsoleShell badge="STORE" title={store.name} userName={user.name} nav={NAV} logoutAction={storeLogoutAction}>
      {children}
    </ConsoleShell>
  );
}
