ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "generation_queued_at" TIMESTAMP(3);
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "generation_started_at" TIMESTAMP(3);
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "generation_finished_at" TIMESTAMP(3);
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "generation_error_code" TEXT;
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "submitted_redemption_code" TEXT;

ALTER TABLE "orders" ALTER COLUMN "redemption_code_id" DROP NOT NULL;

CREATE INDEX IF NOT EXISTS "orders_status_generation_queued_at_id_idx"
  ON "orders"("status", "generation_queued_at", "id");

CREATE INDEX IF NOT EXISTS "orders_generation_finished_at_idx"
  ON "orders"("generation_finished_at");
