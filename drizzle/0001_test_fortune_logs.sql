CREATE TABLE "test_fortune_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"store_code" varchar(32) NOT NULL,
	"fortune_type" "fortune_type" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "test_fortune_logs_created_idx" ON "test_fortune_logs" USING btree ("created_at");