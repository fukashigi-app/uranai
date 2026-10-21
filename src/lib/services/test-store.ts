import "server-only";
import { cookies } from "next/headers";
import { randomBytes } from "node:crypto";
import type { FortuneTypeValue } from "@/lib/db/schema";
import { isSessionSecretStrong, isTestPaymentEnabled, serviceStopReason } from "@/lib/env";
import { hasDatabase, isFirestore } from "@/lib/data-provider";
import { getQrStoreCode } from "@/lib/cookies";
import { purchaseSeedFor } from "@/lib/fortune/seed";
import { jsonError } from "@/lib/api";
import { rateLimit } from "@/lib/security/rate-limit";
import { clientKey } from "@/lib/security/request";
import { devModeAccess } from "./dev-mode";
import { bindingFor, decodeFreeSession, DEV_TTL_MS, encodeFreeSession, FREE_COOKIE, TEST_TTL_MS, type TestSession } from "./free-session-token";

export type { TestSession } from "./free-session-token";

/**
 * ===== 無料の占い（テストモード・開発モード）=====
 *
 * テストモード（ENABLE_TEST_PAYMENT=true。ローカル・Preview だけ）
 * - 決済をスキップして 選択 → 入力 → 占い → 結果 まで無料で体験できる（誰でも）
 * - Vercel の本番では、ENABLE_TEST_PAYMENT=true でも誰にも提供せず、占いの受付を停止する（testModeState）
 *
 * 開発モード（SITE_STATUS=development。本番でも使える）
 * - 運営アカウント（OPERATOR）でログイン中の人だけ、テスト店舗（/s/test）で無料の占いを確認できる（lib/services/dev-mode.ts）
 * - 一般の方・店舗アカウントには準備中を表示する。決済は誰に対しても受け付けない
 *
 * 共通
 * - 決済・売上のデータ（checkouts / transactions / fortune_sessions / fortune_results）には一切書き込まない
 *   → 売上・店舗の取り分・運営の取り分・月次精算は 0 円（集計の対象になるデータを作らない）
 * - 利用状況は test_fortune_logs（テスト専用）にだけ記録。開発モードの記録には mode: "development" を付ける（Firestore）
 * - 状態は署名付きの HttpOnly Cookie に保存する。SESSION_SECRET が安全な値でなければ無料の占いは提供しない
 * - 回数制限はサーバー側で適用する（limitFreeFortune）
 */

/** 開発用テスト店舗（/s/test）。DBには登録しない仮想店舗 */
export const TEST_STORE = { storeCode: "test", name: "テスト店舗", status: "ACTIVE" as const };
/** 以前のテストモードで作られた店舗コード。テストモード OFF では利用不可 */
export const LEGACY_TEST_STORE_CODE = "testmode0001";

export function isTestStoreCode(code: string): boolean {
  return code === TEST_STORE.storeCode || code === LEGACY_TEST_STORE_CODE;
}

/**
 * 無料テストモードと占いの受付の状態（設定と、開発モードではログイン中のアカウントで決まる）。
 *  off         … テストモードではない（通常の有料フロー）
 *  on          … 開発・Preview・ローカルのテストモード（誰でも無料で体験できる）
 *  dev         … 開発モードで、運営アカウントでログイン中（テスト店舗で無料の占いを確認できる。決済は受け付けない）
 *  development … 開発モードで、運営アカウント以外（一般の方・店舗アカウント）。準備中として扱う
 *  halted      … 危険な設定（本番の ENABLE_TEST_PAYMENT=true・PAYMENT_PROVIDER=mock、開発モードでの本番用決済キー）が残っている。
 *                運営・店舗アカウントを含め、無料テストも有料の決済も提供しない（安全側で停止。本番の決済へ自動で切り替えない）
 *  coming_soon … 準備中モード（SITE_STATUS=coming_soon）。無料テスト・有料の決済とも提供しない（正常な運用状態）
 */
export type TestModeState = "off" | "on" | "dev" | "development" | "halted" | "coming_soon";

export async function testModeState(): Promise<TestModeState> {
  const stop = serviceStopReason();
  if (stop === "dangerous_config") return "halted";
  if (stop === "development") return (await devModeAccess()).ok ? "dev" : "development";
  if (stop === "coming_soon") return "coming_soon";
  // SESSION_SECRET が安全でなければ、無料の占いは提供しない（Cookie の改ざんを防げないため）
  return isTestPaymentEnabled() && isSessionSecretStrong() ? "on" : "off";
}

/** 一般向けの占いの受付を止めている状態か（危険な設定・準備中・開発モードの運営以外） */
export function isServiceStopped(state: TestModeState): state is "halted" | "coming_soon" | "development" {
  return state === "halted" || state === "coming_soon" || state === "development";
}

/** 無料の占いを提供する状態か（テストモード・開発モードの運営） */
export function isFreeFortuneState(state: TestModeState): state is "on" | "dev" {
  return state === "on" || state === "dev";
}

/** 無料テストを利用できるか */
export async function isTestModeActive(): Promise<boolean> {
  return isFreeFortuneState(await testModeState());
}

/**
 * 有効な無料の占いの状態（利用できないときは常に null）。
 * 開発モードでは、運営アカウント・ログイン状態・テスト店舗であることを毎回確認する。
 */
export async function getTestSession(): Promise<TestSession | null> {
  const state = await testModeState();
  const jar = await cookies();
  if (state === "on") return decodeFreeSession(jar.get(FREE_COOKIE.test)?.value, "test", process.env.SESSION_SECRET);
  if (state === "dev") {
    const access = await devModeAccess();
    if (!access.ok) return null;
    const s = decodeFreeSession(jar.get(FREE_COOKIE.development)?.value, "development", process.env.SESSION_SECRET, {
      userId: access.user.id,
      sessionHash: access.sessionHash,
    });
    return s && isTestStoreCode(s.storeCode) ? s : null;
  }
  return null;
}

/** 保存する。SESSION_SECRET が安全でないなど、署名できないときは false（保存しない） */
export async function saveTestSession(s: TestSession, secure: boolean): Promise<boolean> {
  const mode = s.mode === "development" ? "development" : "test";
  const value = encodeFreeSession(s, mode, process.env.SESSION_SECRET);
  if (!value) return false;
  const maxAge = Math.max(1, Math.floor((s.exp - Date.now()) / 1000));
  (await cookies()).set(FREE_COOKIE[mode], value, { httpOnly: true, secure, sameSite: "lax", path: "/", maxAge });
  return true;
}

/**
 * 新しい無料の占いの状態。dev を渡すと開発モード用（運営アカウントとログイン状態に結び付け、有効期限は2時間）。
 */
export function newTestSession(store: { storeCode: string; name: string }, type: FortuneTypeValue, dev?: { userId: string; sessionHash: string }): TestSession {
  const base = { v: 1 as const, id: randomBytes(8).toString("hex"), storeCode: store.storeCode, storeName: store.name, type, status: "ready" as const };
  if (dev) return { ...base, exp: Date.now() + DEV_TTL_MS, mode: "development", uid: dev.userId, sid: bindingFor(dev.sessionHash) };
  return { ...base, exp: Date.now() + TEST_TTL_MS };
}

/**
 * 無料の占いの回数制限（サーバー側・既存の rateLimit を使う）。超えたら 429、制限を確認できなければ 503 の応答を返す。
 * 接続元（IP をハッシュ化したもの）ごとに数え、開発モードでは運営アカウントごとにも数える。
 * データベースが無いのはローカル・Preview のテストモードだけ（開発モードはログインの確認にデータベースが必須）で、そのときは数えない。
 */
export async function limitFreeFortune(req: Request, bucket: string, limit: number, windowSec: number, userId?: string): Promise<Response | null> {
  if (!hasDatabase()) {
    if (userId) return jsonError(503, "unavailable", "ただいま利用できません。しばらくしてからお試しください。");
    return null;
  }
  try {
    const keys = [`${bucket}:${clientKey(req.headers)}`];
    if (userId) keys.push(`${bucket}:user:${userId}`);
    for (const k of keys) {
      if (!(await rateLimit(k, limit, windowSec))) {
        return jsonError(429, "rate_limited", "短時間に何度もお試しいただいたため、少し時間をおいてから再度お試しください。");
      }
    }
    return null;
  } catch (e) {
    console.error("[free-fortune] rate limit check failed", (e as Error).name);
    return jsonError(503, "unavailable", "ただいま利用できません。しばらくしてからお試しください。");
  }
}

/**
 * テストモードの結果を作る条件。テストセッションIDを「購入ごとの値」として使うため、
 * テストをやり直すと本番の再購入と同じように文章・ラッキー系だけが変わる（★・レア度は同じ）。
 */
export function testGenerateContext(s: TestSession): { now: Date; purchaseSeed: string } {
  const now = s.at ? new Date(s.at) : new Date(`${s.date}T12:00:00+09:00`);
  return { now, purchaseSeed: purchaseSeedFor(`test:${s.id}`) };
}

/** リクエストが HTTPS か（Vercel は常に https） */
export function isSecureRequest(req: Request): boolean {
  const proto = req.headers.get("x-forwarded-proto")?.split(",")[0]?.trim() ?? new URL(req.url).protocol.replace(":", "");
  return proto === "https";
}

/** テスト利用を記録（テスト専用テーブル）。DB未設定・障害時は記録をあきらめて占いは続行 */
export async function logTestFortune(storeCode: string, type: FortuneTypeValue, mode?: "development"): Promise<void> {
  if (!hasDatabase()) return;
  try {
    if (isFirestore()) {
      const { logTestFortune: fsLog } = await import("@/lib/firestore/misc");
      await fsLog(storeCode, type, mode);
      return;
    }
    // PostgreSQL 版はテーブルの変更を避けるため mode を記録しない（開発モードは Firestore での運用を前提にする）
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
 * - 開発モード（運営）: テスト店舗だけ。実店舗の QR では null
 * - テストモード: QRなし or /s/test → テスト店舗。実店舗QRも利用可（テスト利用として記録、売上には入らない）
 * - 本番: QR必須。テスト店舗は利用不可
 */
export async function resolveVisitorStore(): Promise<VisitorStore | null> {
  const code = await getQrStoreCode();
  const state = await testModeState();
  // 開発モードではテスト店舗だけ（実店舗の QR では無料の占いを使わない＝実店舗の利用件数に入らない）
  if (state === "dev") return !code || isTestStoreCode(code) ? TEST_STORE : null;
  const test = state === "on";
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
