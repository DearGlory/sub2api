package service

import (
	"strings"
	"testing"
	"time"
)

func TestFirstTokenFromSSELineMatchesContentDelta(t *testing.T) {
	start := time.Now().Add(-120 * time.Millisecond)

	elapsed, ok := firstTokenFromSSELine(`data: {"choices":[{"delta":{"content":"1"}}]}`, start)
	if !ok {
		t.Fatal("a content delta must count as the first token")
	}
	if elapsed < 120*time.Millisecond {
		t.Fatalf("elapsed %v must be measured from the request start", elapsed)
	}
}

func TestFirstTokenFromSSELineCountsReasoningDeltas(t *testing.T) {
	start := time.Now()
	for _, line := range []string{
		`data: {"choices":[{"delta":{"reasoning_content":"thinking"}}]}`,
		`data: {"choices":[{"delta":{"reasoning":"thinking"}}]}`,
	} {
		if _, ok := firstTokenFromSSELine(line, start); !ok {
			t.Fatalf("a reasoning delta is the first token a thinking model emits: %s", line)
		}
	}
}

func TestFirstTokenFromSSELineMatchesResponsesDeltas(t *testing.T) {
	// `responses` monitors stream a completely different envelope from
	// chat_completions: the token arrives as a typed event with a top-level
	// "delta", not inside choices[]. Missing this shape is what left every
	// responses-mode monitor with a NULL TTFT.
	start := time.Now().Add(-90 * time.Millisecond)
	for _, line := range []string{
		`data: {"type":"response.output_text.delta","delta":"Hello"}`,
		`data: {"type":"response.reasoning_text.delta","delta":"thinking"}`,
		`data: {"type":"response.reasoning_summary_text.delta","delta":"summary"}`,
	} {
		elapsed, ok := firstTokenFromSSELine(line, start)
		if !ok {
			t.Fatalf("a responses delta event carries the first token: %s", line)
		}
		if elapsed < 90*time.Millisecond {
			t.Fatalf("elapsed %v must be measured from the request start", elapsed)
		}
	}
}

func TestFirstTokenFromSSELineIgnoresResponsesLifecycleEvents(t *testing.T) {
	// Lifecycle events precede the first token; counting them would report a
	// TTFT that only measures how fast the upstream accepted the request.
	start := time.Now()
	for _, line := range []string{
		`data: {"type":"response.created"}`,
		`data: {"type":"response.in_progress"}`,
		`data: {"type":"response.output_item.added"}`,
		`data: {"type":"response.completed"}`,
		`data: {"type":"response.output_text.delta","delta":""}`,
	} {
		if _, ok := firstTokenFromSSELine(line, start); ok {
			t.Fatalf("a lifecycle event or empty delta is not a first token: %s", line)
		}
	}
}

func TestFirstTokenFromSSELineIgnoresNonTokenFrames(t *testing.T) {
	start := time.Now()
	for _, line := range []string{
		// A role-only preamble arrives before any token and is not a first token.
		`data: {"choices":[{"delta":{"role":"assistant"}}]}`,
		`data: {"choices":[{"delta":{"content":""}}]}`,
		`data: [DONE]`,
		`data:`,
		`: keep-alive comment`,
		`event: message_start`,
		`not-json`,
	} {
		if elapsed, ok := firstTokenFromSSELine(line, start); ok {
			t.Fatalf("line must not be treated as a first token (got %v): %s", elapsed, line)
		}
	}
}

func TestReadFirstTokenDeltaStopsAtTheFirstToken(t *testing.T) {
	const body = "data: {\"choices\":[{\"delta\":{\"role\":\"assistant\"}}]}\n\n" +
		"data: {\"choices\":[{\"delta\":{\"content\":\"1\"}}]}\n\n" +
		"data: {\"choices\":[{\"delta\":{\"content\":\"more\"}}]}\n\n" +
		"data: [DONE]\n\n"

	got, err := readFirstTokenDelta(strings.NewReader(body), time.Now())
	if err != nil {
		t.Fatalf("read first token: %v", err)
	}
	if got == nil {
		t.Fatal("expected a first-token sample")
	}
}

func TestReadFirstTokenDeltaReportsNoSampleForEmptyStream(t *testing.T) {
	// A stream that closes without a delta yields no sample rather than a zero
	// duration, so the page shows '-' instead of a fake 0ms.
	got, err := readFirstTokenDelta(strings.NewReader("data: [DONE]\n\n"), time.Now())
	if err != nil {
		t.Fatalf("read first token: %v", err)
	}
	if got != nil {
		t.Fatalf("an empty stream must not produce a sample, got %v", *got)
	}
}

func TestBuildStreamingProbeBodyForcesStreamAndSmallBudget(t *testing.T) {
	adapter, _, ok := providerAdapterFor(MonitorProviderOpenAI, MonitorAPIModeChatCompletions)
	if !ok {
		t.Fatal("openai chat adapter must exist")
	}
	body, err := buildStreamingProbeBody(adapter, MonitorProviderOpenAI, MonitorAPIModeChatCompletions, "gpt-5")
	if err != nil {
		t.Fatalf("build streaming probe body: %v", err)
	}
	text := string(body)
	if !strings.Contains(text, `"stream":true`) {
		t.Fatalf("probe body must request a stream: %s", text)
	}
	if !strings.Contains(text, `"max_tokens":8`) {
		t.Fatalf("probe body must cap output tokens: %s", text)
	}
	if !strings.Contains(text, `"gpt-5"`) {
		t.Fatalf("probe body must keep the requested model: %s", text)
	}
}

func TestFirstTokenFromSSELineMatchesAnthropicNativeDeltas(t *testing.T) {
	start := time.Now().Add(-80 * time.Millisecond)

	for _, tc := range []struct {
		name string
		line string
	}{
		{"text_delta", `data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"1"}}`},
		{"thinking_delta", `data: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"hmm"}}`},
		{"input_json_delta", `data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{"}}`},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if _, ok := firstTokenFromSSELine(tc.line, start); !ok {
				t.Fatalf("anthropic native delta must count as the first token: %s", tc.line)
			}
		})
	}
}

// A pinned `Delta string` field made json.Unmarshal fail on the object-shaped
// anthropic delta, which silently discarded the whole frame — choices included —
// and every non-Grok monitor stored a NULL ttft.
func TestFirstTokenFromSSELineAnthropicObjectDeltaDoesNotBreakChoices(t *testing.T) {
	start := time.Now()

	if _, ok := firstTokenFromSSELine(
		`data: {"choices":[{"delta":{"content":"1"}}],"type":"content_block_delta","delta":{"type":"text_delta","text":"1"}}`,
		start,
	); !ok {
		t.Fatal("an object-shaped delta must not invalidate a frame that also carries choices")
	}
}

func TestFirstTokenFromSSELineIgnoresAnthropicLifecycleEvents(t *testing.T) {
	start := time.Now()

	for _, line := range []string{
		`data: {"type":"message_start","message":{"id":"msg_1","content":[]}}`,
		`data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}`,
		`data: {"type":"content_block_stop","index":0}`,
		`data: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}`,
		`data: {"type":"message_stop"}`,
		`data: {"type":"ping"}`,
	} {
		if _, ok := firstTokenFromSSELine(line, start); ok {
			t.Fatalf("lifecycle frame carries no token: %s", line)
		}
	}
}
