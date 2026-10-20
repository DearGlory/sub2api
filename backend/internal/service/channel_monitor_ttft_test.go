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
