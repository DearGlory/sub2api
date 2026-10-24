//go:build egresslive

package poison

import (
	"context"
	"database/sql"
	"os"
	"testing"

	_ "github.com/lib/pq"
)

// TestEgressStoreLive 连真实 Postgres 验证 EgressStore 的全部查询路径。
//
// 需要设置 POISON_TEST_DSN 指向一个可写的测试库；未设置时跳过。
// 该测试只在 egresslive 构建标签下编译，不会进入常规测试集。
func TestEgressStoreLive(t *testing.T) {
	dsn := os.Getenv("POISON_TEST_DSN")
	if dsn == "" {
		t.Skip("POISON_TEST_DSN not set")
	}
	db, err := sql.Open("postgres", dsn)
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	defer db.Close()
	ctx := context.Background()

	if _, err := db.ExecContext(ctx, `DROP TABLE IF EXISTS poison_blocked_egress`); err != nil {
		t.Fatalf("drop: %v", err)
	}
	if err := createEgressTable(ctx, db); err != nil {
		t.Fatalf("create: %v", err)
	}
	defer db.ExecContext(ctx, `DROP TABLE IF EXISTS poison_blocked_egress`)

	store := NewEgressStore(db)

	// 首次记录
	sid := int64(25)
	aid := int64(354)
	if err := store.Record(ctx, "51.222.42.218", &sid, &aid, false, "veto:kedaya"); err != nil {
		t.Fatalf("record: %v", err)
	}
	blocked, err := store.IsBlocked(ctx, "51.222.42.218")
	if err != nil || !blocked {
		t.Fatalf("IsBlocked=%v err=%v", blocked, err)
	}

	// 重复记录只累加
	if err := store.Record(ctx, "51.222.42.218", &sid, &aid, false, "veto:kedaya"); err != nil {
		t.Fatalf("record again: %v", err)
	}
	list, err := store.List(ctx, 10)
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if len(list) != 1 || list[0].HitCount != 2 {
		t.Fatalf("expected single row with hit_count=2, got %+v", list)
	}

	// 静态代理进入 BlockedProxyIDs
	ids, err := store.BlockedProxyIDs(ctx)
	if err != nil {
		t.Fatalf("blocked ids: %v", err)
	}
	if _, ok := ids[25]; !ok {
		t.Fatalf("static proxy must be in blocked set, got %v", ids)
	}

	// 动态代理不进 BlockedProxyIDs
	did := int64(26)
	if err := store.Record(ctx, "9.9.9.9", &did, &aid, true, "threshold:3/3"); err != nil {
		t.Fatalf("record dynamic: %v", err)
	}
	ids, err = store.BlockedProxyIDs(ctx)
	if err != nil {
		t.Fatalf("blocked ids: %v", err)
	}
	if _, ok := ids[26]; ok {
		t.Fatalf("dynamic proxy must NOT block the whole row, got %v", ids)
	}

	// 出口 IP 本身仍然被拦
	if blocked, _ := store.IsBlocked(ctx, "9.9.9.9"); !blocked {
		t.Fatal("dynamic egress IP must still be blocked")
	}

	// 空 IP 不应产生记录
	if err := store.Record(ctx, "   ", nil, nil, false, "x"); err != nil {
		t.Fatalf("empty ip record: %v", err)
	}
	list, _ = store.List(ctx, 10)
	if len(list) != 2 {
		t.Fatalf("empty ip must not insert, got %d rows", len(list))
	}

	// nil store 全部安全
	var nilStore *EgressStore
	if err := nilStore.Record(ctx, "1.1.1.1", nil, nil, false, ""); err != nil {
		t.Fatalf("nil record: %v", err)
	}
	if b, err := nilStore.IsBlocked(ctx, "1.1.1.1"); b || err != nil {
		t.Fatalf("nil IsBlocked=%v err=%v", b, err)
	}
}

// createEgressTable 用生产迁移文件里的真实 DDL 建表。
func createEgressTable(ctx context.Context, db *sql.DB) error {
	_, err := db.ExecContext(ctx, `
CREATE TABLE IF NOT EXISTS poison_blocked_egress (
    id            BIGSERIAL PRIMARY KEY,
    outbound_ip   VARCHAR(64)  NOT NULL,
    proxy_id      BIGINT,
    account_id    BIGINT,
    is_dynamic    BOOLEAN      NOT NULL DEFAULT FALSE,
    reason        VARCHAR(255) NOT NULL DEFAULT '',
    hit_count     INTEGER      NOT NULL DEFAULT 1,
    first_hit_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    last_hit_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_poison_blocked_egress_ip ON poison_blocked_egress (outbound_ip);
CREATE INDEX IF NOT EXISTS idx_poison_blocked_egress_proxy ON poison_blocked_egress (proxy_id);
`)
	return err
}
