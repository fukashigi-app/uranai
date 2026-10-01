import { Card, PageHeader } from "@/components/console/shell";
import { NewStoreForm } from "@/components/console/admin-forms";
import { requireOperator } from "@/lib/auth/session";
import { createStoreAction } from "../../../actions";

export const metadata = { title: "店舗を追加" };

export default async function NewStorePage() {
  await requireOperator();
  return (
    <>
      <PageHeader title="店舗を追加" description="作成すると推測困難な店舗コードと専用QRコードが自動発行されます。" />
      <Card>
        <NewStoreForm action={createStoreAction} />
      </Card>
    </>
  );
}
