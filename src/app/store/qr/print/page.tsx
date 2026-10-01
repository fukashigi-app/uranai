import { PrintSheet } from "@/components/console/print-card";
import { requireStoreUser } from "@/lib/auth/session";
import { qrSvgDataUrl } from "@/lib/services/qr";

export const metadata = { title: "QR印刷", robots: { index: false } };

/** 管理画面レイアウトの外に置き、印刷用の全画面レイアウトにする */
export default async function StoreQrPrintPage() {
  const { store } = await requireStoreUser();
  return <PrintSheet storeName={store.name} qrDataUrl={await qrSvgDataUrl(store.storeCode)} />;
}
