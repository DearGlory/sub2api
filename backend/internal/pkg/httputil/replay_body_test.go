package httputil

import (
	"bytes"
	"io"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
)

func TestReplayBodyRedirect(t *testing.T) {
	for _, status := range []int{307, 308} {
		t.Run(http.StatusText(status), func(t *testing.T) {
			body := bytes.Repeat([]byte("replay"), 10000)
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				got, _ := io.ReadAll(r.Body)
				if !bytes.Equal(got, body) {
					t.Error("redirect changed request body")
				}
				if r.URL.Path == "/first" {
					w.Header().Set("Location", "/last")
					w.WriteHeader(status)
					return
				}
				if _, err := w.Write([]byte("ok")); err != nil {
					t.Errorf("write response: %v", err)
				}
			}))
			defer srv.Close()
			req, _ := http.NewRequest("POST", srv.URL+"/first", nil)
			BindReleasableRequestBody(req, body)
			resp, err := srv.Client().Do(req)
			if err != nil {
				t.Fatal(err)
			}
			ReleaseRequestReplay(req)
			_, _ = io.Copy(io.Discard, resp.Body)
			_ = resp.Body.Close()
			if resp.StatusCode != 200 {
				t.Fatal(resp.StatusCode)
			}
		})
	}
}

func TestReplayBodyConcurrentCloseRelease(t *testing.T) {
	req, _ := http.NewRequest("POST", "http://example.invalid", nil)
	BindReleasableRequestBody(req, bytes.Repeat([]byte("x"), 1<<20))
	var wg sync.WaitGroup
	wg.Add(3)
	go func() { defer wg.Done(); _, _ = io.Copy(io.Discard, req.Body) }()
	go func() { defer wg.Done(); _ = req.Body.Close() }()
	go func() { defer wg.Done(); ReleaseRequestReplay(req) }()
	wg.Wait()
}

func TestReplayBodyReleasePreservesActiveReader(t *testing.T) {
	req, _ := http.NewRequest("POST", "http://example.invalid", nil)
	BindReleasableRequestBody(req, []byte("payload"))
	replay, err := req.GetBody()
	if err != nil {
		t.Fatal(err)
	}
	original := req.Body
	_ = original.Close()
	ReleaseRequestReplay(req)
	if _, err = req.GetBody(); err == nil {
		t.Fatal("released replay remains accessible")
	}
	data, err := io.ReadAll(replay)
	if err != nil || !bytes.Equal(data, []byte("payload")) {
		t.Fatalf("active reader changed: %q %v", data, err)
	}
	_ = replay.Close()
	if n, err := original.Read(make([]byte, 1)); n != 0 || err != io.EOF {
		t.Fatalf("closed reader %d %v", n, err)
	}
	ReleaseRequestReplay(req)
}
