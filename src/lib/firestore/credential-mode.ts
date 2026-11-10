/**
 * Firestore の接続の認証の種類（lib/firestore/admin.ts・/api/health から使う）。
 * firebase-admin を読み込まずに判定できるよう、他のモジュールに依存しない。
 */
export type FirebaseCredentialMode = "service-account-key" | "application-default";

/**
 * Firestore への接続に使う認証の種類（値は環境変数の名前・種類だけで判定し、秘密情報には触れない）。
 * 未設定・空なら従来どおり秘密鍵（service-account-key）。想定外の値は、黙って秘密鍵に戻さず停止する。
 */
export function firebaseCredentialMode(e: Record<string, string | undefined> = process.env): FirebaseCredentialMode {
  const v = (e.FIREBASE_CREDENTIALS ?? "").trim();
  if (v === "") return "service-account-key";
  if (v === "application-default") return "application-default";
  throw new Error("Firebase is misconfigured: FIREBASE_CREDENTIALS must be empty or application-default");
}
