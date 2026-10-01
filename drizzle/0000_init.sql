CREATE TYPE "public"."checkout_status" AS ENUM('CREATED', 'PROCESSING', 'SUCCEEDED', 'FAILED', 'EXPIRED');--> statement-breakpoint
CREATE TYPE "public"."fortune_session_status" AS ENUM('PAID', 'USED', 'EXPIRED');--> statement-breakpoint
CREATE TYPE "public"."fortune_status" AS ENUM('PENDING', 'COMPLETED', 'EXPIRED');--> statement-breakpoint
CREATE TYPE "public"."fortune_type" AS ENUM('BIRTHDAY', 'ZODIAC', 'BLOOD');--> statement-breakpoint
CREATE TYPE "public"."payment_status" AS ENUM('SUCCEEDED', 'REFUNDED');--> statement-breakpoint
CREATE TYPE "public"."settlement_status" AS ENUM('UNPAID', 'PROCESSING', 'PAID');--> statement-breakpoint
CREATE TYPE "public"."store_status" AS ENUM('ACTIVE', 'SUSPENDED');--> statement-breakpoint
CREATE TYPE "public"."store_user_role" AS ENUM('OWNER', 'STAFF');--> statement-breakpoint
CREATE TYPE "public"."user_role" AS ENUM('OPERATOR', 'STORE');--> statement-breakpoint
CREATE TABLE "audit_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"actor_user_id" uuid,
	"actor_role" varchar(20) NOT NULL,
	"action" varchar(100) NOT NULL,
	"target_type" varchar(50) NOT NULL,
	"target_id" varchar(100),
	"store_id" uuid,
	"before" jsonb,
	"after" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "auth_sessions" (
	"id" varchar(64) PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "checkouts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"store_id" uuid NOT NULL,
	"fortune_type" "fortune_type" NOT NULL,
	"amount" integer NOT NULL,
	"status" "checkout_status" DEFAULT 'CREATED' NOT NULL,
	"provider" varchar(20) NOT NULL,
	"provider_payment_id" varchar(255),
	"access_token_hash" varchar(64) NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"failure_code" varchar(100),
	"expires_at" timestamp with time zone NOT NULL,
	"processing_started_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "checkouts_amount_positive" CHECK ("checkouts"."amount" > 0)
);
--> statement-breakpoint
CREATE TABLE "fortune_results" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"fortune_session_id" uuid NOT NULL,
	"store_id" uuid NOT NULL,
	"fortune_type" "fortune_type" NOT NULL,
	"engine" varchar(40) NOT NULL,
	"result" jsonb NOT NULL,
	"viewable_until" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "fortune_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"transaction_id" uuid NOT NULL,
	"store_id" uuid NOT NULL,
	"fortune_type" "fortune_type" NOT NULL,
	"token_hash" varchar(64) NOT NULL,
	"status" "fortune_session_status" DEFAULT 'PAID' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rate_limits" (
	"key" varchar(200) NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	"count" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "rate_limits_key_window_start_pk" PRIMARY KEY("key","window_start")
);
--> statement-breakpoint
CREATE TABLE "settlements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"store_id" uuid NOT NULL,
	"year_month" varchar(7) NOT NULL,
	"transaction_count" integer NOT NULL,
	"gross_sales" integer NOT NULL,
	"store_share" integer NOT NULL,
	"status" "settlement_status" DEFAULT 'UNPAID' NOT NULL,
	"paid_at" timestamp with time zone,
	"note" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "settlements_year_month_format" CHECK ("settlements"."year_month" ~ '^[0-9]{4}-(0[1-9]|1[0-2])$')
);
--> statement-breakpoint
CREATE TABLE "store_users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"store_id" uuid NOT NULL,
	"role" "store_user_role" DEFAULT 'OWNER' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "stores" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"store_code" varchar(32) NOT NULL,
	"name" varchar(100) NOT NULL,
	"contact_name" varchar(100) DEFAULT '' NOT NULL,
	"postal_code" varchar(8) DEFAULT '' NOT NULL,
	"address" varchar(300) DEFAULT '' NOT NULL,
	"phone" varchar(20) DEFAULT '' NOT NULL,
	"email" varchar(254) DEFAULT '' NOT NULL,
	"status" "store_status" DEFAULT 'ACTIVE' NOT NULL,
	"store_share_bps" integer DEFAULT 3000 NOT NULL,
	"bank_info_encrypted" text,
	"bank_account_last4" varchar(4),
	"bank_updated_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "stores_share_bps_range" CHECK ("stores"."store_share_bps" BETWEEN 0 AND 10000)
);
--> statement-breakpoint
CREATE TABLE "transactions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"checkout_id" uuid NOT NULL,
	"payment_provider" varchar(20) NOT NULL,
	"provider_payment_id" varchar(255) NOT NULL,
	"store_id" uuid NOT NULL,
	"fortune_type" "fortune_type" NOT NULL,
	"amount" integer NOT NULL,
	"store_share" integer NOT NULL,
	"operator_share" integer NOT NULL,
	"payment_fee" integer NOT NULL,
	"store_share_bps" integer NOT NULL,
	"payment_status" "payment_status" DEFAULT 'SUCCEEDED' NOT NULL,
	"fortune_status" "fortune_status" DEFAULT 'PENDING' NOT NULL,
	"livemode" boolean DEFAULT false NOT NULL,
	"paid_at" timestamp with time zone NOT NULL,
	"refunded_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "transactions_split_sum" CHECK ("transactions"."store_share" + "transactions"."operator_share" = "transactions"."amount"),
	CONSTRAINT "transactions_amount_positive" CHECK ("transactions"."amount" > 0),
	CONSTRAINT "transactions_nonneg" CHECK ("transactions"."store_share" >= 0 AND "transactions"."operator_share" >= 0 AND "transactions"."payment_fee" >= 0)
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" varchar(254) NOT NULL,
	"password_hash" text NOT NULL,
	"name" varchar(100) NOT NULL,
	"role" "user_role" NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"failed_login_count" integer DEFAULT 0 NOT NULL,
	"locked_until" timestamp with time zone,
	"last_login_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "webhook_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" varchar(20) NOT NULL,
	"event_id" varchar(255) NOT NULL,
	"type" varchar(100) NOT NULL,
	"processed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth_sessions" ADD CONSTRAINT "auth_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "checkouts" ADD CONSTRAINT "checkouts_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fortune_results" ADD CONSTRAINT "fortune_results_fortune_session_id_fortune_sessions_id_fk" FOREIGN KEY ("fortune_session_id") REFERENCES "public"."fortune_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fortune_results" ADD CONSTRAINT "fortune_results_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fortune_sessions" ADD CONSTRAINT "fortune_sessions_transaction_id_transactions_id_fk" FOREIGN KEY ("transaction_id") REFERENCES "public"."transactions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fortune_sessions" ADD CONSTRAINT "fortune_sessions_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settlements" ADD CONSTRAINT "settlements_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "store_users" ADD CONSTRAINT "store_users_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "store_users" ADD CONSTRAINT "store_users_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_checkout_id_checkouts_id_fk" FOREIGN KEY ("checkout_id") REFERENCES "public"."checkouts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_logs_store_created_idx" ON "audit_logs" USING btree ("store_id","created_at");--> statement-breakpoint
CREATE INDEX "audit_logs_created_idx" ON "audit_logs" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "auth_sessions_user_idx" ON "auth_sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "auth_sessions_expires_idx" ON "auth_sessions" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "checkouts_provider_payment_uq" ON "checkouts" USING btree ("provider","provider_payment_id");--> statement-breakpoint
CREATE UNIQUE INDEX "checkouts_access_token_uq" ON "checkouts" USING btree ("access_token_hash");--> statement-breakpoint
CREATE INDEX "checkouts_store_created_idx" ON "checkouts" USING btree ("store_id","created_at");--> statement-breakpoint
CREATE INDEX "checkouts_status_idx" ON "checkouts" USING btree ("status","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "fortune_results_session_uq" ON "fortune_results" USING btree ("fortune_session_id");--> statement-breakpoint
CREATE INDEX "fortune_results_created_idx" ON "fortune_results" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "fortune_sessions_transaction_uq" ON "fortune_sessions" USING btree ("transaction_id");--> statement-breakpoint
CREATE UNIQUE INDEX "fortune_sessions_token_uq" ON "fortune_sessions" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "fortune_sessions_status_expires_idx" ON "fortune_sessions" USING btree ("status","expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "settlements_store_month_uq" ON "settlements" USING btree ("store_id","year_month");--> statement-breakpoint
CREATE INDEX "settlements_month_status_idx" ON "settlements" USING btree ("year_month","status");--> statement-breakpoint
CREATE UNIQUE INDEX "store_users_user_store_uq" ON "store_users" USING btree ("user_id","store_id");--> statement-breakpoint
CREATE INDEX "store_users_store_idx" ON "store_users" USING btree ("store_id");--> statement-breakpoint
CREATE UNIQUE INDEX "stores_store_code_uq" ON "stores" USING btree ("store_code");--> statement-breakpoint
CREATE INDEX "stores_status_idx" ON "stores" USING btree ("status");--> statement-breakpoint
CREATE INDEX "stores_name_idx" ON "stores" USING btree ("name");--> statement-breakpoint
CREATE UNIQUE INDEX "transactions_provider_payment_uq" ON "transactions" USING btree ("payment_provider","provider_payment_id");--> statement-breakpoint
CREATE UNIQUE INDEX "transactions_checkout_uq" ON "transactions" USING btree ("checkout_id");--> statement-breakpoint
CREATE INDEX "transactions_store_paid_idx" ON "transactions" USING btree ("store_id","paid_at");--> statement-breakpoint
CREATE INDEX "transactions_paid_idx" ON "transactions" USING btree ("paid_at");--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_lower_uq" ON "users" USING btree (lower("email"));--> statement-breakpoint
CREATE UNIQUE INDEX "webhook_events_provider_event_uq" ON "webhook_events" USING btree ("provider","event_id");