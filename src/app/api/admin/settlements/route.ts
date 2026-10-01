import { NextResponse } from "next/server";
import { inArray } from "drizzle-orm";
import { getSessionUser } from "@/lib/auth/session";
import { db } from "@/lib/db";
import { stores } from "@/lib/db/schema";
import { listSettlements, SETTLEMENT_LABEL } from "@/lib/services/settlements";
import { readBankInfo } from "@/lib/services/stores";
import { writeAudit } from "@/lib/services/audit";
import { isValidYearMonth } from "@/lib/time";

/** 振込作業用CSV（運営のみ・ダウンロードは監査ログに記録） */
export async function GET(req: Request) {
  const user = await getSessionUser();
  if (!user || user.role !== "OPERATOR") return new NextResponse("not found", { status: 404 });
  const ym = new URL(req.url).searchParams.get("ym") ?? "";
  if (!isValidYearMonth(ym)) return new NextResponse("bad request", { status: 400 });
  const rows = await listSettlements({ yearMonth: ym });
  const storeRows = rows.length ? await db().select().from(stores).where(inArray(stores.id, rows.map((r) => r.s.storeId))) : [];
  const byId = new Map(storeRows.map((s) => [s.id, s]));
  const esc = (v: string | number) => {
    const s = String(v);
    // CSVインジェクション対策（= + - @ で始まるセルを無効化）
    const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
    return `"${safe.replace(/"/g, '""')}"`;
  };
  const header = ["対象月", "店舗名", "件数", "総売上", "店舗報酬", "状況", "銀行名", "金融機関コード", "支店名", "支店コード", "口座種別", "口座番号", "口座名義"];
  const lines = rows.map(({ s, storeName }) => {
    const store = byId.get(s.storeId);
    const b = store ? readBankInfo(store) : null;
    return [s.yearMonth, storeName, s.transactionCount, s.grossSales, s.storeShare, SETTLEMENT_LABEL[s.status], b?.bankName ?? "", b?.bankCode ?? "", b?.branchName ?? "", b?.branchCode ?? "", b?.accountType ?? "", b?.accountNumber ?? "", b?.accountHolder ?? ""]
      .map(esc)
      .join(",");
  });
  await writeAudit({ actorUserId: user.id, actorRole: "OPERATOR", action: "settlement.csv.export", targetType: "settlement", targetId: ym });
  const body = "﻿" + [header.map(esc).join(","), ...lines].join("\r\n");
  return new NextResponse(body, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="settlements-${ym}.csv"`,
      "Cache-Control": "private, no-store",
    },
  });
}
