-- Enforce one upstream GMPay trade number per EPUSDT order.
-- The migration runner checks historical duplicates and removes an invalid
-- concurrent index before retrying this statement.
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS paymentorder_payment_trade_no
    ON payment_orders (payment_trade_no)
    WHERE payment_type = 'epusdt' AND payment_trade_no <> '';
