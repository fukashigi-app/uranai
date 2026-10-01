import { NextResponse } from "next/server";
import { isTestPaymentEnabled } from "@/lib/env";
import { fortuneTypeFromSlug } from "@/lib/fortune/catalog";
import { isSameHostRequest, isSecureRequest, newTestSession, resolveVisitorStore, saveTestSession } from "@/lib/services/test-store";
import type { FortuneTypeValue } from "@/lib/db/schema";

const err = (status: number, code: string, message: string) =>
  NextResponse.json({ error: { code, message } }, { status, headers: { "Cache-Control": "no-store" } });

/**
 * テストモードで占いを開始（決済をスキップ）。ENABLE_TEST_PAYMENT=true 以外では 404。
 * 決済・売上のテーブルには何も作らない。
 */
export async function POST(req: Request) {
  if (!isTestPaymentEnabled()) return err(404, "not_found", "テストモードは現在無効です。");
  if (!isSameHostRequest(req)) return err(403, "forbidden_origin", "不正なリクエストです。ページを再読み込みしてください。");

  let body: { fortuneType?: unknown };
  try {
    body = (await req.json()) as { fortuneType?: unknown };
  } catch {
    return err(400, "invalid_request", "占いの種類を選び直してください。");
  }
  const raw = String(body.fortuneType ?? "");
  // "BIRTHDAY" / "birthday" のどちらでも受け付ける
  const type = (["BIRTHDAY", "ZODIAC", "BLOOD"].includes(raw) ? raw : fortuneTypeFromSlug(raw)) as FortuneTypeValue | null;
  if (!type) return err(400, "invalid_fortune_type", "占いの種類が正しくありません。最初からやり直してください。");

  let store;
  try {
    store = await resolveVisitorStore();
  } catch (e) {
    console.error("[test-fortune] store resolve failed", (e as Error).message);
    return err(503, "store_unavailable", "店舗情報を確認できませんでした。最初からやり直してください。");
  }
  if (!store || store.status !== "ACTIVE") return err(403, "store_unavailable", "こちらの店舗では現在ご利用いただけません。");

  await saveTestSession(newTestSession(store, type), isSecureRequest(req));
  return NextResponse.json({ ok: true, next: "/fortune/input" }, { headers: { "Cache-Control": "no-store" } });
}
