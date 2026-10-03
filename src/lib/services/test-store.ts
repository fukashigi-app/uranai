import "server-only";
import { cookies } from "next/headers";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { FortuneTypeValue } from "@/lib/db/schema";
import type { FortuneInput } from "@/lib/fortune/engine";
import { isTestPaymentEnabled } from "@/lib/env";
import { hasDatabase, isFirestore } from "@/lib/data-provider";
import { getQrStoreCode } from "@/lib/cookies";

/**
 * ===== テストモード（ENABLE_TEST_PAYMENT=true のときだけ有効）=====
 *
 * - 決済をスキップして 選択 → 入力 → 占い → 結果 まで無料で体験できる
 * - 決済・売上テーブル（checkouts / transactions / fortune_sessions）には一切書き込まない
 *   → 本番の売上・店舗報酬・運営売上に混入しない
 * - 利用状況は test_fortune_logs（テスト専用テーブル）にだけ記録（DBが無くても動作は止めない）
 * - 状態は署名付きの HttpOnly Cookie に保存するため、DB未接続でも動き、再読み込みしても続きから再開できる
 * - ENABLE_TEST_PAYMENT を false にすると、テスト用の入口・Cookie はすべて無効になる
 */

/** 開発用テスト店舗（/s/test）。DBには登録しない仮想店舗 */
export const TEST_STORE = { storeCode: "test", name: "テスト店舗", status: "ACTIVE" as const };
/** 以前のテストモードで作られた店舗コード。テストモード OFF では利用不可 */
export const LEGACY_TEST_STORE_CODE = "testmode0001";

export function isTestStoreCode(code: string): boolean {
  return code === TEST_STORE.storeCode || code === LEGACY_TEST_STORE_CODE;
}

const COOKIE = "fx_test";
const TTL_MS = 24 * 60 * 60 * 1000;

export type TestSession = {
  v: 1;
  id: string;
  storeCode: string;
  storeName: string;
  type: FortuneTypeValue;
  /** ready = 入力待ち / done = 占い済み（結果を再表示） */
  status: "ready" | "done";
  /** 占った日（JST）。結果を同じ内容で再表示するため */
  date?: string;
  /** 結果の再生成用。ブラウザの HttpOnly Cookie にのみ保存し、サーバー/DBには保存しない */
  input?: FortuneInput;
  exp: number;
};

function secret(): string {
  // SESSION_SECRET 未設定でもテストモードは動かす（テスト用Cookieの改ざん防止のみが目的）
  return process.env.SESSION_SECRET || `uranai-test-mode:${process.env.VERCEL_PROJECT_PRODUCTION_URL ?? "local"}`;
}

function sign(body: string): string {
  return createHmac("sha256", secret()).update(body).digest("base64url");
}

function encode(s: TestSession): string {
  const body = Buffer.from(JSON.stringify(s)).toString("base64url");
  return `${body}.${sign(body)}`;
}

function decode(raw: string | undefined): TestSession | null {
  if (!raw || raw.length > 3000) return null;
  const [body, sig] = raw.split(".");
  if (!body || !sig) return null;
  const expected = Buffer.from(sign(body));
  const actual = Buffer.from(sig);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null;
  try {
    const s = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as TestSession;
    if (s.v !== 1 || s.exp < Date.now()) return null;
    if (!["BIRTHDAY", "ZODIAC", "BLOOD"].includes(s.type)) return null;
    return s;
  } catch {
    return null;
  }
}

/** 有効なテストセッション（テストモード OFF のときは常に null） */
export async function getTestSession(): Promise<TestSession | null> {
  if (!isTestPaymentEnabled()) return null;
  return decode((await cookies()).get(COOKIE)?.value);
}

export async function saveTestSession(s: TestSession, secure: boolean): Promise<void> {
  (await cookies()).set(COOKIE, encode(s), { httpOnly: true, secure, sameSite: "lax", path: "/", maxAge: TTL_MS / 1000 });
}

export function newTestSession(store: { storeCode: string; name: string }, type: FortuneTypeValue): TestSession {
  return { v: 1, id: randomBytes(8).toString("hex"), storeCode: store.storeCode, storeName: store.name, type, status: "ready", exp: Date.now() + TTL_MS };
}

/** リクエストが HTTPS か（Vercel は常に https） */
export function isSecureRequest(req: Request): boolean {
  const proto = req.headers.get("x-forwarded-proto")?.split(",")[0]?.trim() ?? new URL(req.url).protocol.replace(":", "");
  return proto === "https";
}

/** テスト利用を記録（テスト専用テーブル）。DB未設定・障害時は記録をあきらめて占いは続行 */
export async function logTestFortune(storeCode: string, type: FortuneTypeValue): Promise<void> {
  if (!hasDatabase()) return;
  try {
    if (isFirestore()) {
      const { logTestFortune: fsLog } = await import("@/lib/firestore/misc");
      await fsLog(storeCode, type);
      return;
    }
    const { db } = await import("@/lib/db");
    const { testFortuneLogs } = await import("@/lib/db/schema");
    await db().insert(testFortuneLogs).values({ storeCode: storeCode.slice(0, 32), fortuneType: type });
  } catch (e) {
    console.warn("[test-mode] failed to record test usage", (e as Error).message);
  }
}

export type VisitorStore = { storeCode: string; name: string; status: "ACTIVE" | "SUSPENDED" };

/**
 * 利用者の店舗を決める。QR（qr_store Cookie）が最優先。
 * - テストモード: QRなし or /s/test → テスト店舗。実店舗QRも利用可（テスト利用として記録、売上には入らない）
 * - 本番: QR必須。テスト店舗は利用不可
 */
export async function resolveVisitorStore(): Promise<VisitorStore | null> {
  const code = await getQrStoreCode();
  const test = isTestPaymentEnabled();
  if (!code || isTestStoreCode(code)) return test ? TEST_STORE : null;
  const { findActiveStoreByCode } = await import("./checkout");
  try {
    return await findActiveStoreByCode(code);
  } catch (e) {
    // テストモードでは DB に繋がらなくてもテスト店舗で体験できるようにする
    if (test) return TEST_STORE;
    throw e;
  }
}

/** CSRF対策（テストモード用・設定に依存しない）: Origin/Referer がリクエスト先と同じホストか */
export function isSameHostRequest(req: Request): boolean {
  const host = (req.headers.get("x-forwarded-host") ?? req.headers.get("host") ?? "").split(",")[0].trim();
  const src = req.headers.get("origin") ?? req.headers.get("referer");
  if (!host || !src) return false;
  try {
    return new URL(src).host === host;
  } catch {
    return false;
  }
}
