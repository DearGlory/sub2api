package poison

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"github.com/Wei-Shaw/sub2api/internal/pkg/ctxkey"
	"github.com/gin-gonic/gin"
	"log"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strconv"
	"strings"
	"testing"
	"time"
)

func auditRotator(c []RotationCandidate) *Rotator {
	return &Rotator{ActiveProxies: func(context.Context) ([]RotationCandidate, error) { return c, nil }, Blocked: func(context.Context) (map[int64]struct{}, error) { return nil, nil }, InUse: func(context.Context) (map[string]struct{}, error) { return nil, nil }, IsEgressBlocked: func(context.Context, string) (bool, error) { return false, nil }}
}
func TestDispositionExhaustionAndBudget(t *testing.T) {
	for _, count := range []int{0, 3, 4} {
		t.Run(strconv.Itoa(count), func(t *testing.T) {
			probes, disabled, reports := 0, 0, 0
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { probes++; w.Write([]byte("192.0.2.99")) }))
			defer srv.Close()
			u, _ := url.Parse(srv.URL)
			port, _ := strconv.Atoi(u.Port())
			cs := []RotationCandidate{}
			for i := 0; i < count; i++ {
				cs = append(cs, RotationCandidate{ID: int64(i + 1), Host: "localhost", Port: port + i, Password: "SECRET"})
			}
			// Distinct endpoint identities, served by the same local proxy for this test.
			r := auditRotator(cs)
			r.Prober = &EgressProber{Endpoints: []string{srv.URL}, Timeout: time.Second}
			// Static blacklist exclusion proves exhaustion without any network attempt.
			r.Blocked = func(context.Context) (map[int64]struct{}, error) {
				m := map[int64]struct{}{}
				for _, c := range cs {
					m[c.ID] = struct{}{}
				}
				return m, nil
			}
			var got Disposition
			h := &Handler{Rotator: r, RebindProxy: func(context.Context, int64, int64) error { return nil }, DisableAccount: func(context.Context, int64) error { disabled++; return nil }, ReportDisposition: func(_ Incident, d Disposition) { reports++; got = d }}
			h.Handle(context.Background(), Incident{AccountID: 1, RequestID: "req", EvidenceID: "ev", EvidencePath: "/safe/ev"})
			if disabled != 1 || reports != 1 || got.Outcome != "disabled" || len(got.Selections) == 0 || got.Selections[0].Total != count {
				t.Fatalf("disabled=%d reports=%d disposition=%+v", disabled, reports, got)
			}
			if probes != 0 {
				t.Fatal("blocked candidates must not probe")
			}
		})
	}
}
func TestDispositionUnknownAndBudget(t *testing.T) {
	cs := []RotationCandidate{}
	for i := 1; i <= 4; i++ {
		cs = append(cs, RotationCandidate{ID: int64(i), Host: "192.0.2." + strconv.Itoa(i), Port: 80, Password: "PASSWORD"})
	}
	r := auditRotator(cs)
	binds, disabled, reports := 0, 0, 0
	var got Disposition
	h := &Handler{Rotator: r, RebindProxy: func(context.Context, int64, int64) error {
		binds++
		return errors.New("http://user:PASSWORD@proxy.invalid")
	}, DisableAccount: func(context.Context, int64) error { disabled++; return nil }, ReportDisposition: func(_ Incident, d Disposition) { reports++; got = d }}
	var logs bytes.Buffer
	old := log.Writer()
	log.SetOutput(&logs)
	defer log.SetOutput(old)
	h.Handle(context.Background(), Incident{AccountID: 1, RequestID: "req", EvidenceID: "ev", EvidencePath: "/safe/ev"})
	raw, _ := json.Marshal(got)
	if disabled != 0 || binds != 3 || reports != 1 || got.Outcome != "deferred" || got.Reason != "deferred_attempt_budget" || !got.Retryable || len(got.Attempts) != 3 {
		t.Fatalf("binds=%d disabled=%d reports=%d d=%s", binds, disabled, reports, raw)
	}
	if strings.Contains(string(raw)+logs.String(), "PASSWORD") || !strings.Contains(logs.String(), `"request_id":"req"`) {
		t.Fatalf("unsafe or uncorrelated log: %s", logs.String())
	}
}
func TestDispatchCopiesCorrelation(t *testing.T) {
	old := CurrentHandler()
	defer AttachHandler(old)
	ch := make(chan Incident, 1)
	AttachHandler(&Handler{ReportDisposition: func(i Incident, _ Disposition) { ch <- i }})
	c, _ := gin.CreateTestContext(httptest.NewRecorder())
	c.Request = httptest.NewRequest("GET", "/", nil).WithContext(context.WithValue(context.Background(), ctxkey.RequestID, "req"))
	c.Set(ContextKeyAccountID, int64(1))
	c.Set("poison_guard_evidence_id", "ev")
	c.Set("poison_guard_evidence_path", "/safe/ev")
	Dispatch(c, "hit")
	c.Set("poison_guard_evidence_id", "changed")
	select {
	case i := <-ch:
		if i.RequestID != "req" || i.EvidenceID != "ev" || i.EvidencePath != "/safe/ev" {
			t.Fatalf("%+v", i)
		}
	case <-time.After(time.Second):
		t.Fatal("no report")
	}
}
func TestValidationPreservesTypedError(t *testing.T) {
	c := &RotationCandidate{Host: "localhost", Port: 1}
	r := &Rotator{}
	if err := r.ValidateEgress(context.Background(), c); !errors.Is(err, ErrRotationUnavailable) {
		t.Fatalf("%v", err)
	}
	sentinel := errors.New("lookup failed")
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.Write([]byte("192.0.2.2")) }))
	defer srv.Close()
	u, _ := url.Parse(srv.URL)
	c.Host = u.Hostname()
	c.Port, _ = strconv.Atoi(u.Port())
	r.Prober = &EgressProber{Endpoints: []string{"http://local.invalid/ip"}}
	r.IsEgressBlocked = func(context.Context, string) (bool, error) { return false, sentinel }
	if err := r.ValidateEgress(context.Background(), c); !errors.Is(err, sentinel) {
		t.Fatalf("%v", err)
	}
	r.IsEgressBlocked = func(context.Context, string) (bool, error) { return true, nil }
	if err := r.ValidateEgress(context.Background(), c); !errors.Is(err, ErrEgressBlocked) {
		t.Fatalf("%v", err)
	}
}
