import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

/** 金額はすべて integer（円）。率は basis points の integer。 */

const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const updatedAt = () =>
  timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date());

export const userRole = pgEnum("user_role", ["OPERATOR", "STORE"]);
export const storeStatus = pgEnum("store_status", ["ACTIVE", "SUSPENDED"]);
export const storeUserRole = pgEnum("store_user_role", ["OWNER", "STAFF"]);
export const fortuneType = pgEnum("fortune_type", ["BIRTHDAY", "ZODIAC", "BLOOD"]);
export const checkoutStatus = pgEnum("checkout_status", [
  "CREATED", // 決済前
  "PROCESSING", // 決済代行へ請求中/Webhook待ち
  "SUCCEEDED", // Webhook等でサーバー確認済み
  "FAILED",
  "EXPIRED",
]);
export const paymentStatus = pgEnum("payment_status", ["SUCCEEDED", "REFUNDED"]);
export const fortuneStatus = pgEnum("fortune_status", ["PENDING", "COMPLETED", "EXPIRED"]);
export const fortuneSessionStatus = pgEnum("fortune_session_status", ["PAID", "USED", "EXPIRED"]);
export const settlementStatus = pgEnum("settlement_status", ["UNPAID", "PROCESSING", "PAID"]);

export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    email: varchar("email", { length: 254 }).notNull(),
    passwordHash: text("password_hash").notNull(),
    name: varchar("name", { length: 100 }).notNull(),
    role: userRole("role").notNull(),
    isActive: boolean("is_active").notNull().default(true),
    failedLoginCount: integer("failed_login_count").notNull().default(0),
    lockedUntil: timestamp("locked_until", { withTimezone: true }),
    lastLoginAt: timestamp("last_login_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("users_email_lower_uq").on(sql`lower(${t.email})`)],
);

export const authSessions = pgTable(
  "auth_sessions",
  {
    /** sha256(token) の hex。生トークンはDBに保存しない */
    id: varchar("id", { length: 64 }).primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("auth_sessions_user_idx").on(t.userId), index("auth_sessions_expires_idx").on(t.expiresAt)],
);

export const stores = pgTable(
  "stores",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** QRに載る推測困難なコード。秘密ではないが列挙困難 */
    storeCode: varchar("store_code", { length: 32 }).notNull(),
    name: varchar("name", { length: 100 }).notNull(),
    contactName: varchar("contact_name", { length: 100 }).notNull().default(""),
    postalCode: varchar("postal_code", { length: 8 }).notNull().default(""),
    address: varchar("address", { length: 300 }).notNull().default(""),
    phone: varchar("phone", { length: 20 }).notNull().default(""),
    email: varchar("email", { length: 254 }).notNull().default(""),
    status: storeStatus("status").notNull().default("ACTIVE"),
    storeShareBps: integer("store_share_bps").notNull().default(3000),
    /** 振込先(JSON)を AES-256-GCM で暗号化したもの */
    bankInfoEncrypted: text("bank_info_encrypted"),
    bankAccountLast4: varchar("bank_account_last4", { length: 4 }),
    bankUpdatedAt: timestamp("bank_updated_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("stores_store_code_uq").on(t.storeCode),
    index("stores_status_idx").on(t.status),
    index("stores_name_idx").on(t.name),
    check("stores_share_bps_range", sql`${t.storeShareBps} BETWEEN 0 AND 10000`),
  ],
);

export const storeUsers = pgTable(
  "store_users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    storeId: uuid("store_id")
      .notNull()
      .references(() => stores.id, { onDelete: "cascade" }),
    role: storeUserRole("role").notNull().default("OWNER"),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("store_users_user_store_uq").on(t.userId, t.storeId),
    index("store_users_store_idx").on(t.storeId),
  ],
);

export const checkouts = pgTable(
  "checkouts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    storeId: uuid("store_id")
      .notNull()
      .references(() => stores.id, { onDelete: "restrict" }),
    fortuneType: fortuneType("fortune_type").notNull(),
    amount: integer("amount").notNull(),
    status: checkoutStatus("status").notNull().default("CREATED"),
    provider: varchar("provider", { length: 20 }).notNull(),
    providerPaymentId: varchar("provider_payment_id", { length: 255 }),
    accessTokenHash: varchar("access_token_hash", { length: 64 }).notNull(),
    attemptCount: integer("attempt_count").notNull().default(0),
    failureCode: varchar("failure_code", { length: 100 }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    processingStartedAt: timestamp("processing_started_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("checkouts_provider_payment_uq").on(t.provider, t.providerPaymentId),
    uniqueIndex("checkouts_access_token_uq").on(t.accessTokenHash),
    index("checkouts_store_created_idx").on(t.storeId, t.createdAt),
    index("checkouts_status_idx").on(t.status, t.createdAt),
    check("checkouts_amount_positive", sql`${t.amount} > 0`),
  ],
);

export const transactions = pgTable(
  "transactions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    checkoutId: uuid("checkout_id")
      .notNull()
      .references(() => checkouts.id, { onDelete: "restrict" }),
    paymentProvider: varchar("payment_provider", { length: 20 }).notNull(),
    providerPaymentId: varchar("provider_payment_id", { length: 255 }).notNull(),
    storeId: uuid("store_id")
      .notNull()
      .references(() => stores.id, { onDelete: "restrict" }),
    fortuneType: fortuneType("fortune_type").notNull(),
    amount: integer("amount").notNull(),
    storeShare: integer("store_share").notNull(),
    operatorShare: integer("operator_share").notNull(),
    paymentFee: integer("payment_fee").notNull(),
    /** 計上時点の店舗配分率（後で率を変えても過去実績は不変） */
    storeShareBps: integer("store_share_bps").notNull(),
    paymentStatus: paymentStatus("payment_status").notNull().default("SUCCEEDED"),
    fortuneStatus: fortuneStatus("fortune_status").notNull().default("PENDING"),
    livemode: boolean("livemode").notNull().default(false),
    paidAt: timestamp("paid_at", { withTimezone: true }).notNull(),
    refundedAt: timestamp("refunded_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    // 同じ決済を二重計上しないための最重要制約
    uniqueIndex("transactions_provider_payment_uq").on(t.paymentProvider, t.providerPaymentId),
    uniqueIndex("transactions_checkout_uq").on(t.checkoutId),
    index("transactions_store_paid_idx").on(t.storeId, t.paidAt),
    index("transactions_paid_idx").on(t.paidAt),
    check("transactions_split_sum", sql`${t.storeShare} + ${t.operatorShare} = ${t.amount}`),
    check("transactions_amount_positive", sql`${t.amount} > 0`),
    check("transactions_nonneg", sql`${t.storeShare} >= 0 AND ${t.operatorShare} >= 0 AND ${t.paymentFee} >= 0`),
  ],
);

export const fortuneSessions = pgTable(
  "fortune_sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    transactionId: uuid("transaction_id")
      .notNull()
      .references(() => transactions.id, { onDelete: "restrict" }),
    storeId: uuid("store_id")
      .notNull()
      .references(() => stores.id, { onDelete: "restrict" }),
    fortuneType: fortuneType("fortune_type").notNull(),
    /** ブラウザの HttpOnly Cookie に入っているトークンの sha256 */
    tokenHash: varchar("token_hash", { length: 64 }).notNull(),
    status: fortuneSessionStatus("status").notNull().default("PAID"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    usedAt: timestamp("used_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("fortune_sessions_transaction_uq").on(t.transactionId),
    uniqueIndex("fortune_sessions_token_uq").on(t.tokenHash),
    index("fortune_sessions_status_expires_idx").on(t.status, t.expiresAt),
  ],
);

export type FortuneResultData = {
  title: string;
  subject: string;
  dateLabel: string;
  overall: { stars: number; comment: string };
  love: { stars: number; comment: string };
  work: { stars: number; comment: string };
  money: { stars: number; comment: string };
  /** 健康運（後から追加したため古い結果には無い） */
  health?: { stars: number; comment: string };
  luckyColor: { name: string; hex: string };
  luckyItem: string;
  luckyNumber: number;
  luckyTime: string;
  message: string;
  advice: string;
  traits?: string;
  /** 例: 「12星座中 3位」 */
  highlight?: string;
};

export const fortuneResults = pgTable(
  "fortune_results",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    fortuneSessionId: uuid("fortune_session_id")
      .notNull()
      .references(() => fortuneSessions.id, { onDelete: "cascade" }),
    storeId: uuid("store_id")
      .notNull()
      .references(() => stores.id, { onDelete: "restrict" }),
    fortuneType: fortuneType("fortune_type").notNull(),
    engine: varchar("engine", { length: 40 }).notNull(),
    result: jsonb("result").$type<FortuneResultData>().notNull(),
    viewableUntil: timestamp("viewable_until", { withTimezone: true }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("fortune_results_session_uq").on(t.fortuneSessionId),
    index("fortune_results_created_idx").on(t.createdAt),
  ],
);

export const settlements = pgTable(
  "settlements",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    storeId: uuid("store_id")
      .notNull()
      .references(() => stores.id, { onDelete: "restrict" }),
    yearMonth: varchar("year_month", { length: 7 }).notNull(),
    transactionCount: integer("transaction_count").notNull(),
    grossSales: integer("gross_sales").notNull(),
    storeShare: integer("store_share").notNull(),
    status: settlementStatus("status").notNull().default("UNPAID"),
    paidAt: timestamp("paid_at", { withTimezone: true }),
    note: text("note").notNull().default(""),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("settlements_store_month_uq").on(t.storeId, t.yearMonth),
    index("settlements_month_status_idx").on(t.yearMonth, t.status),
    check("settlements_year_month_format", sql`${t.yearMonth} ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'`),
  ],
);

export const webhookEvents = pgTable(
  "webhook_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    provider: varchar("provider", { length: 20 }).notNull(),
    eventId: varchar("event_id", { length: 255 }).notNull(),
    type: varchar("type", { length: 100 }).notNull(),
    processedAt: timestamp("processed_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("webhook_events_provider_event_uq").on(t.provider, t.eventId)],
);

export const auditLogs = pgTable(
  "audit_logs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    actorUserId: uuid("actor_user_id").references(() => users.id, { onDelete: "set null" }),
    actorRole: varchar("actor_role", { length: 20 }).notNull(),
    action: varchar("action", { length: 100 }).notNull(),
    targetType: varchar("target_type", { length: 50 }).notNull(),
    targetId: varchar("target_id", { length: 100 }),
    storeId: uuid("store_id").references(() => stores.id, { onDelete: "set null" }),
    before: jsonb("before"),
    after: jsonb("after"),
    createdAt: createdAt(),
  },
  (t) => [
    index("audit_logs_store_created_idx").on(t.storeId, t.createdAt),
    index("audit_logs_created_idx").on(t.createdAt),
  ],
);

/**
 * テストモード（ENABLE_TEST_PAYMENT=true）での無料占いの利用記録。
 * 売上（transactions）とは完全に別テーブル。個人情報（生年月日等）は保存しない。
 */
export const testFortuneLogs = pgTable(
  "test_fortune_logs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    storeCode: varchar("store_code", { length: 32 }).notNull(),
    fortuneType: fortuneType("fortune_type").notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("test_fortune_logs_created_idx").on(t.createdAt)],
);

export const rateLimits = pgTable(
  "rate_limits",
  {
    key: varchar("key", { length: 200 }).notNull(),
    windowStart: timestamp("window_start", { withTimezone: true }).notNull(),
    count: integer("count").notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.key, t.windowStart] })],
);

export type Store = typeof stores.$inferSelect;
export type User = typeof users.$inferSelect;
export type Transaction = typeof transactions.$inferSelect;
export type Settlement = typeof settlements.$inferSelect;
export type FortuneTypeValue = (typeof fortuneType.enumValues)[number];
