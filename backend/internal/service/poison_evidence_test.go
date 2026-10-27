package service

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"github.com/Wei-Shaw/sub2api/internal/poison"
	pluginv1 "github.com/Wei-Shaw/sub2api/pkg/pluginapi/v1"
	"github.com/gin-gonic/gin"
	hcplugin "github.com/hashicorp/go-plugin"
	"github.com/stretchr/testify/require"
	"google.golang.org/grpc"
)

func evidenceContext(t *testing.T) (*gin.Context, string) {
	t.Helper()
	dir := t.TempDir()
	c, _ := gin.CreateTestContext(httptest.NewRecorder())
	c.Request = httptest.NewRequest("POST", "/v1/responses", nil)
	st := poison.NewStore(func() (map[string]string, error) {
		return map[string]string{"poison_guard_enabled": "true", "poison_guard_evidence_enabled": "true", "poison_guard_evidence_dir": dir}, nil
	})
	require.NoError(t, st.Reload())
	require.True(t, poison.Attach(c, st.Current(), poison.AccountInfo{BaseURL: "https://kedaya.ai", HasProxy: true, AccountID: 99}))
	t.Cleanup(func() { poison.StatusGuard(c).Close() })
	return c, dir
}
func evidenceBodyFile(t *testing.T, c *gin.Context, dir string) []byte {
	t.Helper()
	poison.Finalize(c)
	entries, err := os.ReadDir(dir)
	require.NoError(t, err)
	require.Len(t, entries, 1)
	raw, err := os.ReadFile(filepath.Join(dir, entries[0].Name(), "response-1.body"))
	require.NoError(t, err)
	return raw
}
func TestPoisonEvidenceHTTPToWSActualForward(t *testing.T) {
	c, dir := evidenceContext(t)
	event := []byte(` {"type":"response.completed","response":{"id":"r","model":"gpt-5.5","status":"completed","output":[{"type":"message","content":[{"type":"output_text","text":"kedaya"}]}]}} `)
	cfg := newOpenAIWSV2TestConfig()
	cfg.Security.URLAllowlist.Enabled = false
	cfg.Security.URLAllowlist.AllowInsecureHTTP = true
	cfg.Gateway.OpenAIWS.MinIdlePerAccount = 0
	conn := &openAIWSCaptureConn{events: [][]byte{event}}
	pool := newOpenAIWSConnPool(cfg)
	pool.setClientDialerForTest(&openAIWSCaptureDialer{conn: conn})
	svc := &OpenAIGatewayService{cfg: cfg, httpUpstream: &httpUpstreamRecorder{}, cache: &stubGatewayCache{}, openaiWSResolver: NewOpenAIWSProtocolResolver(cfg), toolCorrector: NewCodexToolCorrector(), openaiWSPool: pool}
	account := &Account{ID: 99, Platform: PlatformOpenAI, Type: AccountTypeAPIKey, Status: StatusActive, Schedulable: true, Concurrency: 1, Credentials: map[string]any{"api_key": "synthetic"}, Extra: map[string]any{"responses_websockets_v2_enabled": true}}
	result, err := svc.Forward(c.Request.Context(), c, account, []byte(`{"model":"gpt-5.5","stream":false,"input":"hello"}`))
	require.NoError(t, err)
	require.True(t, result.OpenAIWSMode)
	require.Equal(t, event, evidenceBodyFile(t, c, dir))
}

type evidencePluginClient struct {
	pluginv1.TransportPluginClient
	payload []byte
}

func (a *evidencePluginClient) Forward(ctx context.Context, _ ...grpc.CallOption) (pluginv1.TransportPlugin_ForwardClient, error) {
	return &evidencePluginStream{ctx: ctx, payload: a.payload}, nil
}

type evidencePluginStream struct {
	grpc.ClientStream
	ctx     context.Context
	payload []byte
	step    int
}

func (s *evidencePluginStream) Context() context.Context            { return s.ctx }
func (s *evidencePluginStream) Send(*pluginv1.ForwardRequest) error { return nil }
func (s *evidencePluginStream) CloseSend() error                    { return nil }
func (s *evidencePluginStream) Recv() (*pluginv1.ForwardResponse, error) {
	s.step++
	switch s.step {
	case 1:
		return &pluginv1.ForwardResponse{Frame: &pluginv1.ForwardResponse_Start{Start: &pluginv1.ForwardResponseStart{StatusCode: 200}}}, nil
	case 2:
		return &pluginv1.ForwardResponse{Frame: &pluginv1.ForwardResponse_BodyChunk{BodyChunk: s.payload}}, nil
	default:
		return nil, io.EOF
	}
}
func TestPoisonEvidencePluginHandledActualTransport(t *testing.T) {
	c, dir := evidenceContext(t)
	raw := []byte(" {\"text\":\"kedaya\"} \n")
	runtime := &pluginRuntime{client: hcplugin.NewClient(&hcplugin.ClientConfig{}), api: &evidencePluginClient{payload: raw}}
	manager := &PluginManager{}
	manager.route.Store(&pluginRoute{pluginID: 1, rolloutPercent: 100, runtime: runtime})
	svc := &OpenAIGatewayService{pluginManager: manager, httpUpstream: &pluginRoutingHTTPUpstream{}}
	req, _ := http.NewRequestWithContext(c.Request.Context(), "POST", "https://example.invalid/v1/responses", nil)
	response, err := svc.doOpenAIUpstream(req, "", &Account{ID: 99, Platform: PlatformOpenAI, Type: AccountTypeOAuth})
	require.NoError(t, err)
	body, err := io.ReadAll(response.Body)
	require.NoError(t, err)
	require.NoError(t, response.Body.Close())
	c.Data(200, "application/json", body)
	require.Equal(t, raw, evidenceBodyFile(t, c, dir))
	require.Zero(t, runtime.inFlight.Load())
}
