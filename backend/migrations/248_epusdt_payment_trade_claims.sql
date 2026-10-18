-- Preserve every signed GMPay trade number even when a parent order gains
-- another callback trade. A trade can belong to only one order and block.
CREATE TABLE IF NOT EXISTS epusdt_payment_trade_claims (
    trade_no VARCHAR(128) PRIMARY KEY,
    order_id BIGINT NOT NULL,
    block_transaction_id VARCHAR(255) NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_epusdt_payment_trade_claims_order_id
    ON epusdt_payment_trade_claims(order_id);
