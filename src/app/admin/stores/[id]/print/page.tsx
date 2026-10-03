import { notFound } from "next/navigation";
import { PrintSheet } from "@/components/console/print-card";
import { requireOperator } from "@/lib/auth/session";
import { getStoreById } from "@/lib/services/stores";
import { qrSvgDataUrl } from "@/lib/services/qr";

export const metadata = { title: "QR印刷", robots: { index: false } };

export default async function AdminQrPrintPage(props: PageProps<"/admin/stores/[id]/print">) {
  await requireOperator();
  const { id } = await props.params;
  if (!/^[0-9a-f-]{36}$/.test(id)) notFound();
  const s = await getStoreById(id);
  if (!s) notFound();
  return <PrintSheet storeName={s.name} qrDataUrl={await qrSvgDataUrl(s.storeCode)} />;
}
