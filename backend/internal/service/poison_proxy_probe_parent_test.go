//go:build unit

package service

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/Wei-Shaw/sub2api/internal/config"
	"github.com/Wei-Shaw/sub2api/internal/pkg/tlsfingerprint"
	"github.com/Wei-Shaw/sub2api/internal/poison"
	"github.com/stretchr/testify/require"
)

type parentProbeRepo struct {
	AccountRepository
	account *Account
	writes  int
}

func (r *parentProbeRepo) GetByID(context.Context, int64) (*Account, error) { return r.account, nil }
func (r *parentProbeRepo) SetError(context.Context, int64, string) error    { r.writes++; return nil }
func (r *parentProbeRepo) UpdateExtra(context.Context, int64, map[string]any) error {
	r.writes++
	return nil
}
func (r *parentProbeRepo) SetRateLimited(context.Context, int64, time.Time) error {
	r.writes++
	return nil
}
func (r *parentProbeRepo) ClearError(context.Context, int64) error { r.writes++; return nil }

type parentProbeUpstream struct {
	proxy     string
	accountID int64
	calls     int
}

func (u *parentProbeUpstream) Do(r *http.Request, p string, id int64, n int) (*http.Response, error) {
	return u.DoWithTLS(r, p, id, n, nil)
}
func (u *parentProbeUpstream) DoWithTLS(r *http.Request, p string, id int64, _ int, _ *tlsfingerprint.Profile) (*http.Response, error) {
	u.proxy = p
	u.accountID = id
	u.calls++
	parsed, err := url.Parse(p)
	if err != nil {
		return nil, err
	}
	transport := &http.Transport{Proxy: http.ProxyURL(parsed)}
	client := &http.Client{Transport: transport}
	res, err := client.Do(r)
	transport.CloseIdleConnections()
	return res, err
}
func parentProbeFixture(t *testing.T, platform, mode string, status int, body string) (*AccountTestService, poison.SharedProbeRequest, *parentProbeRepo, *parentProbeUpstream, *int) {
	t.Helper()
	count := new(int)
	proxy := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		*count++
		require.Equal(t, "probe-upstream.invalid", r.URL.Hostname())
		raw, _ := io.ReadAll(r.Body)
		if platform == PlatformGemini {
			require.Contains(t, r.URL.Path, "models/test-model")
		} else {
			var v map[string]any
			require.NoError(t, json.Unmarshal(raw, &v))
			require.Equal(t, "test-model", v["model"])
		}
		w.Header().Set("Content-Type", "text/event-stream")
		if status != 200 {
			w.Header().Set("Content-Type", "application/json")
		}
		w.WriteHeader(status)
		fmt.Fprint(w, body)
	}))
	t.Cleanup(proxy.Close)
	endpoint, _ := url.Parse(proxy.URL)
	port, _ := strconv.Atoi(endpoint.Port())
	bound := int64(99)
	repo := &parentProbeRepo{account: &Account{ID: 22, Platform: platform, Type: AccountTypeAPIKey, Status: "inactive", Schedulable: false, ProxyID: &bound, Proxy: &Proxy{ID: bound, Protocol: "http", Host: "192.0.2.1", Port: 1}, Credentials: map[string]any{"api_key": "synthetic-test", "base_url": "http://probe-upstream.invalid", "model_mapping": map[string]any{"test-alias": "test-model"}}, Extra: map[string]any{"openai_responses_mode": mode}, Concurrency: 1}}
	upstream := &parentProbeUpstream{}
	cfg := &config.Config{}
	cfg.Security.URLAllowlist.Enabled = false
	cfg.Security.URLAllowlist.AllowInsecureHTTP = true
	svc := NewAccountTestService(repo, nil, nil, nil, nil, upstream, cfg, nil)
	req := poison.SharedProbeRequest{AccountID: 22, Model: "test-alias", Proxy: poison.RotationCandidate{ID: 7, Protocol: "http", Host: endpoint.Hostname(), Port: port}, Snapshot: &poison.Snapshot{Detector: poison.NewDetector(poison.Config{Veto: []string{"kedaya"}, Strong: []string{"窃"}, Weak: []string{"Key", "密钥"}, Threshold: 3})}}
	return svc, req, repo, upstream, count
}
func TestParentPoisonProbeRealProtocolPaths(t *testing.T) {
	for _, tc := range []struct{ name, platform, mode, body string }{
		{"responses", PlatformOpenAI, "force_responses", "data: {\"type\":\"response.output_text.delta\",\"delta\":\"hello\"}\n\ndata: {\"type\":\"response.completed\"}\n\n"},
		{"chat", PlatformOpenAI, "force_chat_completions", "data: {\"choices\":[{\"delta\":{\"content\":\"hello\"}}]}\n\ndata: [DONE]\n\n"},
		{"anthropic", PlatformAnthropic, "", "data: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"hello\"}}\n\ndata: {\"type\":\"message_stop\"}\n\n"},
		{"gemini", PlatformGemini, "", "data: {\"candidates\":[{\"content\":{\"parts\":[{\"text\":\"hello\"}]},\"finishReason\":\"STOP\"}]}\n\n"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			svc, req, repo, upstream, count := parentProbeFixture(t, tc.platform, tc.mode, 200, tc.body)
			before, _ := json.Marshal(repo.account)
			res, err := svc.ProbePoisonProxy(context.Background(), req)
			require.NoError(t, err)
			require.Equal(t, "clean", res.Verdict, res.Reason)
			require.Equal(t, 1, *count)
			require.Equal(t, int64(0), upstream.accountID)
			require.Equal(t, req.Proxy.ProxyURL(), upstream.proxy)
			require.Zero(t, repo.writes)
			after, _ := json.Marshal(repo.account)
			require.JSONEq(t, string(before), string(after))
			require.NotEmpty(t, res.ResponseSHA256)
		})
	}
}
func TestParentPoisonProbePoisonErrorWinsWithoutWrites(t *testing.T) {
	svc, req, repo, _, _ := parentProbeFixture(t, PlatformOpenAI, "force_responses", 401, `{"error":{"message":"kedaya"}}`)
	res, err := svc.ProbePoisonProxy(context.Background(), req)
	require.NoError(t, err)
	require.Equal(t, "poison", res.Verdict, res.Reason)
	require.Zero(t, repo.writes)
}
func TestParentPoisonProbeEmptyModelDoesNotUseDefault(t *testing.T) {
	svc, req, _, u, count := parentProbeFixture(t, PlatformOpenAI, "force_responses", 200, "")
	req.Model = ""
	res, err := svc.ProbePoisonProxy(context.Background(), req)
	require.NoError(t, err)
	require.Equal(t, "inconclusive", res.Verdict)
	require.Equal(t, 0, *count)
	require.Zero(t, u.calls)
}
func TestParentPoisonProbeRejectsIncompleteAndErrorEnvelope(t *testing.T) {
	for _, body := range []string{"data: {\"type\":\"response.output_text.delta\",\"delta\":\"hello\"}\n\n", `{"error":{"message":"ordinary failure"}}`} {
		svc, req, _, _, _ := parentProbeFixture(t, PlatformOpenAI, "force_responses", 200, body)
		res, err := svc.ProbePoisonProxy(context.Background(), req)
		require.NoError(t, err)
		require.Equal(t, "inconclusive", res.Verdict, res.Reason)
	}
}
func TestParentPoisonProbeCloneNestedMap(t *testing.T) {
	root := map[string]any{}
	cursor := root
	for i := 0; i < 9; i++ {
		next := map[string]any{}
		cursor["nested"] = next
		cursor = next
	}
	cursor["marker"] = "original"
	copy := probeCloneMap(root, 0)
	cursor = copy
	for i := 0; i < 9; i++ {
		cursor = cursor["nested"].(map[string]any)
	}
	cursor["marker"] = "changed"
	raw, _ := json.Marshal(root)
	if strings.Contains(string(raw), "changed") {
		t.Fatal("deep clone aliased source")
	}
}
