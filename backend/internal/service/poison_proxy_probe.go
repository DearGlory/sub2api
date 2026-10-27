package service

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"time"

	"github.com/Wei-Shaw/sub2api/internal/pkg/logger"
	"github.com/Wei-Shaw/sub2api/internal/poison"
	"github.com/gin-gonic/gin"
	"go.uber.org/zap"
)

// ProbePoisonProxy runs the existing account connection test once, through one
// specified runtime proxy, purely to judge whether that proxy poisons responses.
//
// Contract (frozen with the shared coordinator):
//   - req.Model is the requested model name; the ordinary test entry performs the
//     account's own mapping, so the probe never maps twice.
//   - req.Proxy is the full runtime proxy configuration, including a soft-deleted
//     proxy row's retained settings. Its credentials are never logged or returned.
//   - The account's real binding, status, extra, rate limits and schedulability are
//     never written. The probe runs on a deep copy of the account with the probe
//     proxy substituted, against a read-only repository whose write methods refuse
//     to execute and are recorded; a recorded write makes the verdict inconclusive.
//   - The verdict comes only from the raw upstream bytes captured by probeUpstream
//     and judged by poison.InspectProbeResponse. Handler-generated TestEvent text is
//     never used as evidence.
//   - clean requires a complete, non-empty, correctly terminated response with no
//     parse or read error. Anything unprovable is inconclusive, never clean.
func (s *AccountTestService) ProbePoisonProxy(ctx context.Context, req poison.SharedProbeRequest) (poison.SharedProbeResult, error) {
	startedAt := time.Now()
	result := poison.SharedProbeResult{
		Model:     req.Model,
		StartedAt: startedAt,
	}
	finish := func(verdict, reason string) (poison.SharedProbeResult, error) {
		result.Verdict = verdict
		result.Reason = reason
		result.FinishedAt = time.Now()
		return result, nil
	}

	if strings.TrimSpace(req.Model) == "" {
		return finish("inconclusive", "model_missing")
	}
	var cancel context.CancelFunc
	ctx, cancel = context.WithTimeout(ctx, 60*time.Second)
	defer cancel()
	ctx = logger.IntoContext(ctx, zap.NewNop())
	if s == nil || s.accountRepo == nil {
		return finish("inconclusive", "service_unavailable")
	}
	if req.Snapshot == nil || req.Snapshot.Detector == nil {
		return finish("inconclusive", "detector_unavailable")
	}
	proxyURL, err := probeProxyURL(req.Proxy)
	if err != nil {
		return finish("inconclusive", "proxy_unconfigured")
	}
	if s.httpUpstream == nil {
		return finish("inconclusive", "upstream_unavailable")
	}

	// Read the real account once. This is the only repository read.
	source, err := s.accountRepo.GetByID(ctx, req.AccountID)
	if err != nil || source == nil {
		return finish("inconclusive", "account_unavailable")
	}
	if why := probeChannelSupported(source); why != "" {
		// Only these channels can be proven to use the probe proxy on the real
		// protocol path. Anything else must not be reported clean.
		return finish("inconclusive", why)
	}

	// A deep copy so nothing the test path does can reach the stored account maps.
	shadow := probeAccountCopy(source)
	// Point the copy at the probe proxy as well. Egress is already forced by
	// probeUpstream; this keeps the two resolutions identical so no branch of the
	// test path can silently fall back to the account's real binding.
	shadow.Proxy = probeProxyFromCandidate(req.Proxy)
	if req.Proxy.ID != 0 {
		id := req.Proxy.ID
		shadow.ProxyID = &id
	}

	repo := &probeAccountRepo{account: shadow}
	upstream := newProbeUpstream(s.httpUpstream, proxyURL)

	// Build the shadow service field by field. Copying the struct would copy two
	// sync.Mutex values (go vet copylocks) and would share the real repository.
	probeService := &AccountTestService{
		accountRepo:               repo,
		geminiTokenProvider:       s.geminiTokenProvider,
		claudeTokenProvider:       s.claudeTokenProvider,
		grokTokenProvider:         s.grokTokenProvider,
		antigravityGatewayService: nil,
		httpUpstream:              upstream,
		cfg:                       s.cfg,
		settingService:            s.settingService,
		tlsFPProfileService:       s.tlsFPProfileService,
		// pluginManager stays nil: a plugin round trip is a separate egress path that
		// would bypass the proxy override and the capture.
		pluginManager:        nil,
		openaiGatewayService: nil,
	}

	recorder := httptest.NewRecorder()
	ginCtx, _ := gin.CreateTestContext(recorder)
	ginCtx.Request = httptest.NewRequest(http.MethodPost, "/internal/poison-probe", nil).WithContext(ctx)
	ginCtx.Set(accountTestBackgroundKey, true)
	// The ordinary test entry, unchanged: same routing, payload, headers and proxy
	// override point. Its error and the recorder body are diagnostic only.
	testErr := probeService.TestAccountConnection(ginCtx, req.AccountID, req.Model, "", AccountTestModeDefault)

	if upstream.capture == nil {
		return finish("inconclusive", "no_upstream_response")
	}

	inspection := poison.InspectProbeResponse(poison.ProbeResponseOptions{
		Detector:     req.Snapshot.Detector,
		HTTPStatus:   upstream.capture.status,
		ContentType:  upstream.capture.contentType,
		Body:         upstream.capture.body,
		ReadErr:      upstream.capture.readErr,
		Truncated:    upstream.capture.truncated,
		ExpectStream: true,
	})

	result.HTTPStatus = upstream.capture.status
	result.ReceivedBytes = upstream.capture.receivedSize
	result.Matched = inspection.Matched
	if len(upstream.capture.body) > 0 {
		sum := sha256.Sum256(upstream.capture.body)
		result.ResponseSHA256 = hex.EncodeToString(sum[:])
	}
	if inspection.Verdict != "poison" {
		if testErr != nil {
			return finish("inconclusive", "account_test_failed")
		}
		if repo.writeCount() > 0 {
			return finish("inconclusive", "state_write_attempted")
		}
		if ctx.Err() != nil {
			return finish("inconclusive", "context_cancelled")
		}
	}
	return finish(inspection.Verdict, inspection.Reason)
}

// probeProxyURL builds the runtime proxy URL from the frozen candidate.
func probeProxyURL(candidate poison.RotationCandidate) (string, error) {
	proxy := probeProxyFromCandidate(candidate)
	if strings.TrimSpace(proxy.Host) == "" || proxy.Port <= 0 {
		return "", errors.New("proxy host or port missing")
	}
	return proxy.URL(), nil
}

func probeProxyFromCandidate(candidate poison.RotationCandidate) *Proxy {
	protocol := strings.TrimSpace(candidate.Protocol)
	if protocol == "" {
		protocol = "http"
	}
	return &Proxy{
		ID:       candidate.ID,
		Name:     candidate.Name,
		Protocol: protocol,
		Host:     strings.TrimSpace(candidate.Host),
		Port:     candidate.Port,
		Username: candidate.Username,
		Password: candidate.Password,
	}
}

// probeChannelSupported reports why a channel cannot be proven to run on the probe
// proxy with the real protocol path, or "" when it can.
//
// Covered: Anthropic apikey, OpenAI apikey (Responses and Chat Completions) and
// Gemini apikey. These are the production channels in scope; every other branch
// reaches a different egress (OAuth tokens, plugins, Vertex/CodeAssist signing, WS,
// media endpoints) whose proxy override and state-freedom cannot be proven here.
func probeChannelSupported(account *Account) string {
	if account == nil {
		return "account_unavailable"
	}
	if account.IsSyntheticUITest() {
		return "synthetic_account"
	}
	if account.Type != AccountTypeAPIKey {
		return "unsupported_account_type"
	}
	if account.IsBedrock() {
		return "unsupported_channel"
	}
	if account.RoutesProtocolByInbound() || account.routesByModel() {
		return "unsupported_channel"
	}
	switch {
	case account.Platform == PlatformAnthropic:
		if strings.TrimSpace(account.GetCredential("api_key")) == "" {
			return "no_credential"
		}
		return ""
	case account.IsOpenAI():
		if strings.TrimSpace(account.GetOpenAIProtocolAPIKey()) == "" {
			return "no_credential"
		}
		if strings.TrimSpace(account.GetOpenAIBaseURL()) == "" {
			return "no_base_url"
		}
		return ""
	case account.IsGemini():
		if strings.TrimSpace(account.GetCredential("api_key")) == "" {
			return "no_credential"
		}
		return ""
	default:
		return "unsupported_platform"
	}
}

// probeAccountCopy deep-copies the account so no shared map or slice can be mutated
// through the copy. Every field the test path reads is carried over, including a
// disabled account's real status: a probe must be able to test a stopped account
// without enabling it.
func probeAccountCopy(source *Account) *Account {
	shadow := &Account{
		ID:                      source.ID,
		Name:                    source.Name,
		Platform:                source.Platform,
		Type:                    source.Type,
		ProxyID:                 source.ProxyID,
		ProxyFallbackOriginID:   source.ProxyFallbackOriginID,
		ProxyFallbackOriginName: source.ProxyFallbackOriginName,
		Concurrency:             source.Concurrency,
		Priority:                source.Priority,
		RateMultiplier:          source.RateMultiplier,
		LoadFactor:              source.LoadFactor,
		Status:                  source.Status,
		ErrorMessage:            source.ErrorMessage,
		LastUsedAt:              source.LastUsedAt,
		ExpiresAt:               source.ExpiresAt,
		AutoPauseOnExpired:      source.AutoPauseOnExpired,
		CreatedAt:               source.CreatedAt,
		UpdatedAt:               source.UpdatedAt,
		Schedulable:             source.Schedulable,
		RateLimitedAt:           source.RateLimitedAt,
		RateLimitResetAt:        source.RateLimitResetAt,
		OverloadUntil:           source.OverloadUntil,
		TempUnschedulableUntil:  source.TempUnschedulableUntil,
		TempUnschedulableReason: source.TempUnschedulableReason,
		SessionWindowStart:      source.SessionWindowStart,
		SessionWindowEnd:        source.SessionWindowEnd,
		SessionWindowStatus:     source.SessionWindowStatus,
		ParentAccountID:         source.ParentAccountID,
		QuotaDimension:          source.QuotaDimension,
		Groups:                  source.Groups,
	}
	if source.Notes != nil {
		notes := *source.Notes
		shadow.Notes = &notes
	}
	shadow.Credentials = probeCloneMap(source.Credentials, 0)
	shadow.Extra = probeCloneMap(source.Extra, 0)
	shadow.Groups = nil
	shadow.GroupIDs = append([]int64(nil), source.GroupIDs...)
	shadow.AccountGroups = append([]AccountGroup(nil), source.AccountGroups...)
	if source.Proxy != nil {
		proxy := *source.Proxy
		shadow.Proxy = &proxy
	}
	return shadow
}

// probeCloneMap copies nested maps and slices so aliasing cannot leak a write back
// into the caller's account.
func probeCloneMap(source map[string]any, depth int) map[string]any {
	if source == nil {
		return nil
	}
	out := make(map[string]any, len(source))
	for key, value := range source {
		out[key] = probeCloneValue(value, depth+1)
	}
	return out
}

func probeCloneValue(value any, depth int) any {
	switch typed := value.(type) {
	case map[string]any:
		return probeCloneMap(typed, depth)
	case []any:
		out := make([]any, len(typed))
		for i, item := range typed {
			out[i] = probeCloneValue(item, depth+1)
		}
		return out
	case []string:
		return append([]string(nil), typed...)
	default:
		return value
	}
}
