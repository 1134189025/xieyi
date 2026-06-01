ALTER TABLE "orders"
  ADD COLUMN "setup_intent_id" TEXT,
  ADD COLUMN "setup_intent_client_secret" TEXT;

CREATE INDEX "orders_setup_intent_id_idx" ON "orders"("setup_intent_id");
