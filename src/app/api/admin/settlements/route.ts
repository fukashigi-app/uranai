import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth/session";
import { listSettlements, SETTLEMENT_LABEL } from "@/lib/services/settlements";
import { getStoresByIds, readBankInfo } from "@/lib/services/stores";
import { writeAudit } from "@/lib/services/audit";
import { isValidYearMonth } from "@/lib/time";

/** 振込作業用CSV（運営のみ・ダウンロードは監査ログに記録） */
export async function GET(req: Request) {
  const user = await getSessionUser();
  if (!user || user.role !== "OPERATOR") return new NextResponse("not found", { status: 404 });
  const ym = new URL(req.url).searchParams.get("ym") ?? "";
  if (!isValidYearMonth(ym)) return new NextResponse("bad request", { status: 400 });
  const rows = await listSettlements({ yearMonth: ym });
  const storeRows = await getStoresByIds(rows.map((r) => r.s.storeId));
  const byId = new Map(storeRows.map((s) => [s.id, s]));
  const esc = (v: string | number) => {
    const s = String(v);
    // CSVインジェクション対策（= + - @ で始まるセルを無効化）。数値（調整のマイナスなど）は数式にならないのでそのまま
    const safe = typeof v !== "number" && /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
    return `"${safe.replace(/"/g, '""')}"`;
  };
  // 振込額は確定済み（処理中・支払済）の精算だけ。未払いは確定前のため空欄（確定時に未反映の調整を合わせて決まる）
  const header = ["対象月", "店舗名", "件数", "総売上", "店舗報酬", "保留", "調整", "繰越", "振込額", "状況", "銀行名", "金融機関コード", "支店名", "支店コード", "口座種別", "口座番号", "口座名義"];
  const lines = rows.map(({ s, storeName }) => {
    const store = byId.get(s.storeId);
    const b = store ? readBankInfo(store) : null;
    return [s.yearMonth, storeName, s.transactionCount, s.grossSales, s.storeShare, s.heldShare, s.adjustmentTotal, s.carryOver, s.payableAmount ?? "", SETTLEMENT_LABEL[s.status], b?.bankName ?? "", b?.bankCode ?? "", b?.branchName ?? "", b?.branchCode ?? "", b?.accountType ?? "", b?.accountNumber ?? "", b?.accountHolder ?? ""]
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
