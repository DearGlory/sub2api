package service

import (
	"encoding/json"
	"strings"

	"github.com/Wei-Shaw/sub2api/internal/pkg/apicompat"
)

// blockDeltaAccumulator buffers the incremental fragments of one Anthropic
// content block during buffered (upstream-streamed, client-non-streaming)
// responses.
//
// Why it exists: the buffered paths used to fold each streamed fragment with
// `s += fragment`. Go strings are immutable, so every `+=` allocates a new
// backing array and copies everything accumulated so far. A response of N bytes
// delivered in fragments of d bytes performs roughly N²/(2d) bytes of copying —
// a 500KB tool-heavy answer in 100-byte deltas copies on the order of a
// gigabyte of garbage per request. That garbage was the dominant driver of the
// GC mark/sweep CPU burn (and the allocation storm that kept RSS pinned against
// the memory limit).
//
// strings.Builder amortizes the same accumulation to O(n) copies, and
// bytes.Buffer does the same for the tool-call JSON fragments. Nothing is
// materialized until flush(), so the values handed downstream are byte-for-byte
// identical to what the naive concatenation produced.
type blockDeltaAccumulator struct {
	text      strings.Builder
	thinking  strings.Builder
	signature strings.Builder
	input     strings.Builder
}

// appendText folds a text_delta fragment.
func (a *blockDeltaAccumulator) appendText(fragment string) {
	// strings.Builder.WriteString never returns a non-nil error; discard explicitly.
	_, _ = a.text.WriteString(fragment)
}

// appendThinking folds a thinking_delta fragment.
func (a *blockDeltaAccumulator) appendThinking(fragment string) {
	_, _ = a.thinking.WriteString(fragment)
}

// appendSignature folds a signature_delta fragment.
func (a *blockDeltaAccumulator) appendSignature(fragment string) {
	_, _ = a.signature.WriteString(fragment)
}

// appendInput folds an input_json_delta fragment. The fragments are the raw
// pieces of a JSON object being streamed one slice at a time; they are
// concatenated as-is and only validated downstream.
func (a *blockDeltaAccumulator) appendInput(fragment string) {
	_, _ = a.input.WriteString(fragment)
}

// flushInto writes the accumulated fragments onto the content block using the
// exact semantics the previous inline concatenation had: only fields that
// actually received fragments are touched, so a block that never saw a given
// delta type keeps whatever value it was seeded with.
func (a *blockDeltaAccumulator) flushInto(block *apicompat.AnthropicContentBlock) {
	if block == nil {
		return
	}
	if a.text.Len() > 0 {
		block.Text += a.text.String()
	}
	if a.thinking.Len() > 0 {
		block.Thinking += a.thinking.String()
	}
	if a.signature.Len() > 0 {
		block.Signature += a.signature.String()
	}
	if a.input.Len() > 0 {
		block.Input = mergeRawJSONFragments(block.Input, a.input.String())
	}
}

// mergeRawJSONFragments is appendRawJSON's rule applied to an already-folded
// fragment string, so the buffered path and the incremental helper agree.
//
// Anthropic seeds tool_use.input with `{}` in content_block_start and then
// streams the real arguments through input_json_delta, so an empty object is a
// placeholder rather than a prefix and must be replaced, not concatenated.
func mergeRawJSONFragments(existing json.RawMessage, fragments string) json.RawMessage {
	if fragments == "" {
		return existing
	}
	if len(existing) == 0 || isEmptyJSONObject(existing) {
		return json.RawMessage(fragments)
	}
	return json.RawMessage(string(existing) + fragments)
}

// flushBlockAccumulators writes every buffered fragment set onto the response's
// content blocks.
//
// Indices that never received a delta are left alone, and indices outside the
// block slice are skipped — the same rows the original `idx < len(Content)`
// guard would have dropped while streaming.
func flushBlockAccumulators(accs map[int]*blockDeltaAccumulator, resp *apicompat.AnthropicResponse) {
	if resp == nil || len(accs) == 0 {
		return
	}
	for idx, acc := range accs {
		if acc == nil || idx < 0 || idx >= len(resp.Content) {
			continue
		}
		acc.flushInto(&resp.Content[idx])
	}
}

// isEmptyJSONObject reports whether raw is a JSON object with no members
// (whitespace tolerated), i.e. the `{}` placeholder Anthropic seeds tool_use
// input with. Invalid or non-object JSON returns false so callers fall back to
// plain concatenation, matching the historical behaviour.
func isEmptyJSONObject(raw json.RawMessage) bool {
	var existingObject map[string]json.RawMessage
	return json.Unmarshal(raw, &existingObject) == nil && existingObject != nil && len(existingObject) == 0
}
