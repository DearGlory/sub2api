package service

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/Wei-Shaw/sub2api/internal/pkg/apicompat"
	"github.com/stretchr/testify/require"
)

// naiveConcatBlock is the pre-optimisation implementation: fold every fragment
// with `+=` straight onto the block. The buffered accumulator must produce the
// exact same bytes, so the test keeps the old code around as the oracle.
type naiveConcatBlock struct {
	text      string
	thinking  string
	signature string
	input     json.RawMessage
}

func (n *naiveConcatBlock) applyDelta(deltaType, fragment string) {
	switch deltaType {
	case "text_delta":
		n.text += fragment
	case "thinking_delta":
		n.thinking += fragment
	case "signature_delta":
		n.signature += fragment
	case "input_json_delta":
		n.input = appendRawJSON(n.input, fragment)
	}
}

// TestBlockDeltaAccumulator_MatchesNaiveConcatenation is the regression guard for
// the O(n²) fix: whatever the buffered path produces must equal the byte-for-byte
// result of the original per-event concatenation, for every delta type,
// including the tool_use `{}` placeholder case.
func TestBlockDeltaAccumulator_MatchesNaiveConcatenation(t *testing.T) {
	t.Parallel()

	longText := strings.Repeat("streamed answer text ", 500)

	cases := []struct {
		name   string
		seed   string // block.Input as seeded by content_block_start
		deltas []struct{ typ, frag string }
	}{
		{
			name: "text only",
			deltas: []struct{ typ, frag string }{
				{"text_delta", "Hello"},
				{"text_delta", ", "},
				{"text_delta", longText},
				{"text_delta", "!"},
			},
		},
		{
			name: "thinking and signature",
			deltas: []struct{ typ, frag string }{
				{"thinking_delta", "step 1. "},
				{"thinking_delta", longText},
				{"signature_delta", "sig-"},
				{"signature_delta", "abc123"},
			},
		},
		{
			name: "tool json seeded with {} placeholder",
			seed: "{}",
			deltas: []struct{ typ, frag string }{
				{"input_json_delta", `{"query":`},
				{"input_json_delta", `"status"}`},
			},
		},
		{
			name: "tool json seeded with whitespace placeholder",
			seed: "{ \n\t }",
			deltas: []struct{ typ, frag string }{
				{"input_json_delta", `{"a":1}`},
			},
		},
		{
			name: "tool json seeded with real content keeps prefixing",
			seed: `{"existing":true}`,
			deltas: []struct{ typ, frag string }{
				{"input_json_delta", `{"query":"status"}`},
			},
		},
		{
			name: "tool json no seed",
			deltas: []struct{ typ, frag string }{
				{"input_json_delta", `{"a":`},
				{"input_json_delta", `2}`},
			},
		},
		{
			name: "mixed deltas on one block",
			seed: "{}",
			deltas: []struct{ typ, frag string }{
				{"text_delta", "answer"},
				{"thinking_delta", "why"},
				{"signature_delta", "s"},
				{"input_json_delta", `{"k":"v"}`},
				{"text_delta", "-tail"},
			},
		},
		{
			name: "empty block never written",
		},
	}

	for _, tc := range cases {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()

			naive := &naiveConcatBlock{}
			if tc.seed != "" {
				naive.input = json.RawMessage(tc.seed)
			}
			acc := &blockDeltaAccumulator{}
			for _, d := range tc.deltas {
				naive.applyDelta(d.typ, d.frag)
				switch d.typ {
				case "text_delta":
					acc.appendText(d.frag)
				case "thinking_delta":
					acc.appendThinking(d.frag)
				case "signature_delta":
					acc.appendSignature(d.frag)
				case "input_json_delta":
					acc.appendInput(d.frag)
				}
			}

			block := apicompat.AnthropicContentBlock{}
			// Seed the real block exactly as content_block_start would: text and
			// thinking start empty, tool_use input starts at the `{}` placeholder.
			if tc.seed != "" {
				block.Input = json.RawMessage(tc.seed)
			}

			acc.flushInto(&block)

			require.Equal(t, naive.text, block.Text, "text mismatch")
			require.Equal(t, naive.thinking, block.Thinking, "thinking mismatch")
			require.Equal(t, naive.signature, block.Signature, "signature mismatch")
			require.Equal(t, string(naive.input), string(block.Input), "input mismatch")
		})
	}
}

// TestMergeRawJSONFragments_MatchesAppendRawJSON pins the folded-fragment helper
// to the per-event helper it mirrors.
func TestMergeRawJSONFragments_MatchesAppendRawJSON(t *testing.T) {
	t.Parallel()

	cases := []struct {
		name     string
		existing string
		frags    []string
	}{
		{"empty existing", "", []string{`{"a":1}`}},
		{"empty object placeholder", "{}", []string{`{"a":`, `1}`}},
		{"whitespace placeholder", "{ \n\t }", []string{`{"a":1}`}},
		{"real prefix", `{"e":true}`, []string{`{"a":1}`}},
		{"invalid json existing falls back to concat", `not-json`, []string{`{"a":1}`}},
		{"empty fragment list", "{}", nil},
		{"empty fragments", `{"e":1}`, []string{"", ""}},
	}

	for _, tc := range cases {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()

			want := json.RawMessage(tc.existing)
			for _, f := range tc.frags {
				want = appendRawJSON(want, f)
			}
			got := mergeRawJSONFragments(json.RawMessage(tc.existing), strings.Join(tc.frags, ""))
			require.Equal(t, string(want), string(got))
		})
	}
}
