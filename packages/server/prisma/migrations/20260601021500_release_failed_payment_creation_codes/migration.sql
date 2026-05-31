UPDATE redemption_codes
SET used_at = NULL
WHERE id IN (
  SELECT redemption_code_id
  FROM orders
  WHERE status = 'FAILED'
    AND checkout_session_id IS NULL
    AND payment_method_id IS NULL
    AND pix_code IS NULL
);

DELETE FROM orders
WHERE status = 'FAILED'
  AND checkout_session_id IS NULL
  AND payment_method_id IS NULL
  AND pix_code IS NULL;
