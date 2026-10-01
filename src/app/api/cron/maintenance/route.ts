import { NextResponse } from "next/server";
import { env } from "@/lib/env";
import { safeEqual } from "@/lib/security/crypto";
import { runMaintenance } from "@/lib/services/maintenance";

/** Vercel Cron 等から `Authorization: Bearer <CRON_SECRET>` で呼び出す */
export async function GET(req: Request) {
  const secret = env().CRON_SECRET;
  const auth = req.headers.get("authorization") ?? "";
  if (!secret || !safeEqual(auth, `Bearer ${secret}`)) {
    return new NextResponse("unauthorized", { status: 401 });
  }
  return NextResponse.json(await runMaintenance());
}
