package repository

import (
	"encoding/json"
	"github.com/Wei-Shaw/sub2api/internal/poison"
	"github.com/Wei-Shaw/sub2api/internal/service"
	"github.com/stretchr/testify/require"
	"testing"
)

func TestPoisonRestoreEpochSchedulerProjection(t *testing.T) {
	source := service.Account{ID: 42, Extra: map[string]any{poison.RestoreEpochKey: float64(7), "irrelevant": "omit"}}
	full, meta, err := marshalSchedulerCacheAccount(source)
	require.NoError(t, err)
	for name, raw := range map[string][]byte{"full": full, "metadata": meta} {
		t.Run(name, func(t *testing.T) {
			var account service.Account
			require.NoError(t, json.Unmarshal(raw, &account))
			require.Equal(t, int64(7), poison.RestoreEpoch(account.Extra))
		})
	}
}
