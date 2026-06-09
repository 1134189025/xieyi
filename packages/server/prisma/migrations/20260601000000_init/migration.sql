CREATE TYPE "UserRole" AS ENUM ('ADMIN', 'WORKER');

CREATE TYPE "OrderStatus" AS ENUM (
  'PENDING_PAYMENT',
  'PAYMENT_COMPLETED',
  'FAILED',
  'EXPIRED',
  'CANCELLED'
);

CREATE TABLE "users" (
  "id" TEXT NOT NULL,
  "username" TEXT NOT NULL,
  "password_hash" TEXT NOT NULL,
  "role" "UserRole" NOT NULL,
  "display_name" TEXT,
  "enabled" BOOLEAN NOT NULL DEFAULT true,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "redemption_codes" (
  "id" TEXT NOT NULL,
  "code" TEXT NOT NULL,
  "batch_label" TEXT,
  "used_at" TIMESTAMP(3),
  "created_by_id" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "redemption_codes_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "orders" (
  "id" TEXT NOT NULL,
  "tracking_token" TEXT NOT NULL,
  "status" "OrderStatus" NOT NULL DEFAULT 'PENDING_PAYMENT',
  "redemption_code_id" TEXT NOT NULL,
  "checkout_session_id" TEXT,
  "checkout_url" TEXT,
  "payment_method_id" TEXT,
  "pix_code" TEXT,
  "pix_qr_png" BYTEA,
  "pix_expires_at" TIMESTAMP(3),
  "pix_image_url" TEXT,
  "billing_profile_json" JSONB,
  "encrypted_session_data" TEXT,
  "error_message" TEXT,
  "completed_by_id" TEXT,
  "completed_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "orders_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "users_username_key" ON "users"("username");
CREATE UNIQUE INDEX "redemption_codes_code_key" ON "redemption_codes"("code");
CREATE UNIQUE INDEX "orders_tracking_token_key" ON "orders"("tracking_token");
CREATE UNIQUE INDEX "orders_redemption_code_id_key" ON "orders"("redemption_code_id");

CREATE INDEX "redemption_codes_code_idx" ON "redemption_codes"("code");
CREATE INDEX "redemption_codes_created_at_idx" ON "redemption_codes"("created_at");
CREATE INDEX "orders_status_idx" ON "orders"("status");
CREATE INDEX "orders_tracking_token_idx" ON "orders"("tracking_token");
CREATE INDEX "orders_created_at_idx" ON "orders"("created_at");

ALTER TABLE "redemption_codes"
  ADD CONSTRAINT "redemption_codes_created_by_id_fkey"
  FOREIGN KEY ("created_by_id")
  REFERENCES "users"("id")
  ON DELETE RESTRICT
  ON UPDATE CASCADE;

ALTER TABLE "orders"
  ADD CONSTRAINT "orders_redemption_code_id_fkey"
  FOREIGN KEY ("redemption_code_id")
  REFERENCES "redemption_codes"("id")
  ON DELETE RESTRICT
  ON UPDATE CASCADE;

ALTER TABLE "orders"
  ADD CONSTRAINT "orders_completed_by_id_fkey"
  FOREIGN KEY ("completed_by_id")
  REFERENCES "users"("id")
  ON DELETE SET NULL
  ON UPDATE CASCADE;
