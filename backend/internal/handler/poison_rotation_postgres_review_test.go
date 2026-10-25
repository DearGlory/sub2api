package handler

import (
	"context"
	"database/sql"
	"errors"
	"os"
	"testing"
	"time"

	dbent "github.com/Wei-Shaw/sub2api/ent"
	"github.com/Wei-Shaw/sub2api/internal/poison"
)

func TestPoisonRotationPostgresStaleDisableAndBlacklist(t *testing.T) {
	dsn := os.Getenv("POISON_TEST_POSTGRES_DSN")
	if dsn == "" {
		t.Skip("POISON_TEST_POSTGRES_DSN not configured")
	}
	db, err := sql.Open("postgres", dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	var name string
	if err := db.QueryRowContext(ctx, "SELECT current_database()").Scan(&name); err != nil || name != "poison_accept" {
		t.Fatal("requires isolated poison_accept")
	}
	_, err = db.ExecContext(ctx, `CREATE TABLE IF NOT EXISTS proxies(id bigint PRIMARY KEY,host text,port integer,status text,deleted_at timestamptz); CREATE TABLE IF NOT EXISTS accounts(id bigint PRIMARY KEY,proxy_id bigint,status text,deleted_at timestamptz,schedulable boolean DEFAULT true); ALTER TABLE accounts ADD COLUMN IF NOT EXISTS schedulable boolean DEFAULT true; CREATE TABLE IF NOT EXISTS poison_blocked_egress(outbound_ip text PRIMARY KEY,proxy_id bigint,account_id bigint,is_dynamic boolean,reason text,hit_count integer NOT NULL DEFAULT 1,last_hit_at timestamptz); TRUNCATE accounts,proxies,poison_blocked_egress; INSERT INTO proxies VALUES(21,'192.0.2.21',1080,'active',NULL),(22,'192.0.2.22',1080,'active',NULL); INSERT INTO accounts(id,proxy_id,status,schedulable) VALUES(41,22,'active',true)`)
	if err != nil {
		t.Fatal(err)
	}
	old := int64(21)
	called := false
	err = disablePoisonIncident(ctx, db, poison.Incident{AccountID: 41, ProxyID: &old}, func(context.Context) error { called = true; return nil })
	if !errors.Is(err, poison.ErrStaleIncident) || called {
		t.Fatalf("stale disable reached update: called=%v err=%v", called, err)
	}
	current := int64(22)
	err = disablePoisonIncident(ctx, db, poison.Incident{AccountID: 41, ProxyID: &current}, func(txCtx context.Context) error {
		_, err := dbent.TxFromContext(txCtx).Client().ExecContext(txCtx, "UPDATE accounts SET status='disabled' WHERE id=41")
		return err
	})
	if err != nil {
		t.Fatal(err)
	}
	var status string
	_ = db.QueryRowContext(ctx, "SELECT status FROM accounts WHERE id=41").Scan(&status)
	if status != "disabled" {
		t.Fatal("current incident not disabled")
	}
	store := poison.NewEgressStore(db)
	if err := store.Record(ctx, "192.0.2.21", &old, nil, false, "veto:kedaya"); err != nil {
		t.Fatal(err)
	}
	if err := store.Record(ctx, "192.0.2.21", &old, nil, false, "veto:kedaya"); err != nil {
		t.Fatal(err)
	}
	var hits int
	_ = db.QueryRowContext(ctx, "SELECT hit_count FROM poison_blocked_egress WHERE outbound_ip='192.0.2.21'").Scan(&hits)
	if hits != 2 {
		t.Fatalf("upsert hits=%d", hits)
	}
	called = false
	err = rebindPoisonProxy(ctx, db, 41, 21, func(context.Context) error { called = true; return nil })
	if err == nil || called {
		t.Fatalf("blacklist missed at commit: called=%v err=%v", called, err)
	}
	t.Log("real PostgreSQL: stale disable rejected; current disable committed; blacklist upsert and commit-time rejection verified")
}
