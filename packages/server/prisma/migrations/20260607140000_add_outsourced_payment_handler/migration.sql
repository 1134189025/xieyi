CREATE TYPE "PaymentHandler" AS ENUM ('LOCAL_WORKER', 'OUTSOURCED_BUYER_API');

ALTER TABLE "orders"
ADD COLUMN "payment_handler" "PaymentHandler" NOT NULL DEFAULT 'LOCAL_WORKER',
ADD COLUMN "outsourced_ticket_id" TEXT,
ADD COLUMN "outsourced_payment_status" TEXT,
ADD COLUMN "outsourced_last_error" TEXT,
ADD COLUMN "outsourced_submitted_at" TIMESTAMP(3),
ADD COLUMN "outsourced_finished_at" TIMESTAMP(3);

CREATE INDEX "orders_payment_handler_status_created_at_id_idx"
ON "orders"("payment_handler", "status", "created_at", "id");

CREATE INDEX "orders_outsourced_ticket_id_idx"
ON "orders"("outsourced_ticket_id");
