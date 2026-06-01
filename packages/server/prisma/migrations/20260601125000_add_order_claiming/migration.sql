ALTER TABLE "orders"
  ADD COLUMN "claimed_by_id" TEXT,
  ADD COLUMN "claimed_at" TIMESTAMP(3);

ALTER TABLE "orders"
  ADD CONSTRAINT "orders_claimed_by_id_fkey"
  FOREIGN KEY ("claimed_by_id")
  REFERENCES "users"("id")
  ON DELETE SET NULL
  ON UPDATE CASCADE;

CREATE INDEX "orders_claimed_by_id_idx" ON "orders"("claimed_by_id");
CREATE INDEX "orders_status_claimed_by_id_created_at_idx" ON "orders"("status", "claimed_by_id", "created_at");
CREATE INDEX "orders_completed_by_id_completed_at_idx" ON "orders"("completed_by_id", "completed_at");
