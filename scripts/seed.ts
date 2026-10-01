/**
 * 開発用デモデータ。`npm run db:seed`
 * 運営アカウント・デモ店舗・店舗スタッフを作成する（既存なら何もしない）。
 */
import "dotenv/config";
import { eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { stores, users } from "@/lib/db/schema";
import { createOperator, createStore, createStoreUser, updateBankInfo } from "@/lib/services/stores";

const SYSTEM = { userId: null, role: "SYSTEM" as const };

async function main() {
  if (process.env.NODE_ENV === "production") throw new Error("seed is for development only");
  const adminEmail = process.env.SEED_ADMIN_EMAIL ?? "admin@example.com";
  const adminPassword = process.env.SEED_ADMIN_PASSWORD ?? "AdminPass2026";
  const storeEmail = process.env.SEED_STORE_EMAIL ?? "store@example.com";
  const storePassword = process.env.SEED_STORE_PASSWORD ?? "StorePass2026";

  const [existingAdmin] = await db().select().from(users).where(eq(users.email, adminEmail));
  if (!existingAdmin) await createOperator({ name: "運営管理者", email: adminEmail, password: adminPassword });

  let [store] = await db().select().from(stores).where(eq(stores.name, "BAR Lune（デモ店舗）"));
  if (!store) {
    store = await createStore(
      { name: "BAR Lune（デモ店舗）", contactName: "月野 しずか", postalCode: "150-0001", address: "東京都渋谷区神宮前1-2-3 ルナビル2F", phone: "03-1234-5678", email: "lune@example.com" },
      SYSTEM,
    );
    await updateBankInfo(
      store.id,
      { bankName: "みずほ銀行", bankCode: "0001", branchName: "渋谷支店", branchCode: "210", accountType: "普通", accountNumber: "1234567", accountHolder: "カ）ルナ" },
      SYSTEM,
    );
    await createStoreUser(store.id, { name: "月野 しずか", email: storeEmail, password: storePassword }, SYSTEM);
  }
  const [cafe] = await db().select().from(stores).where(eq(stores.name, "Café Stella（デモ店舗）"));
  if (!cafe) {
    const c = await createStore({ name: "Café Stella（デモ店舗）", contactName: "星野 ひかり", postalCode: "530-0001", address: "大阪府大阪市北区梅田1-1-1", phone: "06-1234-5678", email: "stella@example.com" }, SYSTEM);
    await createStoreUser(c.id, { name: "星野 ひかり", email: "cafe@example.com", password: storePassword }, SYSTEM);
  }

  // デモ用の過去実績（開発環境のみ。mock の決済IDで作成）
  const [{ n }] = (await db().execute(sql`SELECT count(*)::int AS n FROM transactions WHERE store_id = ${store.id} AND provider_payment_id LIKE 'seed\_%'`)).rows as { n: number }[];
  if (n === 0 && process.env.SEED_DEMO_HISTORY !== "false") {
    await db().execute(sql`
      WITH src AS (
        SELECT g, now() - (g * interval '83 minutes') - interval '2 hours' AS paid_at,
          (ARRAY['BIRTHDAY','ZODIAC','BLOOD'])[1 + g % 3]::fortune_type AS ft
        FROM generate_series(1, 260) g
      ), co AS (
        INSERT INTO checkouts (store_id, fortune_type, amount, status, provider, provider_payment_id, access_token_hash, attempt_count, expires_at, created_at)
        SELECT ${store.id}, ft, 100, 'SUCCEEDED', 'mock', 'seed_' || g, md5('seed' || g || ${store.id}) || md5(g::text), 1, paid_at, paid_at FROM src
        RETURNING id, provider_payment_id, fortune_type, created_at
      )
      INSERT INTO transactions (checkout_id, payment_provider, provider_payment_id, store_id, fortune_type, amount, store_share, operator_share, payment_fee, store_share_bps, fortune_status, paid_at)
      SELECT id, 'mock', provider_payment_id, ${store.id}, fortune_type, 100, 30, 70, 4, 3000, 'COMPLETED', created_at FROM co`);
    console.log("  demo history: 260 transactions");
  }

  console.log("Seed completed");
  console.log(`  運営:   ${adminEmail} / ${adminPassword}  → /admin/login`);
  console.log(`  店舗:   ${storeEmail} / ${storePassword}  → /store/login`);
  console.log(`  QR URL: ${process.env.APP_URL}/s/${store.storeCode}`);
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
