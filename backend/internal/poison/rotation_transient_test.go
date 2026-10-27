package poison

import (
	"context"
	"errors"
	"fmt"
	"github.com/DATA-DOG/go-sqlmock"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strconv"
	"testing"
)

func TestTransientDoesNotDisable(t *testing.T) {
	for _, mode := range []string{"active_query", "blocked_query", "occupied_query", "egress_query", "cancel_during_next", "probe_503", "bind_error_four_candidates", "empty_pool", "incident_query"} {
		t.Run(mode, func(t *testing.T) {
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			calls, binds, disabled := 0, 0, 0
			transient := errors.New("temporary database error")
			candidates := []RotationCandidate{}
			for i := 1; i <= 4; i++ {
				candidates = append(candidates, RotationCandidate{ID: int64(i), Host: fmt.Sprintf("192.0.2.%d", i), Port: 8080})
			}
			r := &Rotator{ActiveProxies: func(context.Context) ([]RotationCandidate, error) { calls++; return candidates, nil }, Blocked: func(context.Context) (map[int64]struct{}, error) { return nil, nil }, InUse: func(context.Context) (map[string]struct{}, error) { return nil, nil }, IsEgressBlocked: func(context.Context, string) (bool, error) { return false, nil }}
			h := &Handler{Rotator: r, RebindProxy: func(context.Context, int64, int64) error {
				binds++
				if mode == "bind_error_four_candidates" {
					return transient
				}
				return nil
			}, DisableAccount: func(context.Context, int64) error { disabled++; return nil }}
			switch mode {
			case "active_query":
				r.ActiveProxies = func(context.Context) ([]RotationCandidate, error) { calls++; return nil, transient }
			case "blocked_query":
				r.Blocked = func(context.Context) (map[int64]struct{}, error) { return nil, transient }
			case "occupied_query":
				r.InUse = func(context.Context) (map[string]struct{}, error) { return nil, transient }
			case "egress_query":
				r.IsEgressBlocked = func(context.Context, string) (bool, error) { return false, transient }
			case "cancel_during_next":
				r.ActiveProxies = func(context.Context) ([]RotationCandidate, error) { calls++; cancel(); return nil, ctx.Err() }
			case "probe_503":
				srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(503) }))
				defer srv.Close()
				u, _ := url.Parse(srv.URL)
				port, _ := strconv.Atoi(u.Port())
				for i := range candidates {
					candidates[i].Host = u.Hostname()
					candidates[i].Port = port
				}
				r.Prober = &EgressProber{Endpoints: []string{"http://review.invalid/ip"}}
			case "empty_pool":
				candidates = nil
			case "incident_query":
				h.IncidentCurrent = func(context.Context, Incident) (bool, error) { return false, transient }
			}
			h.Handle(ctx, Incident{AccountID: 372})
			want := 0
			if mode == "empty_pool" {
				want = 1
			}
			if disabled != want {
				t.Fatalf("disable calls=%d want=%d; queries=%d binds=%d", disabled, want, calls, binds)
			}
			if mode == "bind_error_four_candidates" && (calls > 4 || binds != 3) {
				t.Fatalf("queries=%d binds=%d", calls, binds)
			}
		})
	}
}

func TestBlacklistFailureDefers(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	for i := 0; i < 3; i++ {
		mock.ExpectBegin().WillReturnError(errors.New("unavailable"))
	}
	bound, disabled := 0, 0
	h := &Handler{Egress: NewEgressStore(db), Rotator: &Rotator{ActiveProxies: func(context.Context) ([]RotationCandidate, error) {
		return []RotationCandidate{{ID: 2, Host: "192.0.2.2", Port: 80}}, nil
	}}, RebindProxy: func(context.Context, int64, int64) error { bound++; return nil }, DisableAccount: func(context.Context, int64) error { disabled++; return nil }}
	h.Handle(context.Background(), Incident{AccountID: 372, ProxyHost: "192.0.2.1"})
	if bound != 0 || disabled != 0 {
		t.Fatalf("bound=%d disabled=%d want 0,0", bound, disabled)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatal(err)
	}
}
