//go:build unit

package repository

import (
	"context"
	"database/sql"
	"encoding/json"
	"os"
	"testing"

	"entgo.io/ent/dialect"
	entsql "entgo.io/ent/dialect/sql"
	"entgo.io/ent/dialect/sql/schema"
	dbent "github.com/Wei-Shaw/sub2api/ent"
	"github.com/Wei-Shaw/sub2api/ent/migrate"
	"github.com/Wei-Shaw/sub2api/internal/poison"
	"github.com/Wei-Shaw/sub2api/internal/service"
	_ "github.com/lib/pq"
	"github.com/stretchr/testify/require"
	"sync"
)

func epochPostgresRepo(t *testing.T) (*accountRepository, *sql.DB) {
	t.Helper()
	dsn := os.Getenv("POISON_TEST_POSTGRES_DSN")
	if dsn == "" {
		t.Skip("POISON_TEST_POSTGRES_DSN not configured")
	}
	db, err := sql.Open("postgres", dsn)
	require.NoError(t, err)
	t.Cleanup(func() { db.Close() })
	db.SetMaxOpenConns(1)
	ctx := context.Background()
	var database string
	require.NoError(t, db.QueryRow("SELECT current_database()").Scan(&database))
	require.Equal(t, "poison_accept", database, "requires isolated test database")
	_, err = db.ExecContext(ctx, `DROP TABLE IF EXISTS accounts, scheduler_outbox;
 CREATE TABLE scheduler_outbox(id bigserial PRIMARY KEY,event_type text,account_id bigint,group_id bigint,payload jsonb,dedup_key text UNIQUE,created_at timestamptz DEFAULT NOW())`)
	require.NoError(t, err)
	driver := entsql.OpenDB(dialect.Postgres, db)
	migration, err := schema.NewMigrate(driver, schema.WithForeignKeys(false))
	require.NoError(t, err)
	table := *migrate.AccountsTable
	table.ForeignKeys = nil
	require.NoError(t, migration.Create(ctx, &table))
	client := dbent.NewClient(dbent.Driver(driver))
	return newAccountRepositoryWithSQL(client, db, nil), db
}

func epochRead(t *testing.T, db *sql.DB, id int64) (map[string]any, string, bool) {
	t.Helper()
	var raw []byte
	var status string
	var sched bool
	require.NoError(t, db.QueryRow("SELECT extra,status,schedulable FROM accounts WHERE id=$1", id).Scan(&raw, &status, &sched))
	result := map[string]any{}
	require.NoError(t, json.Unmarshal(raw, &result))
	return result, status, sched
}

func epochSeed(t *testing.T, r *accountRepository) *service.Account {
	t.Helper()
	a := &service.Account{Name: "epoch-fixture", Platform: service.PlatformOpenAI, Type: service.AccountTypeAPIKey, Credentials: map[string]any{"api_key": "synthetic"}, Extra: map[string]any{}, Concurrency: 1, Priority: 1, Status: service.StatusActive, Schedulable: true}
	require.NoError(t, r.Create(context.Background(), a))
	return a
}

func TestPoisonRestoreEpochPreservesStoredValuePostgres(t *testing.T) {
	r, db := epochPostgresRepo(t)
	a := epochSeed(t, r)
	ctx := context.Background()
	_, err := db.Exec(`UPDATE accounts SET extra='{"poison_guard_restore_epoch":7,"saved":true}' WHERE id=$1`, a.ID)
	require.NoError(t, err)
	a.Extra = map[string]any{"poison_guard_restore_epoch": 0, "edited": true}
	require.NoError(t, r.Update(ctx, a))
	extra, _, _ := epochRead(t, db, a.ID)
	if extra["poison_guard_restore_epoch"] != float64(7) {
		t.Fatalf("stale whole-object edit: epoch=%v want=7", extra["poison_guard_restore_epoch"])
	}
	require.NoError(t, r.UpdateExtra(ctx, a.ID, map[string]any{"poison_guard_restore_epoch": 999, "passive_usage_note": "ok"}))
	extra, _, _ = epochRead(t, db, a.ID)
	require.Equal(t, float64(7), extra["poison_guard_restore_epoch"])
	_, err = r.BulkUpdate(ctx, []int64{a.ID}, service.AccountBulkUpdate{Extra: map[string]any{"poison_guard_restore_epoch": nil, "custom": true}})
	require.NoError(t, err)
	extra, _, _ = epochRead(t, db, a.ID)
	require.Equal(t, float64(7), extra["poison_guard_restore_epoch"])
}

func TestPoisonRestoreEpochAtomicWritesPostgres(t *testing.T) {
	r, db := epochPostgresRepo(t)
	a := epochSeed(t, r)
	b := epochSeed(t, r)
	ctx := context.Background()
	restore := poison.WithAdminRestore(ctx)
	a.Status = "active"
	require.NoError(t, r.UpdateWithAccountBillingSettings(restore, a, nil, nil, nil))
	extra, _, _ := epochRead(t, db, a.ID)
	require.Equal(t, float64(1), extra[poison.RestoreEpochKey])
	require.NoError(t, r.SetSchedulable(restore, a.ID, true))
	extra, _, _ = epochRead(t, db, a.ID)
	require.Equal(t, float64(2), extra[poison.RestoreEpochKey])
	active := service.StatusActive
	n, err := r.BulkUpdate(restore, []int64{a.ID, b.ID, a.ID}, service.AccountBulkUpdate{Status: &active, Extra: map[string]any{poison.RestoreEpochKey: 999, "custom": "ok"}})
	require.NoError(t, err)
	require.Equal(t, int64(2), n)
	extra, status, _ := epochRead(t, db, a.ID)
	require.Equal(t, float64(3), extra[poison.RestoreEpochKey])
	require.Equal(t, "active", status)
	extra, _, _ = epochRead(t, db, b.ID)
	require.Equal(t, float64(1), extra[poison.RestoreEpochKey])
	require.NoError(t, r.UpdateLastUsed(ctx, a.ID))
	require.NoError(t, r.SetSchedulable(ctx, a.ID, true))
	extra, _, _ = epochRead(t, db, a.ID)
	require.Equal(t, float64(3), extra[poison.RestoreEpochKey])
	// Two independent connections and clients represent separate application instances.
	db.SetMaxOpenConns(4)
	other := newAccountRepositoryWithSQL(dbent.NewClient(dbent.Driver(entsql.OpenDB(dialect.Postgres, db))), db, nil)
	start := make(chan struct{})
	errs := make(chan error, 2)
	var wg sync.WaitGroup
	for _, repo := range []*accountRepository{r, other} {
		wg.Add(1)
		go func(repo *accountRepository) {
			defer wg.Done()
			<-start
			_, err := repo.BulkUpdate(poison.WithAdminRestore(context.Background()), []int64{a.ID}, service.AccountBulkUpdate{Status: &active})
			errs <- err
		}(repo)
	}
	close(start)
	wg.Wait()
	close(errs)
	for err := range errs {
		require.NoError(t, err)
	}
	extra, _, _ = epochRead(t, db, a.ID)
	require.Equal(t, float64(5), extra[poison.RestoreEpochKey])
	// Failure of the existing outbox write rolls back both status and epoch.
	_, err = db.Exec("DELETE FROM scheduler_outbox; ALTER TABLE scheduler_outbox ADD CONSTRAINT epoch_reject CHECK (event_type='impossible')")
	require.NoError(t, err)
	n, err = r.BulkUpdate(restore, []int64{a.ID}, service.AccountBulkUpdate{Status: &active})
	require.Error(t, err)
	require.Zero(t, n)
	extra, _, _ = epochRead(t, db, a.ID)
	require.Equal(t, float64(5), extra[poison.RestoreEpochKey])
	// The enclosing transaction controls commit for single-account restores too.
	_, err = db.Exec("ALTER TABLE scheduler_outbox DROP CONSTRAINT epoch_reject")
	require.NoError(t, err)
	tx, err := r.client.Tx(ctx)
	require.NoError(t, err)
	require.NoError(t, r.SetSchedulable(poison.WithAdminRestore(dbent.NewTxContext(ctx, tx)), a.ID, true))
	require.NoError(t, tx.Rollback())
	extra, _, _ = epochRead(t, db, a.ID)
	require.Equal(t, float64(5), extra[poison.RestoreEpochKey])
}
