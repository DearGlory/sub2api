//go:build unit

package service

import (
	"runtime"
	"strings"
	"testing"
	"time"
)

//go:noinline
func escapedRequestViewFields() []string {
	body := []byte(`{"model":"grok-4.5","prompt_cache_key":"session","previous_response_id":"resp_test","service_tier":"default","reasoning":{"effort":"high"},"input":"` + strings.Repeat("x", 16<<20) + `"}`)
	v := newOpenAIRequestView(body)
	return []string{v.Model, v.PromptCacheKey, v.PreviousResponseID, v.ServiceTier, v.ReasoningEffort}
}
func TestRequestViewEscapedScalarsDoNotRetainRequestBody(t *testing.T) {
	runtime.GC()
	var before, after runtime.MemStats
	runtime.ReadMemStats(&before)
	fields := escapedRequestViewFields()
	runtime.GC()
	runtime.GC()
	runtime.ReadMemStats(&after)
	delta := int64(after.HeapAlloc) - int64(before.HeapAlloc)
	t.Logf("retained bytes for five scalar strings=%d", delta)
	if delta > 1<<20 {
		t.Errorf("small request metadata pins whole body: %d", delta)
	}
	if fields[0] != "grok-4.5" || fields[4] != "high" {
		t.Fatal(fields)
	}
	runtime.KeepAlive(fields)
}

//go:noinline
func recordLargeRequestModelFailure(state *openAIAccountModelTransientState, accountID int64) {
	fields := escapedRequestViewFields()
	state.recordFailure(accountID, fields[0], time.Now())
}

func TestRequestModelFailureStateDoesNotRetainLargeBodies(t *testing.T) {
	state := newOpenAIAccountModelTransientState(32)
	runtime.GC()
	var before, after runtime.MemStats
	runtime.ReadMemStats(&before)
	for i := int64(1); i <= 12; i++ {
		recordLargeRequestModelFailure(state, i)
	}
	runtime.GC()
	runtime.GC()
	runtime.ReadMemStats(&after)
	delta := int64(after.HeapAlloc) - int64(before.HeapAlloc)
	t.Logf("12 account model failure entries retain %d bytes", delta)
	if state.size() != 12 {
		t.Fatalf("lost model failure entries: %d", state.size())
	}
	if delta > 2<<20 {
		t.Errorf("failure state pins completed request bodies: %d", delta)
	}
	runtime.KeepAlive(state)
}
