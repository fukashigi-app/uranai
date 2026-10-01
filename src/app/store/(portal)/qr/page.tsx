import { PageHeader } from "@/components/console/shell";
import { QrPanel } from "@/components/console/qr-panel";
import { requireStoreUser } from "@/lib/auth/session";
import { qrSvgDataUrl, storeUrl } from "@/lib/services/qr";

export const metadata = { title: "店舗QRコード" };

export default async function StoreQrPage() {
  const { store } = await requireStoreUser();
  return (
    <>
      <PageHeader title="店舗QRコード" description="お客様はこのQRコードから占いを利用できます。" />
      <QrPanel dataUrl={await qrSvgDataUrl(store.storeCode)} url={storeUrl(store.storeCode)} downloadHref="/api/store/qr" printHref="/store/qr/print" />
    </>
  );
}
