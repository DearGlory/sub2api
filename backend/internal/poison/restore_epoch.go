package poison

import (
	"context"
	"encoding/json"
	"math"
	"strconv"
)

// RestoreEpochKey is managed only by the account repository, in the restore transaction.
const RestoreEpochKey = "poison_guard_restore_epoch"
const MaxRestoreEpoch int64 = 1<<53 - 1

type adminRestoreKey struct{}

// WithAdminRestore marks the direct repository call for an explicit admin restore.
// Do not reuse this context for unrelated account writes.
func WithAdminRestore(ctx context.Context) context.Context {
	return context.WithValue(ctx, adminRestoreKey{}, true)
}

func IsAdminRestore(ctx context.Context) bool {
	marked, _ := ctx.Value(adminRestoreKey{}).(bool)
	return marked
}

// RestoreEpoch returns -1 for invalid internal metadata, so it cannot match a valid row.
// The safe-integer bound keeps snapshots decoded by encoding/json exact.
func RestoreEpoch(extra map[string]any) int64 {
	value, exists := extra[RestoreEpochKey]
	if !exists {
		return 0
	}
	switch v := value.(type) {
	case int:
		if v >= 0 && int64(v) <= MaxRestoreEpoch {
			return int64(v)
		}
	case int64:
		if v >= 0 && v <= MaxRestoreEpoch {
			return v
		}
	case float64:
		if v >= 0 && v <= float64(MaxRestoreEpoch) && !math.IsNaN(v) && math.Trunc(v) == v {
			return int64(v)
		}
	case json.Number:
		n, err := strconv.ParseInt(string(v), 10, 64)
		if err == nil && n >= 0 && n <= MaxRestoreEpoch {
			return n
		}
	}
	return -1
}

func StripRestoreEpoch(extra map[string]any) map[string]any {
	if _, exists := extra[RestoreEpochKey]; !exists {
		return extra
	}
	clean := make(map[string]any, len(extra)-1)
	for key, value := range extra {
		if key != RestoreEpochKey {
			clean[key] = value
		}
	}
	return clean
}
