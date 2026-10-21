/**
 * 無料の占い（テストモード・開発モード）の状態を入れる Cookie の署名と検証。
 * next/headers などに依存しない純粋な処理（単体テストで直接確認する）。
 *
 *  - 署名の鍵は SESSION_SECRET から用途ごとに派生させる（テストモード用と開発モード用は別の鍵 → Cookie を使い回せない）
 *  - SESSION_SECRET が安全な値でなければ、署名も検証もしない（無料の占いを提供しない）
 *  - 開発モードの Cookie は、作成した運営アカウントの ID と「ログイン中の端末（ログイン状態のハッシュ）」に結び付ける。
 *    ログアウト・別の人のログイン・パスワード変更で無効になる
 */
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { FortuneTypeValue } from "@/lib/db/schema";
import type { FortuneInput } from "@/lib/fortune/engine";
import { isSessionSecretStrong } from "@/lib/env-rules";

export type FreeMode = "test" | "development";

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
  /** 占った時刻（ミリ秒）。ラッキータイム等を同じ内容で再表示するため */
  at?: number;
  /** 結果の再生成用。ブラウザの HttpOnly Cookie にのみ保存し、サーバー/DBには保存しない */
  input?: FortuneInput;
  exp: number;
  /** 開発モード（SITE_STATUS=development）で作ったもの */
  mode?: "development";
  /** 開発モード: 作成した運営アカウントの ID */
  uid?: string;
  /** 開発モード: 作成したときのログイン状態に結び付ける値（ログイン状態のハッシュから派生。元には戻せない） */
  sid?: string;
};

export const FREE_COOKIE: Record<FreeMode, string> = { test: "fx_test", development: "fx_dev" };
/** テストモードの有効期限 */
export const TEST_TTL_MS = 24 * 60 * 60 * 1000;
/** 開発モードの有効期限（運営のログインより短くする） */
export const DEV_TTL_MS = 2 * 60 * 60 * 1000;

const MAX_COOKIE_LENGTH = 3000;

function key(mode: FreeMode, secret: string): Buffer {
  return createHmac("sha256", secret).update(`uranai-free-fortune:${mode}:v1`).digest();
}

/** ログイン状態のハッシュから、開発モードの Cookie に入れる結び付けの値を作る */
export function bindingFor(sessionHash: string): string {
  return createHash("sha256").update(`uranai-dev-bind:${sessionHash}`).digest("hex").slice(0, 32);
}

/** 署名して Cookie の値にする。SESSION_SECRET が安全でなければ null（保存しない） */
export function encodeFreeSession(s: TestSession, mode: FreeMode, secret: string | undefined): string | null {
  if (!secret || !isSessionSecretStrong({ SESSION_SECRET: secret })) return null;
  if ((mode === "development") !== (s.mode === "development")) return null;
  const body = Buffer.from(JSON.stringify(s)).toString("base64url");
  const sig = createHmac("sha256", key(mode, secret)).update(body).digest("base64url");
  return `${body}.${sig}`;
}

/**
 * Cookie の値を検証して取り出す。署名・形式・有効期限のどれかが正しくなければ null。
 * 開発モードでは、運営アカウントの ID とログイン状態が作成時と同じであることも確認する（binding）。
 */
export function decodeFreeSession(
  raw: string | undefined,
  mode: FreeMode,
  secret: string | undefined,
  binding?: { userId: string; sessionHash: string },
  now = Date.now(),
): TestSession | null {
  if (!secret || !isSessionSecretStrong({ SESSION_SECRET: secret })) return null;
  if (!raw || raw.length > MAX_COOKIE_LENGTH) return null;
  const [body, sig, extra] = raw.split(".");
  if (!body || !sig || extra !== undefined) return null;
  const expected = Buffer.from(createHmac("sha256", key(mode, secret)).update(body).digest("base64url"));
  const actual = Buffer.from(sig);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null;
  let s: TestSession;
  try {
    s = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as TestSession;
  } catch {
    return null;
  }
  if (!s || s.v !== 1 || typeof s.exp !== "number" || s.exp < now) return null;
  if (!["BIRTHDAY", "ZODIAC", "BLOOD"].includes(s.type)) return null;
  if (mode === "development") {
    if (s.mode !== "development" || !binding) return null;
    if (s.exp > now + DEV_TTL_MS) return null;
    if (s.uid !== binding.userId || s.sid !== bindingFor(binding.sessionHash)) return null;
  } else if (s.mode !== undefined) {
    return null;
  }
  return s;
}
