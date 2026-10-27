package poison

import (
	"encoding/json"
	"math"
	"testing"
)

// SharedGeneration is repository-managed internal metadata, exactly like the
// restore epoch: 0 when absent, -1 for any value that is not a safe integer.
func TestPoisonSharedGenerationRepresentation(t *testing.T) {
	for _, tc := range []struct {
		name  string
		extra map[string]any
		want  int64
	}{
		{"missing", nil, 0},
		{"empty map", map[string]any{}, 0},
		{"explicit zero", map[string]any{SharedGenerationKey: 0}, 0},
		{"int", map[string]any{SharedGenerationKey: 8}, 8},
		{"int64", map[string]any{SharedGenerationKey: int64(8)}, 8},
		{"json float", map[string]any{SharedGenerationKey: float64(8)}, 8},
		{"json number", map[string]any{SharedGenerationKey: json.Number("8")}, 8},
		{"fraction", map[string]any{SharedGenerationKey: 1.5}, -1},
		{"negative", map[string]any{SharedGenerationKey: -1}, -1},
		{"string", map[string]any{SharedGenerationKey: "8"}, -1},
		{"null", map[string]any{SharedGenerationKey: nil}, -1},
		{"bool", map[string]any{SharedGenerationKey: true}, -1},
		{"nan", map[string]any{SharedGenerationKey: math.NaN()}, -1},
		{"max", map[string]any{SharedGenerationKey: MaxRestoreEpoch}, MaxRestoreEpoch},
		{"overflow", map[string]any{SharedGenerationKey: MaxRestoreEpoch + 1}, -1},
		{"restore epoch key ignored", map[string]any{RestoreEpochKey: 5}, 0},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := SharedGeneration(tc.extra); got != tc.want {
				t.Fatalf("got=%d want=%d", got, tc.want)
			}
		})
	}
}

// Both generations share the same representation rules, so one value shape
// cannot be accepted at one key and rejected at the other.
func TestPoisonSharedGenerationMatchesRestoreEpochRules(t *testing.T) {
	for _, value := range []any{0, 3, int64(3), float64(3), json.Number("3"), -1, 1.5, "3", nil, true, math.NaN(), MaxRestoreEpoch, MaxRestoreEpoch + 1} {
		restore := RestoreEpoch(map[string]any{RestoreEpochKey: value})
		shared := SharedGeneration(map[string]any{SharedGenerationKey: value})
		if restore != shared {
			t.Fatalf("value %#v: restore=%d shared=%d", value, restore, shared)
		}
	}
}

// StripRestoreEpoch removes every repository-managed generation, so no client
// payload can create, raise or erase one.
func TestPoisonSharedGenerationStripRestoreEpoch(t *testing.T) {
	input := map[string]any{RestoreEpochKey: 7, SharedGenerationKey: 8, "keep": "yes"}
	clean := StripRestoreEpoch(input)
	if len(clean) != 1 || clean["keep"] != "yes" {
		t.Fatalf("clean=%v want only keep", clean)
	}
	if input[RestoreEpochKey] != 7 || input[SharedGenerationKey] != 8 {
		t.Fatal("stripping mutated original")
	}
	sharedOnly := map[string]any{SharedGenerationKey: 8, "keep": true}
	if clean := StripRestoreEpoch(sharedOnly); len(clean) != 1 || clean["keep"] != true {
		t.Fatalf("shared-only strip left %v", clean)
	}
	untouched := map[string]any{"keep": int64(1)}
	if clean := StripRestoreEpoch(untouched); len(clean) != 1 || clean["keep"] != int64(1) {
		t.Fatalf("unmanaged extra changed: %v", clean)
	}
	if clean := StripRestoreEpoch(nil); clean != nil {
		t.Fatalf("nil extra must stay nil, got %v", clean)
	}
}
