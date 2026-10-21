import { NextResponse } from "next/server";
import { fortuneTypeFromSlug } from "@/lib/fortune/catalog";
import { devModeAccess } from "@/lib/services/dev-mode";
import {
  isFreeFortuneState,
  isSameHostRequest,
  isSecureRequest,
  isTestStoreCode,
  limitFreeFortune,
  newTestSession,
  resolveVisitorStore,
  saveTestSession,
  testModeState,
} from "@/lib/services/test-store";
import type { FortuneTypeValue } from "@/lib/db/schema";

const err = (status: number, code: string, message: string) =>
  NextResponse.json({ error: { code, message } }, { status, headers: { "Cache-Control": "no-store" } });

/**
 * 無料の占いを開始（決済をスキップ）。
 *  - テストモード（ENABLE_TEST_PAYMENT=true。ローカル・Preview）: 誰でも
 *  - 開発モード（SITE_STATUS=development）: 運営アカウントでログイン中の人だけ・テスト店舗（/s/test）だけ
 * それ以外は 404。決済・売上のテーブルには何も作らない。回数制限はサーバー側で適用する。
 */
export async function POST(req: Request) {
  const state = await testModeState();
  if (!isFreeFortuneState(state)) return err(404, "not_found", "テストモードは現在無効です。");
  if (!isSameHostRequest(req)) return err(403, "forbidden_origin", "不正なリクエストです。ページを再読み込みしてください。");

  const access = state === "dev" ? await devModeAccess() : null;
  if (access && !access.ok) return err(404, "not_found", "テストモードは現在無効です。");
  const limited = await limitFreeFortune(req, "test-fortune", 10, 60, access?.ok ? access.user.id : undefined);
  if (limited) return limited;

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
  if (access?.ok && (!store || !isTestStoreCode(store.storeCode))) {
    return err(403, "dev_test_store_only", "開発モードではテスト店舗（/s/test）だけ使えます。/s/test から始めてください。");
  }
  if (!store || store.status !== "ACTIVE") return err(403, "store_unavailable", "こちらの店舗では現在ご利用いただけません。");

  const session = newTestSession(store, type, access?.ok ? { userId: access.user.id, sessionHash: access.sessionHash } : undefined);
  if (!(await saveTestSession(session, isSecureRequest(req)))) return err(503, "unavailable", "ただいま利用できません。しばらくしてからお試しください。");
  return NextResponse.json({ ok: true, next: "/fortune/input" }, { headers: { "Cache-Control": "no-store" } });
}
