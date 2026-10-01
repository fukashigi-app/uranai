import { Card, PageHeader } from "@/components/console/shell";
import { PasswordForm, StoreProfileForm } from "@/components/console/store-forms";
import { requireStoreUser } from "@/lib/auth/session";
import { changeStorePasswordAction, updateStoreProfileAction } from "../../actions";

export const metadata = { title: "店舗情報" };

export default async function StoreProfilePage() {
  const { store, user } = await requireStoreUser();
  return (
    <>
      <PageHeader title="店舗情報" description="変更内容は履歴として記録されます。" />
      <Card title="基本情報">
        <StoreProfileForm action={updateStoreProfileAction} values={{ name: store.name, contactName: store.contactName, postalCode: store.postalCode, address: store.address, phone: store.phone, email: store.email }} />
      </Card>
      <Card title="ログインアカウント" className="mt-4">
        <p className="mb-2 text-[13px] text-ink-muted">ログイン中: {user.email}</p>
        <PasswordForm action={changeStorePasswordAction} />
      </Card>
    </>
  );
}
