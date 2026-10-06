import "server-only";
import { createHmac } from "node:crypto";

/**
 * 購入ごとに変わる部分の元になる値。占う権利（fortuneSession）の ID から作る。
 * 決済番号などをそのまま使わず秘密の値と混ぜるため、外部から結果の文章を推測できない。
 * （結果の★・レア度など固定部分には一切使わない）
 */
export function purchaseSeedFor(id: string): string {
  const secret = process.env.SESSION_SECRET || "uranai-fortune-purchase-seed";
  return createHmac("sha256", secret).update(`fortune-purchase:${id}`).digest("hex").slice(0, 32);
}
