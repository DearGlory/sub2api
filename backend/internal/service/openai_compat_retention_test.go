//go:build unit

package service

import (
	"context"
	"fmt"
	"runtime"
	"sync"
	"testing"
	"time"
)

func retainedEntries(m *sync.Map) int {
	n := 0
	m.Range(func(_, _ any) bool {
		n++
		return true
	})
	return n
}

func TestCompatAbandonedSessionsExpireOnNewTraffic(t *testing.T) {
	s := &OpenAIGatewayService{}
	account := &Account{ID: 1}
	expired := time.Now().Add(-time.Hour)
	for i := 0; i < 1024; i++ {
		s.openaiCompatSessionResponses.Store(fmt.Sprintf("abandoned-%d", i), openAICompatSessionResponseBinding{ResponseID: "old", ExpiresAt: expired})
		s.openaiCompatAnthropicDigestSessions.Store(fmt.Sprintf("abandoned-%d", i), openAICompatAnthropicDigestBinding{PromptCacheKey: "old", ExpiresAt: expired})
	}
	for i := 0; i < 512; i++ {
		s.bindOpenAICompatSessionResponseID(context.Background(), nil, account, "active", "response")
		s.bindOpenAICompatAnthropicDigestPromptCacheKey(account, 0, "active", "prompt", "")
	}
	if n := retainedEntries(&s.openaiCompatSessionResponses); n != 1 {
		t.Errorf("expired abandoned response bindings retained: got %d want1", n)
	}
	if n := retainedEntries(&s.openaiCompatAnthropicDigestSessions); n != 1 {
		t.Errorf("expired abandoned digest bindings retained: got %d want1", n)
	}
}

func TestCompatRetentionSweepKeepsLiveAndZeroExpiry(t *testing.T) {
	s := &OpenAIGatewayService{}
	now := time.Now()
	s.openaiCompatSessionResponses.Store("expired", openAICompatSessionResponseBinding{ResponseID: "old", ExpiresAt: now.Add(-time.Second)})
	s.openaiCompatSessionResponses.Store("live", openAICompatSessionResponseBinding{ResponseID: "keep", ExpiresAt: now.Add(time.Hour)})
	s.openaiCompatSessionResponses.Store("forever", openAICompatSessionResponseBinding{ResponseID: "zero"})
	s.openaiCompatSessionResponses.Store("bad", "not-a-binding")
	s.openaiCompatAnthropicDigestSessions.Store("expired", openAICompatAnthropicDigestBinding{PromptCacheKey: "old", ExpiresAt: now.Add(-time.Second)})
	s.openaiCompatAnthropicDigestSessions.Store("live", openAICompatAnthropicDigestBinding{PromptCacheKey: "keep", ExpiresAt: now.Add(time.Hour)})
	s.openaiCompatAnthropicDigestSessions.Store("forever", openAICompatAnthropicDigestBinding{PromptCacheKey: "zero"})
	s.openaiCompatAnthropicDigestSessions.Store("bad", 42)

	s.sweepOpenAICompatSessionResponses()
	s.sweepOpenAICompatDigestSessions()

	if _, ok := s.openaiCompatSessionResponses.Load("expired"); ok {
		t.Fatal("expired response binding survived sweep")
	}
	if _, ok := s.openaiCompatSessionResponses.Load("bad"); ok {
		t.Fatal("corrupt response binding survived sweep")
	}
	if _, ok := s.openaiCompatSessionResponses.Load("live"); !ok {
		t.Fatal("unexpired response binding was deleted")
	}
	if _, ok := s.openaiCompatSessionResponses.Load("forever"); !ok {
		t.Fatal("zero-expiry response binding was deleted")
	}
	if _, ok := s.openaiCompatAnthropicDigestSessions.Load("expired"); ok {
		t.Fatal("expired digest binding survived sweep")
	}
	if _, ok := s.openaiCompatAnthropicDigestSessions.Load("bad"); ok {
		t.Fatal("corrupt digest binding survived sweep")
	}
	if _, ok := s.openaiCompatAnthropicDigestSessions.Load("live"); !ok {
		t.Fatal("unexpired digest binding was deleted")
	}
	if _, ok := s.openaiCompatAnthropicDigestSessions.Load("forever"); !ok {
		t.Fatal("zero-expiry digest binding was deleted")
	}
}

func TestCompatRetentionCadenceAndStickyTTL(t *testing.T) {
	s := &OpenAIGatewayService{}
	account := &Account{ID: 1}
	expired := time.Now().Add(-time.Hour)
	s.openaiCompatSessionResponses.Store("abandoned", openAICompatSessionResponseBinding{ResponseID: "old", ExpiresAt: expired})
	s.openaiCompatAnthropicDigestSessions.Store("abandoned", openAICompatAnthropicDigestBinding{PromptCacheKey: "old", ExpiresAt: expired})

	for i := 0; i < int(openAICompatRetentionSweepEvery-1); i++ {
		s.bindOpenAICompatSessionResponseID(context.Background(), nil, account, "active", "response")
		s.bindOpenAICompatAnthropicDigestPromptCacheKey(account, 0, "active", "prompt", "")
	}
	if _, ok := s.openaiCompatSessionResponses.Load("abandoned"); !ok {
		t.Fatal("response sweep ran before the 256th write")
	}
	if _, ok := s.openaiCompatAnthropicDigestSessions.Load("abandoned"); !ok {
		t.Fatal("digest sweep ran before the 256th write")
	}

	before := time.Now()
	s.bindOpenAICompatSessionResponseID(context.Background(), nil, account, "active", "response")
	s.bindOpenAICompatAnthropicDigestPromptCacheKey(account, 0, "active", "prompt", "")
	if _, ok := s.openaiCompatSessionResponses.Load("abandoned"); ok {
		t.Fatal("expired response binding survived the 256th write")
	}
	if _, ok := s.openaiCompatAnthropicDigestSessions.Load("abandoned"); ok {
		t.Fatal("expired digest binding survived the 256th write")
	}

	want := s.openAIWSResponseStickyTTL()
	raw, ok := s.openaiCompatSessionResponses.Load(openAICompatSessionResponseKey(nil, account, "active"))
	if !ok {
		t.Fatal("active response binding missing")
	}
	responseTTL := raw.(openAICompatSessionResponseBinding).ExpiresAt.Sub(before)
	if responseTTL < want-time.Second || responseTTL > want+2*time.Second {
		t.Fatalf("response sticky ttl changed: got %s want %s", responseTTL, want)
	}
	draw, ok := s.openaiCompatAnthropicDigestSessions.Load(openAICompatAnthropicDigestNamespace(account, 0) + "active")
	if !ok {
		t.Fatal("active digest binding missing")
	}
	digestTTL := draw.(openAICompatAnthropicDigestBinding).ExpiresAt.Sub(before)
	if digestTTL < want-time.Second || digestTTL > want+2*time.Second {
		t.Fatalf("digest sticky ttl changed: got %s want %s", digestTTL, want)
	}
}

func TestCompatRetentionOtherResponseWritesSweep(t *testing.T) {
	account := &Account{ID: 3}
	expired := time.Now().Add(-time.Hour)
	ctx := context.Background()

	t.Run("disable", func(t *testing.T) {
		s := &OpenAIGatewayService{}
		s.openaiCompatSessionResponses.Store("abandoned", openAICompatSessionResponseBinding{ResponseID: "old", ExpiresAt: expired})
		s.openaiCompatSessionResponseWrites.Store(openAICompatRetentionSweepEvery - 1)
		s.disableOpenAICompatSessionContinuation(ctx, nil, account, "active")
		if _, ok := s.openaiCompatSessionResponses.Load("abandoned"); ok {
			t.Fatal("disable write did not sweep abandoned response binding")
		}
	})

	t.Run("delete", func(t *testing.T) {
		s := &OpenAIGatewayService{}
		key := openAICompatSessionResponseKey(nil, account, "active")
		s.openaiCompatSessionResponses.Store(key, openAICompatSessionResponseBinding{
			ResponseID: "resp",
			ExpiresAt:  time.Now().Add(time.Hour),
		})
		s.openaiCompatSessionResponses.Store("abandoned", openAICompatSessionResponseBinding{ResponseID: "old", ExpiresAt: expired})
		s.openaiCompatSessionResponseWrites.Store(openAICompatRetentionSweepEvery - 1)
		s.deleteOpenAICompatSessionResponseID(ctx, nil, account, "active")
		if _, ok := s.openaiCompatSessionResponses.Load("abandoned"); ok {
			t.Fatal("delete write did not sweep abandoned response binding")
		}
	})

	t.Run("turn-state", func(t *testing.T) {
		s := &OpenAIGatewayService{}
		s.openaiCompatSessionResponses.Store("abandoned", openAICompatSessionResponseBinding{ResponseID: "old", ExpiresAt: expired})
		s.openaiCompatSessionResponseWrites.Store(openAICompatRetentionSweepEvery - 1)
		s.bindOpenAICompatSessionTurnState(ctx, nil, account, "active", "blob")
		if _, ok := s.openaiCompatSessionResponses.Load("abandoned"); ok {
			t.Fatal("turn-state write did not sweep abandoned response binding")
		}
		raw, ok := s.openaiCompatSessionResponses.Load(openAICompatSessionResponseKey(nil, account, "active"))
		if !ok || raw.(openAICompatSessionResponseBinding).TurnState != "blob" {
			t.Fatal("turn-state binding missing after sweep")
		}
	})
}

func TestCompatRetentionCompareDeleteKeepsRefresh(t *testing.T) {
	s := &OpenAIGatewayService{}
	account := &Account{ID: 9}
	responseKey := openAICompatSessionResponseKey(nil, account, "active")
	stale := openAICompatSessionResponseBinding{ResponseID: "stale", ExpiresAt: time.Now().Add(-time.Hour)}
	fresh := openAICompatSessionResponseBinding{ResponseID: "fresh", TurnState: "kept", ExpiresAt: time.Now().Add(2 * time.Hour)}
	s.openaiCompatSessionResponses.Store(responseKey, stale)

	digestKey := openAICompatAnthropicDigestNamespace(account, 0) + "chain"
	staleDigest := openAICompatAnthropicDigestBinding{PromptCacheKey: "old", ExpiresAt: time.Now().Add(-time.Hour)}
	freshDigest := openAICompatAnthropicDigestBinding{PromptCacheKey: "new", ExpiresAt: time.Now().Add(2 * time.Hour)}
	s.openaiCompatAnthropicDigestSessions.Store(digestKey, staleDigest)

	hook := openAICompatRetentionDeleteHook(func(m *sync.Map, key, observed any) {
		switch {
		case m == &s.openaiCompatSessionResponses && key == responseKey:
			if observed != (any)(stale) {
				t.Errorf("response sweep observed %+v", observed)
			}
			m.Store(key, fresh)
		case m == &s.openaiCompatAnthropicDigestSessions && key == digestKey:
			if observed != (any)(staleDigest) {
				t.Errorf("digest sweep observed %+v", observed)
			}
			m.Store(key, freshDigest)
		}
	})
	openAICompatRetentionBeforeCompareDelete.Store(&hook)
	t.Cleanup(func() { openAICompatRetentionBeforeCompareDelete.Store(nil) })

	s.sweepOpenAICompatSessionResponses()
	s.sweepOpenAICompatDigestSessions()

	raw, ok := s.openaiCompatSessionResponses.Load(responseKey)
	if !ok {
		t.Fatal("refreshed response binding was deleted")
	}
	if got := raw.(openAICompatSessionResponseBinding); got != fresh {
		t.Fatalf("response binding = %+v, want %+v", got, fresh)
	}
	draw, ok := s.openaiCompatAnthropicDigestSessions.Load(digestKey)
	if !ok {
		t.Fatal("refreshed digest binding was deleted")
	}
	if got := draw.(openAICompatAnthropicDigestBinding); got != freshDigest {
		t.Fatalf("digest binding = %+v, want %+v", got, freshDigest)
	}

	openAICompatRetentionBeforeCompareDelete.Store(nil)
	readHook := openAICompatRetentionDeleteHook(func(m *sync.Map, key, _ any) {
		if m == &s.openaiCompatSessionResponses && key == responseKey {
			m.Store(key, fresh)
		}
	})
	s.openaiCompatSessionResponses.Store(responseKey, stale)
	openAICompatRetentionBeforeCompareDelete.Store(&readHook)
	if id := s.getOpenAICompatSessionResponseID(context.Background(), nil, account, "active"); id != "" {
		t.Fatalf("stale read returned %q", id)
	}
	raw, ok = s.openaiCompatSessionResponses.Load(responseKey)
	if !ok || raw.(openAICompatSessionResponseBinding) != fresh {
		t.Fatalf("read path deleted refreshed response binding: ok=%v value=%+v", ok, raw)
	}
}

func TestCompatRetentionConcurrentRefreshSurvivesSweep(t *testing.T) {
	s := &OpenAIGatewayService{}
	const sessions = 8
	const iters = 80
	var wg sync.WaitGroup
	errCh := make(chan string, sessions*2)
	for i := 0; i < sessions; i++ {
		wg.Add(2)
		go func(i int) {
			defer wg.Done()
			key := fmt.Sprintf("response-%d", i)
			for n := 0; n < iters; n++ {
				stale := openAICompatSessionResponseBinding{ResponseID: "stale", ExpiresAt: time.Now().Add(-time.Minute)}
				fresh := openAICompatSessionResponseBinding{ResponseID: fmt.Sprintf("fresh-%d", n), ExpiresAt: time.Now().Add(time.Hour)}
				s.openaiCompatSessionResponses.Store(key, stale)
				s.openaiCompatSessionResponses.Store(key, fresh)
				s.sweepOpenAICompatSessionResponses()
				raw, ok := s.openaiCompatSessionResponses.Load(key)
				if !ok {
					errCh <- fmt.Sprintf("response %s missing after refresh", key)
					return
				}
				if got := raw.(openAICompatSessionResponseBinding).ResponseID; got != fresh.ResponseID {
					errCh <- fmt.Sprintf("response %s = %s, want %s", key, got, fresh.ResponseID)
					return
				}
			}
		}(i)
		go func(i int) {
			defer wg.Done()
			key := fmt.Sprintf("digest-%d", i)
			for n := 0; n < iters; n++ {
				stale := openAICompatAnthropicDigestBinding{PromptCacheKey: "stale", ExpiresAt: time.Now().Add(-time.Minute)}
				fresh := openAICompatAnthropicDigestBinding{PromptCacheKey: fmt.Sprintf("fresh-%d", n), ExpiresAt: time.Now().Add(time.Hour)}
				s.openaiCompatAnthropicDigestSessions.Store(key, stale)
				s.openaiCompatAnthropicDigestSessions.Store(key, fresh)
				s.sweepOpenAICompatDigestSessions()
				raw, ok := s.openaiCompatAnthropicDigestSessions.Load(key)
				if !ok {
					errCh <- fmt.Sprintf("digest %s missing after refresh", key)
					return
				}
				if got := raw.(openAICompatAnthropicDigestBinding).PromptCacheKey; got != fresh.PromptCacheKey {
					errCh <- fmt.Sprintf("digest %s = %s, want %s", key, got, fresh.PromptCacheKey)
					return
				}
			}
		}(i)
	}
	wg.Wait()
	close(errCh)
	for err := range errCh {
		t.Error(err)
	}
}

func TestCompatRetentionLifecycleHasNoBackgroundTimer(t *testing.T) {
	before := runtime.NumGoroutine()
	s := &OpenAIGatewayService{}
	account := &Account{ID: 1}
	for i := 0; i < int(openAICompatRetentionSweepEvery)+8; i++ {
		s.bindOpenAICompatSessionResponseID(context.Background(), nil, account, "active", "response")
		s.bindOpenAICompatAnthropicDigestPromptCacheKey(account, 0, "active", "prompt", "")
	}
	s.CloseOpenAIWSPool()
	s.bindOpenAICompatSessionResponseID(context.Background(), nil, account, "after-close", "response")
	if _, ok := s.openaiCompatSessionResponses.Load(openAICompatSessionResponseKey(nil, account, "after-close")); !ok {
		t.Fatal("response bind failed after gateway close")
	}
	s.bindOpenAICompatAnthropicDigestPromptCacheKey(account, 0, "after-close", "prompt", "")
	if _, ok := s.openaiCompatAnthropicDigestSessions.Load(openAICompatAnthropicDigestNamespace(account, 0) + "after-close"); !ok {
		t.Fatal("digest bind failed after gateway close")
	}
	after := runtime.NumGoroutine()
	if after > before+5 {
		t.Fatalf("retention started background goroutines: before=%d after=%d", before, after)
	}
}
