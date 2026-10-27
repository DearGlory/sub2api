package poison

import (
	"context"
	"encoding/json"
	"math"
	"testing"
)

func TestRestoreEpochRepresentation(t *testing.T) {
	for _, tc := range []struct {
		name  string
		value any
		want  int64
	}{
		{"int", 3, 3}, {"int64", int64(3), 3}, {"json float", float64(3), 3}, {"json number", json.Number("3"), 3},
		{"fraction", 1.5, -1}, {"negative", -1, -1}, {"string", "3", -1}, {"null", nil, -1}, {"bool", true, -1}, {"nan", math.NaN(), -1},
		{"max", MaxRestoreEpoch, MaxRestoreEpoch}, {"overflow", MaxRestoreEpoch + 1, -1},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := RestoreEpoch(map[string]any{RestoreEpochKey: tc.value}); got != tc.want {
				t.Fatalf("got=%d want=%d", got, tc.want)
			}
		})
	}
	if RestoreEpoch(nil) != 0 {
		t.Fatal("missing epoch must be zero")
	}
	input := map[string]any{RestoreEpochKey: 7, "keep": "yes"}
	clean := StripRestoreEpoch(input)
	if len(clean) != 1 || clean["keep"] != "yes" || input[RestoreEpochKey] != 7 {
		t.Fatal("stripping mutated original")
	}
	ctx := context.Background()
	if IsAdminRestore(ctx) || !IsAdminRestore(WithAdminRestore(ctx)) {
		t.Fatal("typed restore context broken")
	}
}
