import { redirect } from "next/navigation";
import { LoginForm } from "@/components/console/login-form";
import { getStoreContext } from "@/lib/auth/session";
import { storeLoginAction } from "../actions";

export const metadata = { title: "店舗ログイン", robots: { index: false } };

export default async function StoreLoginPage() {
  if (await getStoreContext()) redirect("/store/dashboard");
  return <LoginForm action={storeLoginAction} badge="STORE" title="店舗管理画面ログイン" />;
}
