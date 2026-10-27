//go:build unit

package repository

import (
	"context"
	"github.com/Wei-Shaw/sub2api/internal/poison"
	"github.com/stretchr/testify/require"
	"testing"
)

func TestPoisonRestoreEpochClearErrorAtomicPostgres(t *testing.T) {
	repo, db := epochPostgresRepo(t)
	a := epochSeed(t, repo)
	_, err := db.Exec(`UPDATE accounts SET status='error',error_message='synthetic',extra='{"poison_guard_restore_epoch":4}' WHERE id=$1`, a.ID)
	require.NoError(t, err)
	require.NoError(t, repo.ClearError(poison.WithAdminRestore(context.Background()), a.ID))
	extra, status, _ := epochRead(t, db, a.ID)
	require.Equal(t, "active", status)
	require.Equal(t, float64(5), extra[poison.RestoreEpochKey], "explicit admin clear-error restores state in the same transaction")
	_, err = db.Exec("DELETE FROM scheduler_outbox; ALTER TABLE scheduler_outbox ADD CONSTRAINT epoch_reject CHECK (event_type='impossible'); UPDATE accounts SET status='error'")
	require.NoError(t, err)
	require.Error(t, repo.ClearError(poison.WithAdminRestore(context.Background()), a.ID))
	extra, status, _ = epochRead(t, db, a.ID)
	require.Equal(t, "error", status)
	require.Equal(t, float64(5), extra[poison.RestoreEpochKey])
}
