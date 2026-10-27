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
	return managedGeneration(extra, RestoreEpochKey)
}

// SharedGeneration returns the shared-proxy verification generation of an
// account: 0 when the account never entered the shared verification flow, -1
// for invalid metadata (same rule as the restore epoch, so a corrupt value can
// never be mistaken for a fresh generation and re-enable a poisoned account).
func SharedGeneration(extra map[string]any) int64 {
	return managedGeneration(extra, SharedGenerationKey)
}

// managedGeneration decodes one repository-managed generation. Both generations
// share one decoder on purpose: two independent decoders would drift, and a
// value shape accepted at one key and rejected at the other silently changes
// which accounts are considered current.
func managedGeneration(extra map[string]any, key string) int64 {
	value, exists := extra[key]
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

// StripRestoreEpoch removes every repository-managed generation key. Callers use
// it on client-supplied extra so no request body can create, raise or erase a
// generation; the repository writes those keys back from the locked row.
func StripRestoreEpoch(extra map[string]any) map[string]any {
	_, hasRestore := extra[RestoreEpochKey]
	_, hasShared := extra[SharedGenerationKey]
	if !hasRestore && !hasShared {
		return extra
	}
	clean := make(map[string]any, len(extra))
	for key, value := range extra {
		if key == RestoreEpochKey || key == SharedGenerationKey {
			continue
		}
		clean[key] = value
	}
	return clean
}
