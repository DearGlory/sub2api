package poison

import (
	"context"
	"errors"
	"github.com/DATA-DOG/go-sqlmock"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strconv"
	"testing"
	"time"
)

func TestConfirmedProbeBlockedBudget(t *testing.T) {
	for _, count := range []int{3, 4} {
		t.Run(strconv.Itoa(count), func(t *testing.T) {
			probes, binds, disabled := 0, 0, 0
			cs := []RotationCandidate{}
			for i := 0; i < count; i++ {
				srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { probes++; w.Write([]byte("192.0.2.99")) }))
				defer srv.Close()
				u, _ := url.Parse(srv.URL)
				port, _ := strconv.Atoi(u.Port())
				cs = append(cs, RotationCandidate{ID: int64(i + 1), Host: "localhost", Port: port})
			}
			r := auditRotator(cs)
			r.Prober = &EgressProber{Endpoints: []string{"http://local.invalid/ip"}, Timeout: time.Second}
			r.IsEgressBlocked = func(context.Context, string) (bool, error) { return true, nil }
			var got Disposition
			h := &Handler{Rotator: r, RebindProxy: func(context.Context, int64, int64) error { binds++; return nil }, DisableAccount: func(context.Context, int64) error { disabled++; return nil }, ReportDisposition: func(_ Incident, d Disposition) { got = d }}
			h.Handle(context.Background(), Incident{AccountID: 1})
			want := 0
			reason := "deferred_attempt_budget"
			if count == 3 {
				want = 1
				reason = "candidates_exhausted"
			}
			if probes != 3 || binds != 0 || disabled != want || got.Reason != reason {
				t.Fatalf("probes=%d binds=%d disabled=%d d=%+v", probes, binds, disabled, got)
			}
		})
	}
}

func TestDispositionExitBoundaries(t *testing.T) {
	for _, mode := range []string{"rotate_zero", "missing_active", "missing_blocked", "missing_occupied", "missing_egress", "missing_rebind", "canceled", "stale_entry", "stale_bind", "stale_disable", "probe_timeout"} {
		t.Run(mode, func(t *testing.T) {
			defaultStore.mu.RLock()
			old := defaultStore.st
			defaultStore.mu.RUnlock()
			SetStore(nil)
			defer SetStore(old)
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			r := auditRotator([]RotationCandidate{{ID: 2, Host: "192.0.2.2", Port: 80}})
			disabled, reports := 0, 0
			var got Disposition
			h := &Handler{Rotator: r, RebindIncident: func(context.Context, Incident, int64) error { return nil }, DisableIncident: func(context.Context, Incident) error { disabled++; return nil }, ReportDisposition: func(_ Incident, d Disposition) { reports++; got = d }}
			switch mode {
			case "rotate_zero":
				st := &Store{}
				st.cur.Store(&Snapshot{RotateMax: 0})
				SetStore(st)
			case "missing_active":
				r.ActiveProxies = nil
			case "missing_blocked":
				r.Blocked = nil
			case "missing_occupied":
				r.InUse = nil
			case "missing_egress":
				r.IsEgressBlocked = nil
			case "missing_rebind":
				h.RebindIncident = nil
			case "canceled":
				cancel()
			case "stale_entry":
				h.IncidentCurrent = func(context.Context, Incident) (bool, error) { return false, nil }
			case "stale_bind":
				h.RebindIncident = func(context.Context, Incident, int64) error { return ErrStaleIncident }
			case "stale_disable":
				r.ActiveProxies = func(context.Context) ([]RotationCandidate, error) { return nil, nil }
				h.DisableIncident = func(context.Context, Incident) error { return ErrStaleIncident }
			case "probe_timeout":
				srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { <-r.Context().Done() }))
				defer srv.Close()
				u, _ := url.Parse(srv.URL)
				port, _ := strconv.Atoi(u.Port())
				r.ActiveProxies = func(context.Context) ([]RotationCandidate, error) {
					return []RotationCandidate{{ID: 2, Host: "localhost", Port: port}}, nil
				}
				r.Prober = &EgressProber{Endpoints: []string{"http://local.invalid/ip"}, Timeout: 10 * time.Millisecond}
			}
			h.Handle(ctx, Incident{AccountID: 1})
			want := "deferred"
			if mode == "stale_entry" || mode == "stale_bind" || mode == "stale_disable" {
				want = "stale"
			}
			if reports != 1 || disabled != 0 || got.Outcome != want {
				t.Fatalf("reports=%d disabled=%d d=%+v", reports, disabled, got)
			}
		})
	}
}

func TestIncidentLookupFailureDefers(t *testing.T) {
	h := &Handler{LookupProxy: func(context.Context, int64) (*RotationCandidate, error) { return nil, errors.New("temporary") }, Rotator: auditRotator(nil), RebindProxy: func(context.Context, int64, int64) error { return nil }, DisableAccount: func(context.Context, int64) error { t.Error("lookup error must not disable"); return nil }}
	id := int64(1)
	h.Handle(context.Background(), Incident{AccountID: 1, ProxyID: &id})
}

func TestBlacklistRetryStopsAfterCommit(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	mock.ExpectBegin().WillReturnError(errors.New("temporary"))
	mock.ExpectBegin()
	mock.ExpectExec("SELECT pg_advisory_xact_lock").WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectExec("INSERT INTO poison_blocked_egress").WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectCommit()
	var got Disposition
	bound := 0
	h := &Handler{Egress: NewEgressStore(db), Rotator: auditRotator([]RotationCandidate{{ID: 2, Host: "192.0.2.2", Port: 80}}), RebindProxy: func(context.Context, int64, int64) error { bound++; return nil }, ReportDisposition: func(_ Incident, d Disposition) { got = d }}
	h.Handle(context.Background(), Incident{AccountID: 1, ProxyHost: "192.0.2.1"})
	if got.Blacklist.Status != "saved" || got.Blacklist.Attempts != 2 || bound != 1 {
		t.Fatalf("bound=%d d=%+v", bound, got)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatal(err)
	}
}
