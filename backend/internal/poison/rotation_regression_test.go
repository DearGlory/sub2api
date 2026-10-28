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
