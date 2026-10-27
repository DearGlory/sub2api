package handler

import (
	"context"
	"database/sql"
	"errors"
	"os"
	"testing"

	"github.com/Wei-Shaw/sub2api/internal/poison"
	_ "github.com/lib/pq"
)

// A successful restore and its generation are already committed; audits are absent.
func TestPoisonRestoreEpochTransactionPostgres(t *testing.T) {
	dsn := os.Getenv("POISON_TEST_POSTGRES_DSN")
	if dsn == "" {
		t.Skip("POISON_TEST_POSTGRES_DSN not configured")
	}
	db, err := sql.Open("postgres", dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	db.SetMaxOpenConns(1)
	ctx := context.Background()
	_, err = db.ExecContext(ctx, `CREATE TEMP TABLE accounts(id bigint PRIMARY KEY,proxy_id bigint,status text,schedulable boolean,deleted_at timestamptz,extra jsonb); INSERT INTO accounts VALUES(42,7,'active',true,NULL,'{"poison_guard_restore_epoch":2}')`)
	if err != nil {
		t.Fatal(err)
	}
	p := int64(7)
	called := false
	err = disablePoisonIncident(ctx, db, poison.Incident{AccountID: 42, ProxyID: &p, RestoreEpoch: 1}, func(context.Context) error { called = true; return nil })
	if !errors.Is(err, poison.ErrStaleIncident) || called {
		t.Fatalf("old request: err=%v update_called=%v", err, called)
	}
	var status string
	if err = db.QueryRow("SELECT status FROM accounts WHERE id=42").Scan(&status); err != nil || status != "active" {
		t.Fatalf("status=%s err=%v", status, err)
	}
	err = disablePoisonIncident(ctx, db, poison.Incident{AccountID: 42, ProxyID: &p, RestoreEpoch: 2}, func(context.Context) error { called = true; return nil })
	if err != nil || !called {
		t.Fatalf("new request: err=%v update_called=%v", err, called)
	}
}
