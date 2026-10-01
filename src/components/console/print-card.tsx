import { siteConfig, DISPLAY_PRICE_JPY } from "@/config/site";
import { MoonMark } from "@/components/ui/logo";
import { PrintButton } from "./print-button";

/** 印刷用POP（A6サイズ想定・複数枚面付け） */
export function PrintSheet({ storeName, qrDataUrl, copies = 4 }: { storeName: string; qrDataUrl: string; copies?: number }) {
  return (
    <div className="min-h-dvh bg-neutral-200 py-6 print:bg-white print:py-0">
      <div className="no-print mx-auto mb-4 flex max-w-[210mm] items-center justify-between px-4 text-sm text-neutral-700">
        <span>A4用紙に4枚（A6サイズ）を面付けしています。切り取ってご利用ください。</span>
        <PrintButton />
      </div>
      <div className="mx-auto grid w-[210mm] grid-cols-2 bg-white print:w-full">
        {Array.from({ length: copies }, (_, i) => (
          <div key={i} className="flex h-[148mm] flex-col items-center justify-between border border-dashed border-neutral-300 bg-[#0b1026] px-8 py-9 text-center text-white [print-color-adjust:exact] [-webkit-print-color-adjust:exact]">
            <div className="flex flex-col items-center">
              <MoonMark className="h-10 w-10" />
              <p className="mt-2 font-serif text-[22px] font-bold tracking-wider text-[#ecd9a6]">{siteConfig.name}</p>
              <p className="mt-1 text-[11px] tracking-[0.2em] text-[#a7acc8]">TODAY&apos;S FORTUNE</p>
            </div>
            <div>
              <p className="font-serif text-[17px] leading-relaxed">
                QRを読み込んで
                <br />
                今日の運勢をチェック
              </p>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={qrDataUrl} alt="QRコード" className="mx-auto mt-4 h-[52mm] w-[52mm] rounded-xl bg-white p-2" />
            </div>
            <div>
              <p className="text-[13px] text-[#ecd9a6]">
                生年月日・星座・血液型 ／ 1回 <span className="text-[20px] font-bold">{DISPLAY_PRICE_JPY}</span>円
              </p>
              <p className="mt-1 text-[10px] text-[#a7acc8]">{storeName}</p>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
