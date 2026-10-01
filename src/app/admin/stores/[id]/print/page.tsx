import { notFound } from "next/navigation";
import { eq } from "drizzle-orm";
import { PrintSheet } from "@/components/console/print-card";
import { requireOperator } from "@/lib/auth/session";
import { db } from "@/lib/db";
import { stores } from "@/lib/db/schema";
import { qrSvgDataUrl } from "@/lib/services/qr";

export const metadata = { title: "QR印刷", robots: { index: false } };

export default async function AdminQrPrintPage(props: PageProps<"/admin/stores/[id]/print">) {
  await requireOperator();
  const { id } = await props.params;
  if (!/^[0-9a-f-]{36}$/.test(id)) notFound();
  const [s] = await db().select().from(stores).where(eq(stores.id, id));
  if (!s) notFound();
  return <PrintSheet storeName={s.name} qrDataUrl={await qrSvgDataUrl(s.storeCode)} />;
}
