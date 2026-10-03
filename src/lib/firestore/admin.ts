import "server-only";
import { cert, getApps, initializeApp, type App } from "firebase-admin/app";
import { getFirestore, Timestamp, type Firestore } from "firebase-admin/firestore";

/**
 * Firebase Admin SDK（サーバー専用）。秘密鍵は環境変数からのみ読み込み、コードやリポジトリには置かない。
 *
 *  FIREBASE_PROJECT_ID   … プロジェクトID
 *  FIREBASE_CLIENT_EMAIL … サービスアカウントのメールアドレス
 *  FIREBASE_PRIVATE_KEY  … サービスアカウントの秘密鍵（"\n" 表記・実際の改行のどちらでも可）
 *
 * FIRESTORE_EMULATOR_HOST がある場合は Emulator に接続（認証情報不要・本番に触れない）。
 */
const globalForFs = globalThis as unknown as { __uranaiFsApp?: App; __uranaiFs?: Firestore };

export function normalizePrivateKey(raw: string): string {
  let key = raw.trim();
  // 値全体を "..." で囲んで登録してしまった場合
  if ((key.startsWith('"') && key.endsWith('"')) || (key.startsWith("'") && key.endsWith("'"))) key = key.slice(1, -1);
  // "\n"（バックスラッシュ+n）表記を実際の改行に変換
  return key.replace(/\\n/g, "\n");
}

function initApp(): App {
  const existing = getApps().find((a) => a.name === "uranai");
  if (existing) return existing;
  const projectId = process.env.FIREBASE_PROJECT_ID || process.env.GCLOUD_PROJECT || "demo-uranai";
  if (process.env.FIRESTORE_EMULATOR_HOST) {
    return initializeApp({ projectId }, "uranai");
  }
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  const privateKey = process.env.FIREBASE_PRIVATE_KEY;
  if (!process.env.FIREBASE_PROJECT_ID || !clientEmail || !privateKey) {
    throw new Error("Firebase is not configured: FIREBASE_PROJECT_ID / FIREBASE_CLIENT_EMAIL / FIREBASE_PRIVATE_KEY are required");
  }
  return initializeApp({ credential: cert({ projectId, clientEmail, privateKey: normalizePrivateKey(privateKey) }), projectId }, "uranai");
}

export function fsdb(): Firestore {
  if (globalForFs.__uranaiFs) return globalForFs.__uranaiFs;
  const app = globalForFs.__uranaiFsApp ?? initApp();
  globalForFs.__uranaiFsApp = app;
  const db = getFirestore(app);
  // undefined のフィールドは保存しない（null は保存する）
  db.settings({ ignoreUndefinedProperties: true });
  globalForFs.__uranaiFs = db;
  return db;
}

/** Firestore の Timestamp / Date / 文字列を Date に変換（null はそのまま） */
export function toDate(v: unknown): Date | null {
  if (v == null) return null;
  if (v instanceof Date) return v;
  if (v instanceof Timestamp) return v.toDate();
  if (typeof v === "object" && v && "toDate" in v && typeof (v as { toDate: unknown }).toDate === "function") {
    return (v as { toDate: () => Date }).toDate();
  }
  const d = new Date(String(v));
  return Number.isNaN(d.getTime()) ? null : d;
}

export function mustDate(v: unknown): Date {
  return toDate(v) ?? new Date(0);
}

/** コレクション名（ここで一元管理） */
export const C = {
  users: "users",
  userEmails: "userEmails",
  authSessions: "authSessions",
  stores: "stores",
  storeCodes: "storeCodes",
  storeUsers: "storeUsers",
  checkouts: "checkouts",
  transactions: "transactions",
  fortuneSessions: "fortuneSessions",
  fortuneResults: "fortuneResults",
  settlements: "settlements",
  webhookEvents: "webhookEvents",
  auditLogs: "auditLogs",
  testFortuneLogs: "testFortuneLogs",
  rateLimits: "rateLimits",
  /** システム設定（system/initialSetup … 初回の運営アカウント作成が済んだ印） */
  system: "system",
} as const;

/** ドキュメントIDに使えない "/" を避ける */
export function safeId(...parts: string[]): string {
  return parts.map((p) => p.replace(/\//g, "_")).join("_");
}

/** 大量の書き込みを 400 件ずつに分けて実行 */
export async function inBatches<T>(items: T[], fn: (batch: FirebaseFirestore.WriteBatch, item: T) => void): Promise<void> {
  for (let i = 0; i < items.length; i += 400) {
    const batch = fsdb().batch();
    for (const it of items.slice(i, i + 400)) fn(batch, it);
    await batch.commit();
  }
}
