import "server-only";
import QRCode from "qrcode";
import { env } from "@/lib/env";

/** QRに載せるのは推測困難な店舗コード入りの公開URLのみ（秘密情報は含めない） */
export function storeUrl(storeCode: string): string {
  return `${env().APP_URL}/s/${storeCode}`;
}

export async function qrSvgDataUrl(storeCode: string, dark = "#0b1026"): Promise<string> {
  const svg = await QRCode.toString(storeUrl(storeCode), { type: "svg", margin: 1, errorCorrectionLevel: "M", color: { dark, light: "#ffffff" } });
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
}

export async function qrPng(storeCode: string, width = 1024): Promise<Buffer> {
  return QRCode.toBuffer(storeUrl(storeCode), { type: "png", width, margin: 2, errorCorrectionLevel: "M", color: { dark: "#0b1026", light: "#ffffff" } });
}
