ALTER TABLE "redemption_codes"
  ADD COLUMN "archived_at" TIMESTAMP(3);

ALTER TABLE "orders"
  ADD COLUMN "claimed_by_id" TEXT,
  ADD COLUMN "claimed_at" TIMESTAMP(3),
  ADD COLUMN "claim_expires_at" TIMESTAMP(3),
  ADD COLUMN "generation_error_stage" TEXT,
  ADD COLUMN "generation_error_detail" TEXT,
  ADD COLUMN "generation_error_http_status" INTEGER;

ALTER TABLE "orders"
  ADD CONSTRAINT "orders_claimed_by_id_fkey"
  FOREIGN KEY ("claimed_by_id")
  REFERENCES "users"("id")
  ON DELETE SET NULL
  ON UPDATE CASCADE;

CREATE INDEX "redemption_codes_batch_used_archived_created_at_idx"
  ON "redemption_codes"("batch_label", "used_at", "archived_at", "created_at");

CREATE INDEX "redemption_codes_archived_at_idx"
  ON "redemption_codes"("archived_at");

CREATE INDEX "orders_claimed_by_id_idx"
  ON "orders"("claimed_by_id");

CREATE INDEX "orders_status_claimed_by_id_claim_expires_at_created_at_id_idx"
  ON "orders"("status", "claimed_by_id", "claim_expires_at", "created_at", "id");

CREATE INDEX "orders_status_claim_expires_at_created_at_id_idx"
  ON "orders"("status", "claim_expires_at", "created_at", "id");

CREATE INDEX "orders_completed_by_id_completed_at_idx"
  ON "orders"("completed_by_id", "completed_at");

