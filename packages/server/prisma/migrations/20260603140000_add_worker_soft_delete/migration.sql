ALTER TABLE "users" ADD COLUMN "deleted_at" TIMESTAMP(3);

CREATE INDEX "users_role_deleted_at_created_at_idx" ON "users"("role", "deleted_at", "created_at");

UPDATE "orders"
SET
  "claimed_by_id" = NULL,
  "claimed_at" = NULL,
  "claim_expires_at" = NULL,
  "updated_at" = NOW()
FROM "users"
WHERE "orders"."claimed_by_id" = "users"."id"
  AND "orders"."status" = 'PENDING_PAYMENT'
  AND "orders"."claim_expires_at" > NOW()
  AND "users"."role" = 'WORKER'
  AND "users"."enabled" = false;
