package poison

import (
	"context"
	"encoding/base64"
	"errors"
	"github.com/DATA-DOG/go-sqlmock"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strconv"
	"testing"
	"time"
)

func TestRotationHydratesProxyID(t *testing.T) {
	id := int64(7)
	called := false
	h := &Handler{LookupProxy: func(ctx context.Context, got int64) (*RotationCandidate, error) {
		called = true
		if got != id {
			t.Fatalf("wrong proxy id %d", got)
		}
		return &RotationCandidate{ID: id, Host: "192.0.2.7", Port: 1080}, nil
	}}
	ip, dynamic := h.resolveEgress(context.Background(), Incident{ProxyID: &id})
	if !called || ip != "192.0.2.7" || dynamic {
		t.Fatalf("missing hydrated egress: %q dynamic=%v called=%v", ip, dynamic, called)
	}
	h.LookupProxy = func(context.Context, int64) (*RotationCandidate, error) { return nil, errors.New("unavailable") }
	if ip, _ := h.resolveEgress(context.Background(), Incident{ProxyID: &id}); ip != "" {
		t.Fatal("lookup failure invented egress")
	}
}

func TestRotationRejectsHostnameRecord(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if err := NewEgressStore(db).Record(context.Background(), "dynamic.invalid", nil, nil, true, "incident"); err == nil {
		t.Fatal("hostname must not be recorded")
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatal(err)
	}
}

func TestRotationDynamicCandidateValidation(t *testing.T) {
	defaultStore.mu.RLock()
	old := defaultStore.st
	defaultStore.mu.RUnlock()
	SetStore(nil)
	defer SetStore(old)
	for _, mode := range []string{"clean", "dirty", "probe-error", "lookup-error"} {
		t.Run(mode, func(t *testing.T) {
			requests := 0
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				requests++
				want := "Basic " + base64.StdEncoding.EncodeToString([]byte("session-user:p@ss:word"))
				if r.Header.Get("Proxy-Authorization") != want {
					t.Error("proxy authentication not preserved")
				}
				if mode == "probe-error" {
					w.WriteHeader(http.StatusBadGateway)
					return
				}
				w.Write([]byte("192.0.2.20"))
			}))
			defer srv.Close()
			u, _ := url.Parse(srv.URL)
			_, portText, _ := net.SplitHostPort(u.Host)
			port, _ := strconv.Atoi(portText)
			c := RotationCandidate{ID: 2, Host: "localhost", Port: port, Protocol: "http", Username: "session-user", Password: "p@ss:word"}
			checked := false
			r := &Rotator{Prober: &EgressProber{Endpoints: []string{"http://egress.invalid/ip"}, Timeout: time.Second}, IsEgressBlocked: func(ctx context.Context, ip string) (bool, error) {
				checked = true
				if ip != "192.0.2.20" {
					t.Fatalf("checked wrong IP %q", ip)
				}
				if mode == "lookup-error" {
					return false, errors.New("unavailable")
				}
				return mode == "dirty", nil
			}}
			err := r.ValidateEgress(context.Background(), &c)
			if (err == nil) != (mode == "clean") {
				t.Fatalf("mode %s error=%v", mode, err)
			}
			if requests != 1 || (checked && mode == "probe-error") {
				t.Fatalf("requests=%d checked=%v", requests, checked)
			}
		})
	}
}

func TestRotationThreeFailuresDeferWithoutBinding(t *testing.T) {
	defaultStore.mu.RLock()
	old := defaultStore.st
	defaultStore.mu.RUnlock()
	st := &Store{}
	st.cur.Store(&Snapshot{RotateMax: 99, EgressProbe: true})
	SetStore(st)
	defer SetStore(old)
	attempts := 0
	bound := 0
	disabled := 0
	var candidates []RotationCandidate
	for i := int64(1); i <= 5; i++ {
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { attempts++; w.WriteHeader(http.StatusBadGateway) }))
		defer srv.Close()
		u, _ := url.Parse(srv.URL)
		_, portText, _ := net.SplitHostPort(u.Host)
		port, _ := strconv.Atoi(portText)
		candidates = append(candidates, RotationCandidate{ID: i, Host: "localhost", Port: port, Protocol: "http"})
	}
	r := &Rotator{ActiveProxies: func(context.Context) ([]RotationCandidate, error) {
		return candidates, nil
	}, Prober: &EgressProber{Endpoints: []string{"http://egress.invalid/ip"}, Timeout: time.Second}}
	r.Blocked = func(context.Context) (map[int64]struct{}, error) { return nil, nil }
	r.InUse = func(context.Context) (map[string]struct{}, error) { return nil, nil }
	r.IsEgressBlocked = func(context.Context, string) (bool, error) { return false, nil }
	h := &Handler{Rotator: r, RebindProxy: func(context.Context, int64, int64) error { bound++; return nil }, DisableAccount: func(context.Context, int64) error { disabled++; return nil }}
	h.Handle(context.Background(), Incident{AccountID: 42})
	if attempts != 3 || bound != 0 || disabled != 0 {
		t.Fatalf("attempts=%d bound=%d disabled=%d", attempts, bound, disabled)
	}
}

func TestRotationLookupErrorsFailClosed(t *testing.T) {
	for _, kind := range []string{"blocked", "inuse", "egress"} {
		t.Run(kind, func(t *testing.T) {
			sentinel := errors.New("lookup unavailable")
			r := &Rotator{ActiveProxies: func(context.Context) ([]RotationCandidate, error) {
				return []RotationCandidate{{ID: 1, Host: "192.0.2.1", Port: 80}}, nil
			}}
			switch kind {
			case "blocked":
				r.Blocked = func(context.Context) (map[int64]struct{}, error) { return nil, sentinel }
			case "inuse":
				r.InUse = func(context.Context) (map[string]struct{}, error) { return nil, sentinel }
			case "egress":
				r.IsEgressBlocked = func(context.Context, string) (bool, error) { return false, sentinel }
			}
			got, err := r.Next(context.Background(), nil)
			if got != nil || !errors.Is(err, sentinel) {
				t.Fatalf("lookup failure must return no candidate and preserve error; candidate=%v err=%v", got != nil, err)
			}
		})
	}
}

func TestRotationUnknownDynamicEgressIsNotHostname(t *testing.T) {
	h := &Handler{}
	ip, dynamic := h.resolveEgress(context.Background(), Incident{ProxyHost: "dynamic.invalid", ProxyPort: 80})
	if ip != "" || !dynamic {
		t.Fatalf("unknown egress must remain empty, got %q dynamic=%v", ip, dynamic)
	}
}

func TestRotationProbeRejectsErrorStatus(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusForbidden)
		w.Write([]byte("192.0.2.10"))
	}))
	defer srv.Close()
	p := &EgressProber{Endpoints: []string{srv.URL}, Timeout: time.Second}
	if ip, err := p.Probe(context.Background(), ""); err == nil || ip != "" {
		t.Fatalf("HTTP error must not establish egress, got %q error=%v", ip, err)
	}
}
