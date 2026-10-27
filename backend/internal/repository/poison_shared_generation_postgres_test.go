//go:build unit

package repository

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/Wei-Shaw/sub2api/internal/poison"
	"github.com/Wei-Shaw/sub2api/internal/service"
	"github.com/stretchr/testify/require"
)

// The shared proxy generation is repository-managed internal metadata exactly
// like the restore epoch: a whole-row edit built from a stale object, a
// malicious UpdateExtra/BulkUpdate payload, or a client Create must never move
// it. A generation that silently resets to 0 un-guards an account whose proxy
// is still being verified, so every entry point is pinned against real Postgres.
func TestPoisonSharedGenerationSurvivesEveryWritePathPostgres(t *testing.T) {
	r, db := epochPostgresRepo(t)
	a := epochSeed(t, r)
	ctx := context.Background()

	// A row already carrying generation 8, as written by the scheduler.
	_, err := db.Exec(`UPDATE accounts SET extra='{"poison_guard_restore_epoch":4,"poison_guard_shared_generation":8,"saved":true}' WHERE id=$1`, a.ID)
	require.NoError(t, err)

	// 1. Whole-row Update carries a stale object claiming generation 0.
	a.Extra = map[string]any{poison.RestoreEpochKey: 0, poison.SharedGenerationKey: 0, "edited": true}
	require.NoError(t, r.Update(ctx, a))
	extra, _, _ := epochRead(t, db, a.ID)
	require.Equal(t, float64(8), extra[poison.SharedGenerationKey], "stale whole-object edit reset the shared generation")
	require.Equal(t, float64(4), extra[poison.RestoreEpochKey], "stale whole-object edit reset the restore epoch")
	require.Equal(t, true, extra["edited"], "ordinary extra changes must still land")
	require.Equal(t, float64(8), float64(poison.SharedGeneration(extra)))

	// 2. UpdateExtra payload trying to force 999 (and to drop it) is ignored.
	require.NoError(t, r.UpdateExtra(ctx, a.ID, map[string]any{poison.SharedGenerationKey: 999, "note": "ok"}))
	extra, _, _ = epochRead(t, db, a.ID)
	require.Equal(t, float64(8), extra[poison.SharedGenerationKey])
	require.Equal(t, "ok", extra["note"])

	// 3. BulkUpdate payload trying to force 999 / null is ignored too.
	_, err = r.BulkUpdate(ctx, []int64{a.ID}, service.AccountBulkUpdate{Extra: map[string]any{poison.SharedGenerationKey: 999, "bulk": true}})
	require.NoError(t, err)
	extra, _, _ = epochRead(t, db, a.ID)
	require.Equal(t, float64(8), extra[poison.SharedGenerationKey])
	require.Equal(t, true, extra["bulk"])
	_, err = r.BulkUpdate(ctx, []int64{a.ID}, service.AccountBulkUpdate{Extra: map[string]any{poison.SharedGenerationKey: nil}})
	require.NoError(t, err)
	extra, _, _ = epochRead(t, db, a.ID)
	require.Equal(t, float64(8), extra[poison.SharedGenerationKey])

	// 4. An admin restore still advances only the restore epoch.
	restore := poison.WithAdminRestore(ctx)
	require.NoError(t, r.SetSchedulable(restore, a.ID, true))
	extra, _, _ = epochRead(t, db, a.ID)
	require.Equal(t, float64(5), extra[poison.RestoreEpochKey])
	require.Equal(t, float64(8), extra[poison.SharedGenerationKey], "admin restore must not touch the shared generation")

	// 5. Create strips an injected generation instead of trusting the payload.
	injected := &service.Account{
		Name: "shared-injected", Platform: service.PlatformOpenAI, Type: service.AccountTypeAPIKey,
		Credentials: map[string]any{"api_key": "synthetic"}, Concurrency: 1, Priority: 1,
		Status: service.StatusActive, Schedulable: true,
		Extra: map[string]any{poison.SharedGenerationKey: 9, poison.RestoreEpochKey: 3, "kept": true},
	}
	require.NoError(t, r.Create(ctx, injected))
	created, _, _ := epochRead(t, db, injected.ID)
	require.NotContains(t, created, poison.SharedGenerationKey)
	require.NotContains(t, created, poison.RestoreEpochKey)
	require.Equal(t, int64(0), poison.SharedGeneration(created))
	require.Equal(t, true, created["kept"])

	// 6. Scheduler full and metadata projections both keep generation 8.
	account := service.Account{ID: a.ID, Platform: a.Platform, Type: a.Type, Extra: extra}
	full, meta, err := marshalSchedulerCacheAccount(account)
	require.NoError(t, err)
	for name, raw := range map[string][]byte{"full": full, "metadata": meta} {
		var projected service.Account
		require.NoError(t, json.Unmarshal(raw, &projected))
		require.Equal(t, int64(8), poison.SharedGeneration(projected.Extra), "scheduler %s projection dropped the shared generation", name)
	}
}
