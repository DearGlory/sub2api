-- Claim each EPUSDT blockchain transaction once across all payment orders.
-- The unique block_transaction_id is the database-level admission gate used by manual review.
CREATE TABLE IF NOT EXISTS epusdt_payment_claims (
    id BIGSERIAL PRIMARY KEY,
    block_transaction_id VARCHAR(255) NOT NULL UNIQUE,
    order_id BIGINT NOT NULL,
    trade_no VARCHAR(128) NOT NULL,
    amount DECIMAL(20,8) NOT NULL,
    actual_amount DECIMAL(20,8) NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_epusdt_payment_claims_order_id
    ON epusdt_payment_claims(order_id);
