import { redirect } from "next/navigation";
import { LoginForm } from "@/components/console/login-form";
import { getSessionUser } from "@/lib/auth/session";
import { adminLoginAction } from "../actions";

export const metadata = { title: "運営ログイン", robots: { index: false } };

export default async function AdminLoginPage() {
  const u = await getSessionUser();
  if (u?.role === "OPERATOR") redirect("/admin");
  return <LoginForm action={adminLoginAction} badge="ADMIN" title="運営管理画面ログイン" />;
}
