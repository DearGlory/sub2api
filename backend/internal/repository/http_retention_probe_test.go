//go:build unit

package repository

import (
	"bytes"
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"runtime"
	"testing"
)

func TestCompletedHTTPRequestsReleaseLargeBodies(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { io.Copy(io.Discard, r.Body); w.Write([]byte("ok")) }))
	defer server.Close()
	transport := &http.Transport{MaxIdleConnsPerHost: 16}
	defer transport.CloseIdleConnections()
	client := &http.Client{Transport: transport}
	runtime.GC()
	var before, after runtime.MemStats
	runtime.ReadMemStats(&before)
	for i := 0; i < 40; i++ {
		sendRetentionProbe(t, client, server.URL)
	}
	runtime.GC()
	runtime.GC()
	runtime.ReadMemStats(&after)
	growth := int64(after.HeapAlloc) - int64(before.HeapAlloc)
	t.Logf("retained heap bytes=%d", growth)
	if growth > 24<<20 {
		t.Fatalf("completed40 requests retain %d bytes", growth)
	}
	runtime.KeepAlive(client)
}

func TestIdleAccountClientsReleaseLargeBodies(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { io.Copy(io.Discard, r.Body); w.Write([]byte("ok")) }))
	defer server.Close()
	clients := make([]*http.Client, 24)
	for i := range clients {
		transport := &http.Transport{MaxIdleConnsPerHost: 1}
		defer transport.CloseIdleConnections()
		clients[i] = &http.Client{Transport: transport}
	}
	runtime.GC()
	var before, after runtime.MemStats
	runtime.ReadMemStats(&before)
	for _, client := range clients {
		sendRetentionProbe(t, client, server.URL)
	}
	runtime.GC()
	runtime.GC()
	runtime.ReadMemStats(&after)
	growth := int64(after.HeapAlloc) - int64(before.HeapAlloc)
	t.Logf("24 idle account clients retained heap bytes=%d", growth)
	if growth > 24<<20 {
		t.Fatalf("idle account clients retain completed request bodies: %d", growth)
	}
	runtime.KeepAlive(clients)
}

//go:noinline
func sendRetentionProbe(t *testing.T, client *http.Client, url string) {
	body := bytes.Repeat([]byte("x"), 8<<20)
	req, err := http.NewRequestWithContext(context.Background(), http.MethodPost, url, bytes.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	resp, err := doUpstreamRequest(client, req)
	if err != nil {
		t.Fatal(err)
	}
	io.Copy(io.Discard, resp.Body)
	resp.Body.Close()
}
