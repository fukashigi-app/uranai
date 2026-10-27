import "server-only";
import { cert, getApps, initializeApp, type App } from "firebase-admin/app";
import { getFirestore, Timestamp, type Firestore } from "firebase-admin/firestore";
import { assertFirestoreTarget } from "./target-guard";
import { normalizePrivateKey } from "./private-key";

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

export { normalizePrivateKey };

function initApp(): App {
  // Preview から本番の Firebase プロジェクトに接続させない（判定できない場合も接続しない）
  assertFirestoreTarget();
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
  assertFirestoreTarget(); // 環境変数だけの判定なので毎回確認する（接続済みでも安全側に止める）
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
  /** 精算の調整（振込後の返金・異議申し立て・締め後の決済・繰越）。過去の取引・支払済みの精算は書き換えず、ここに記録する */
  settlementAdjustments: "settlementAdjustments",
  /** 決済要確認（署名を確認できた通知のうち、照合に失敗したもの・以前に確定した精算の変化など） */
  paymentReviews: "paymentReviews",
  /** 決済監視の異常（Webhook の失敗・確定待ちのままの注文・決済済みで権利なし など。種類・対象ごとに1件） */
  paymentAlerts: "paymentAlerts",
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
