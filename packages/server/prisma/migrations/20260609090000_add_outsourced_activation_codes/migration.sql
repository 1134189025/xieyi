CREATE TABLE "outsourced_activation_codes" (
    "id" TEXT NOT NULL,
    "code_hash" TEXT NOT NULL,
    "encrypted_code" TEXT NOT NULL,
    "masked_code" TEXT NOT NULL,
    "batch_label" TEXT,
    "last_remaining" INTEGER,
    "last_total" INTEGER,
    "last_used" INTEGER,
    "local_submit_count" INTEGER NOT NULL DEFAULT 0,
    "last_checked_at" TIMESTAMP(3),
    "last_error" TEXT,
    "exhausted_at" TIMESTAMP(3),
    "archived_at" TIMESTAMP(3),
    "created_by_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "outsourced_activation_codes_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "orders" ADD COLUMN "outsourced_activation_code_id" TEXT;

CREATE UNIQUE INDEX "outsourced_activation_codes_code_hash_key" ON "outsourced_activation_codes"("code_hash");
CREATE INDEX "outsourced_activation_codes_batch_label_archived_at_created_at_idx" ON "outsourced_activation_codes"("batch_label", "archived_at", "created_at");
CREATE INDEX "outsourced_activation_codes_archived_at_exhausted_at_created_at_idx" ON "outsourced_activation_codes"("archived_at", "exhausted_at", "created_at");
CREATE INDEX "outsourced_activation_codes_last_remaining_idx" ON "outsourced_activation_codes"("last_remaining");
CREATE INDEX "orders_outsourced_activation_code_id_idx" ON "orders"("outsourced_activation_code_id");

ALTER TABLE "outsourced_activation_codes" ADD CONSTRAINT "outsourced_activation_codes_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "orders" ADD CONSTRAINT "orders_outsourced_activation_code_id_fkey" FOREIGN KEY ("outsourced_activation_code_id") REFERENCES "outsourced_activation_codes"("id") ON DELETE SET NULL ON UPDATE CASCADE;
