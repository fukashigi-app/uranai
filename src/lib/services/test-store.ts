import "server-only";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { stores } from "@/lib/db/schema";
import { isTestPaymentEnabled } from "@/lib/env";
import { getQrStoreCode } from "@/lib/cookies";
import { findActiveStoreByCode } from "./checkout";

/**
 * 開発・動作確認用のテスト店舗。ENABLE_TEST_PAYMENT=true のときだけ利用できる。
 * テストモードを無効にすると、この店舗では決済を開始できなくなる。
 */
export const TEST_STORE_CODE = "testmode0001";
export const TEST_STORE_NAME = "テスト店舗（動作確認用）";

export function isTestStoreCode(code: string): boolean {
  return code === TEST_STORE_CODE;
}

/** テスト店舗を（なければ）作成して返す */
export async function ensureTestStore() {
  const existing = await findActiveStoreByCode(TEST_STORE_CODE);
  if (existing) return existing;
  await db()
    .insert(stores)
    .values({ storeCode: TEST_STORE_CODE, name: TEST_STORE_NAME, contactName: "テスト", status: "ACTIVE" })
    .onConflictDoNothing();
  const [created] = await db()
    .select({ id: stores.id, name: stores.name, status: stores.status, storeCode: stores.storeCode })
    .from(stores)
    .where(eq(stores.storeCode, TEST_STORE_CODE));
  return created;
}

/**
 * 利用者の店舗を決める。QR（qr_store Cookie）が最優先。
 * QRがない場合、テストモード時のみテスト店舗を使う（本番ではQR必須）。
 */
export async function resolveVisitorStore() {
  const code = await getQrStoreCode();
  if (code) {
    const store = await findActiveStoreByCode(code);
    if (store && !(isTestStoreCode(store.storeCode) && !isTestPaymentEnabled())) return store;
  }
  if (isTestPaymentEnabled()) return ensureTestStore();
  return null;
}
