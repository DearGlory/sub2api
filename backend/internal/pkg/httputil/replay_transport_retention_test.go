package httputil

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"runtime"
	"sync"
	"testing"
	"time"
)

//go:noinline
func sendLargeReplayProbe(ctx context.Context, client *http.Client, url string) (*http.Response, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, nil)
	if err != nil {
		return nil, err
	}
	BindReleasableRequestBody(req, bytes.Repeat([]byte("x"), 16<<20))
	resp, err := client.Do(req)
	ReleaseRequestReplay(req)
	return resp, err
}

func TestReplayTransportReleasesBodyAfterResponseHeaders(t *testing.T) {
	uploaded, headers, finish := make(chan struct{}), make(chan struct{}), make(chan struct{})
	var headersOnce, finishOnce sync.Once
	releaseHeaders := func() { headersOnce.Do(func() { close(headers) }) }
	releaseFinish := func() { finishOnce.Do(func() { close(finish) }) }
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		n, err := io.Copy(io.Discard, r.Body)
		if err != nil || n != 16<<20 {
			t.Errorf("upload bytes=%d err=%v", n, err)
		}
		close(uploaded)
		select {
		case <-headers:
		case <-r.Context().Done():
			return
		}
		w.Header().Set("Content-Type", "text/plain")
		w.WriteHeader(http.StatusOK)
		_ = http.NewResponseController(w).Flush()
		select {
		case <-finish:
		case <-r.Context().Done():
			return
		}
		fmt.Fprint(w, "ok")
	}))
	defer srv.Close()
	defer releaseFinish()
	defer releaseHeaders()
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	client := srv.Client()
	defer client.CloseIdleConnections()
	runtime.GC()
	var before, after runtime.MemStats
	runtime.ReadMemStats(&before)
	results := make(chan *http.Response, 1)
	errors := make(chan error, 1)
	go func() {
		resp, err := sendLargeReplayProbe(ctx, client, srv.URL)
		if err != nil {
			errors <- err
			return
		}
		results <- resp
	}()
	select {
	case <-uploaded:
	case err := <-errors:
		t.Fatal(err)
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	runtime.GC()
	runtime.GC()
	runtime.ReadMemStats(&after)
	waiting := int64(after.HeapAlloc) - int64(before.HeapAlloc)
	if waiting < 12<<20 {
		t.Fatalf("control failed: waiting upload replay retained only %d", waiting)
	}
	releaseHeaders()
	var resp *http.Response
	select {
	case resp = <-results:
	case err := <-errors:
		t.Fatal(err)
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	defer func() { _ = resp.Body.Close() }()
	runtime.GC()
	runtime.GC()
	runtime.ReadMemStats(&after)
	streaming := int64(after.HeapAlloc) - int64(before.HeapAlloc)
	t.Logf("waiting headers=%d bytes; response open=%d bytes", waiting, streaming)
	if streaming > 4<<20 {
		t.Errorf("response retains sent body: %d", streaming)
	}
	releaseFinish()
	data, err := io.ReadAll(resp.Body)
	if err != nil || string(data) != "ok" {
		t.Fatalf("response=%q err=%v", data, err)
	}
	_ = resp.Body.Close()
	runtime.GC()
	runtime.GC()
	runtime.ReadMemStats(&after)
	idle := int64(after.HeapAlloc) - int64(before.HeapAlloc)
	t.Logf("completed with response and idle client kept alive=%d bytes", idle)
	if idle > 4<<20 {
		t.Errorf("completed request retains body: %d", idle)
	}
	runtime.KeepAlive(resp)
	runtime.KeepAlive(client)
}
