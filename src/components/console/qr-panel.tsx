import Link from "next/link";
import { Card } from "./shell";

export function QrPanel({ dataUrl, url, downloadHref, printHref }: { dataUrl: string; url: string; downloadHref: string; printHref: string }) {
  return (
    <Card>
      <div className="grid items-center gap-6 md:grid-cols-[260px_1fr]">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={dataUrl} alt="店舗専用QRコード" className="mx-auto w-full max-w-[260px] rounded-2xl bg-white p-3" />
        <div>
          <p className="text-[12px] text-ink-muted">店舗専用URL</p>
          <p className="mt-1 break-all rounded-xl border border-white/10 bg-night-950/50 px-3 py-2 font-mono text-[13px]">{url}</p>
          <div className="mt-5 flex flex-wrap gap-2">
            <a href={downloadHref} className="btn-gold inline-flex h-11 items-center rounded-xl px-5 text-sm font-bold">
              PNGで保存
            </a>
            <Link href={printHref} target="_blank" className="btn-ghost inline-flex h-11 items-center rounded-xl px-5 text-sm">
              印刷用デザイン
            </Link>
          </div>
          <ul className="mt-5 space-y-1 text-[12px] leading-relaxed text-ink-faint">
            <li>・テーブルやレジ横など、お客様の目に入りやすい場所に設置してください。</li>
            <li>・このQRから発生した利用・売上がすべて自店舗に計上されます。</li>
            <li>・QRを紛失・悪用された場合は運営にご連絡ください。再発行すると旧QRは無効になります。</li>
          </ul>
        </div>
      </div>
    </Card>
  );
}
