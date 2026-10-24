-- 投毒出口 IP 黑名单。
--
-- 投毒判定基于上游实际看到的出口 IP，而不是账号或代理行本身：
--   * 静态代理的出口 IP 就是 proxies.host；
--   * 动态代理的出口 IP 会随会话变化，与 host 无关。
-- 因此黑名单以出口 IP 为唯一键，proxy_id 只作为来源记录，可为空。
--
-- 一旦命中即永久拉黑，不自动过期；删除本功能时随包一起 drop 本表。
CREATE TABLE IF NOT EXISTS poison_blocked_egress (
    id            BIGSERIAL PRIMARY KEY,
    outbound_ip   VARCHAR(64)  NOT NULL,
    proxy_id      BIGINT       REFERENCES proxies(id) ON DELETE SET NULL,
    account_id    BIGINT       REFERENCES accounts(id) ON DELETE SET NULL,
    -- 命中时该代理是否为动态代理（出口 IP 与 host 不一致）。
    is_dynamic    BOOLEAN      NOT NULL DEFAULT FALSE,
    -- 触发判定的关键词，便于事后复核是否为误判。
    reason        VARCHAR(255) NOT NULL DEFAULT '',
    hit_count     INTEGER      NOT NULL DEFAULT 1,
    first_hit_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    last_hit_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- 同一出口 IP 只记一条；重复命中累加计数。
CREATE UNIQUE INDEX IF NOT EXISTS idx_poison_blocked_egress_ip
    ON poison_blocked_egress (outbound_ip);

CREATE INDEX IF NOT EXISTS idx_poison_blocked_egress_proxy
    ON poison_blocked_egress (proxy_id);
