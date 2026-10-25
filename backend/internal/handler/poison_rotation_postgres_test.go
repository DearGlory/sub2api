package handler

import (
	"context"
	"database/sql"
	"fmt"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	dbent "github.com/Wei-Shaw/sub2api/ent"
	_ "github.com/lib/pq"
)

func TestPoisonRotationPostgresConcurrentEndpointClaim(t *testing.T) {
	dsn := os.Getenv("POISON_TEST_POSTGRES_DSN")
	if dsn == "" {
		t.Skip("POISON_TEST_POSTGRES_DSN not configured")
	}
	db, err := sql.Open("postgres", dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	db.SetMaxOpenConns(6)
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	var database string
	if err = db.QueryRowContext(ctx, "SELECT current_database()").Scan(&database); err != nil {
		t.Fatal(err)
	}
	if database != "poison_accept" {
		t.Fatal("requires isolated poison_accept database")
	}
	_, err = db.ExecContext(ctx, `CREATE TABLE IF NOT EXISTS proxies(id bigint PRIMARY KEY,host text,port integer,status text,deleted_at timestamptz); CREATE TABLE IF NOT EXISTS accounts(id bigint PRIMARY KEY,proxy_id bigint,status text,deleted_at timestamptz); CREATE TABLE IF NOT EXISTS poison_blocked_egress(outbound_ip text PRIMARY KEY,proxy_id bigint,account_id bigint,is_dynamic boolean,reason text,hit_count integer NOT NULL DEFAULT 1,last_hit_at timestamptz); ALTER TABLE accounts ADD COLUMN IF NOT EXISTS schedulable boolean DEFAULT true; TRUNCATE accounts,proxies,poison_blocked_egress; INSERT INTO proxies VALUES(1,'duplicate.example',1080,'active',NULL),(2,'DUPLICATE.EXAMPLE ',1080,'active',NULL); INSERT INTO accounts(id,proxy_id,status,deleted_at) VALUES(11,NULL,'active',NULL),(12,NULL,'active',NULL)`)
	if err != nil {
		t.Fatal(err)
	}
	start := make(chan struct{})
	results := make(chan error, 2)
	var wg sync.WaitGroup
	for i := 0; i < 2; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			<-start
			accountID, proxyID := int64(11+i), int64(1+i)
			err := rebindPoisonProxy(ctx, db, accountID, proxyID, func(txCtx context.Context) error {
				client := dbent.TxFromContext(txCtx).Client()
				_, err := client.ExecContext(txCtx, "UPDATE accounts SET proxy_id=$1 WHERE id=$2", proxyID, accountID)
				return err
			})
			results <- err
		}(i)
	}
	close(start)
	wg.Wait()
	close(results)
	success, occupied := 0, 0
	for err := range results {
		if err == nil {
			success++
		} else if strings.Contains(err.Error(), "occupied") {
			occupied++
		} else {
			t.Error(err)
		}
	}
	var assigned int
	if err = db.QueryRowContext(ctx, "SELECT count(*) FROM accounts WHERE proxy_id IS NOT NULL").Scan(&assigned); err != nil {
		t.Fatal(err)
	}
	if success != 1 || occupied != 1 || assigned != 1 {
		t.Fatalf("success=%d occupied=%d assigned=%d", success, occupied, assigned)
	}
	t.Logf("real PostgreSQL competing duplicate endpoints: success=%d rejected_occupied=%d persisted_assignments=%d", success, occupied, assigned)
	_, err = db.ExecContext(ctx, "UPDATE accounts SET proxy_id=NULL")
	if err != nil {
		t.Fatal(err)
	}
	sentinel := fmt.Errorf("injected post-update failure")
	err = rebindPoisonProxy(ctx, db, 11, 1, func(txCtx context.Context) error {
		_, err := dbent.TxFromContext(txCtx).Client().ExecContext(txCtx, "UPDATE accounts SET proxy_id=1 WHERE id=11")
		if err != nil {
			return err
		}
		return sentinel
	})
	if err != sentinel {
		t.Fatalf("expected injected rollback: %v", err)
	}
	if err = db.QueryRowContext(ctx, "SELECT count(*) FROM accounts WHERE proxy_id IS NOT NULL").Scan(&assigned); err != nil {
		t.Fatal(err)
	}
	if assigned != 0 {
		t.Fatal("rolled back assignment persisted")
	}
}
