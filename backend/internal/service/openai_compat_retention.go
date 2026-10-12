package service

import (
	"sync"
	"sync/atomic"
	"time"
)

// openAICompatRetentionSweepEvery 与 Codex turn-state 溯源表相同：
// 每 256 次真实写入才全量走一遍，避免每次请求都扫描。
// 只删除已经超过自身 ExpiresAt 的项，不引入更短的 TTL。
const openAICompatRetentionSweepEvery uint64 = 256

// openAICompatRetentionDeleteHook 在 CompareAndDelete 之前运行。
// 生产路径保持 nil；测试用它把过期值换成刷新后的值，证明比较删除不会误伤。
type openAICompatRetentionDeleteHook func(m *sync.Map, key, observed any)

var openAICompatRetentionBeforeCompareDelete atomic.Pointer[openAICompatRetentionDeleteHook]

func openAICompatBindingExpired(expiresAt, now time.Time) bool {
	return !expiresAt.IsZero() && now.After(expiresAt)
}

func compareDeleteOpenAICompatEntry(m *sync.Map, key, observed any) {
	if m == nil {
		return
	}
	if hook := openAICompatRetentionBeforeCompareDelete.Load(); hook != nil && *hook != nil {
		(*hook)(m, key, observed)
	}
	m.CompareAndDelete(key, observed)
}

func (s *OpenAIGatewayService) noteOpenAICompatSessionResponseWrite() {
	if s == nil {
		return
	}
	if s.openaiCompatSessionResponseWrites.Add(1)%openAICompatRetentionSweepEvery != 0 {
		return
	}
	s.sweepOpenAICompatSessionResponses()
}

func (s *OpenAIGatewayService) noteOpenAICompatDigestSessionWrite() {
	if s == nil {
		return
	}
	if s.openaiCompatDigestSessionWrites.Add(1)%openAICompatRetentionSweepEvery != 0 {
		return
	}
	s.sweepOpenAICompatDigestSessions()
}

func (s *OpenAIGatewayService) sweepOpenAICompatSessionResponses() {
	if s == nil {
		return
	}
	now := time.Now()
	sweepExpiredOpenAICompatEntries(&s.openaiCompatSessionResponses, func(value any) bool {
		binding, ok := value.(openAICompatSessionResponseBinding)
		return !ok || openAICompatBindingExpired(binding.ExpiresAt, now)
	})
}

func (s *OpenAIGatewayService) sweepOpenAICompatDigestSessions() {
	if s == nil {
		return
	}
	now := time.Now()
	sweepExpiredOpenAICompatEntries(&s.openaiCompatAnthropicDigestSessions, func(value any) bool {
		binding, ok := value.(openAICompatAnthropicDigestBinding)
		return !ok || openAICompatBindingExpired(binding.ExpiresAt, now)
	})
}

func sweepExpiredOpenAICompatEntries(m *sync.Map, drop func(any) bool) {
	if m == nil || drop == nil {
		return
	}
	m.Range(func(key, value any) bool {
		if drop(value) {
			compareDeleteOpenAICompatEntry(m, key, value)
		}
		return true
	})
}
