import { Card, PageHeader } from "@/components/console/shell";
import { BankForm } from "@/components/console/store-forms";
import { requireStoreUser } from "@/lib/auth/session";
import { readBankInfoMasked } from "@/lib/services/stores";
import { formatDateTimeJa } from "@/lib/time";
import { updateBankAction } from "../../actions";

export const metadata = { title: "振込先" };

export default async function StoreBankPage() {
  const { store } = await requireStoreUser();
  const bank = readBankInfoMasked(store);
  return (
    <>
      <PageHeader title="振込先" description="店舗報酬のお振込先です。口座情報は暗号化して保管されます。" />
      <Card title="登録中の振込先">
        {bank ? (
          <dl className="grid gap-x-6 gap-y-3 text-[14px] sm:grid-cols-2">
            <Item k="銀行" v={`${bank.bankName}（${bank.bankCode}）`} />
            <Item k="支店" v={`${bank.branchName}（${bank.branchCode}）`} />
            <Item k="口座" v={`${bank.accountType} ${bank.accountNumber}`} />
            <Item k="口座名義" v={bank.accountHolder} />
            <Item k="最終更新" v={formatDateTimeJa(store.bankUpdatedAt)} />
          </dl>
        ) : (
          <p className="text-[13px] text-gold-200">振込先が未登録です。報酬をお受け取りいただくため、下のフォームから登録してください。</p>
        )}
      </Card>
      <Card title={bank ? "振込先を変更" : "振込先を登録"} className="mt-4">
        <BankForm action={updateBankAction} defaults={bank} />
      </Card>
    </>
  );
}

function Item({ k, v }: { k: string; v: string }) {
  return (
    <div>
      <dt className="text-[11px] text-ink-faint">{k}</dt>
      <dd className="mt-0.5">{v}</dd>
    </div>
  );
}
