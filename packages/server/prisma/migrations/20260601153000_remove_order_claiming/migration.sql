DROP INDEX IF EXISTS "orders_status_claimed_by_id_created_at_idx";
DROP INDEX IF EXISTS "orders_claimed_by_id_idx";
DROP INDEX IF EXISTS "orders_completed_by_id_completed_at_idx";

ALTER TABLE "orders" DROP CONSTRAINT IF EXISTS "orders_claimed_by_id_fkey";
ALTER TABLE "orders" DROP COLUMN IF EXISTS "claimed_by_id";
ALTER TABLE "orders" DROP COLUMN IF EXISTS "claimed_at";
