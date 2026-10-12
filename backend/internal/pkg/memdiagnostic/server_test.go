package memdiagnostic

import (
	"compress/gzip"
	"context"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestPrivateDiagnostic(t *testing.T) {
	closeDisabled, err := Start("")
	if err != nil {
		t.Fatal(err)
	}
	closeDisabled()
	dir := filepath.Join(t.TempDir(), "diag")
	if err := os.Mkdir(dir, 0700); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(dir, "mem.sock")
	stop, err := Start(path)
	if err != nil {
		t.Fatal(err)
	}
	defer stop()
	fi, err := os.Stat(path)
	if err != nil || fi.Mode().Perm() != 0600 {
		t.Fatalf("socket must be private: %v %v", fi, err)
	}
	tr := &http.Transport{DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
		return (&net.Dialer{}).DialContext(ctx, "unix", path)
	}}
	defer tr.CloseIdleConnections()
	client := &http.Client{Transport: tr, Timeout: 15 * time.Second}
	resp, err := client.Get("http://unix/memstats")
	if err != nil {
		t.Fatal(err)
	}
	var stats struct {
		HeapAlloc uint64
		NumGC     uint32
	}
	err = json.NewDecoder(resp.Body).Decode(&stats)
	resp.Body.Close()
	if err != nil || stats.HeapAlloc == 0 {
		t.Fatalf("invalid memory stats: %+v %v", stats, err)
	}
	resp, err = client.Get("http://unix/heap?gc=1")
	if err != nil {
		t.Fatal(err)
	}
	gz, err := gzip.NewReader(resp.Body)
	if err != nil {
		t.Fatal(err)
	}
	n, err := io.Copy(io.Discard, gz)
	gz.Close()
	resp.Body.Close()
	if err != nil || n == 0 {
		t.Fatalf("invalid profile %d %v", n, err)
	}
	for _, path := range []string{"/cmdline", "/debug/pprof/", "/profile", "/heap?debug=2", "/heap?seconds=600"} {
		resp, err = client.Get("http://unix" + path)
		if err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()
		if resp.StatusCode < 400 {
			t.Fatalf("unexpected enabled endpoint %s", path)
		}
	}
	resp, err = client.Post("http://unix/memstats", "text/plain", nil)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusMethodNotAllowed {
		t.Fatalf("POST status %d", resp.StatusCode)
	}
	stop()
	if _, err := os.Lstat(path); !os.IsNotExist(err) {
		t.Fatalf("socket not cleaned: %v", err)
	}
}

func TestRejectUnsafePaths(t *testing.T) {
	for _, p := range []string{"127.0.0.1:9999", "relative.sock"} {
		if stop, err := Start(p); err == nil {
			stop()
			t.Fatalf("accepted %s", p)
		}
	}
	dir := t.TempDir()
	os.Chmod(dir, 0700)
	path := filepath.Join(dir, "existing")
	if err := os.WriteFile(path, []byte("keep"), 0600); err != nil {
		t.Fatal(err)
	}
	if stop, err := Start(path); err == nil {
		stop()
		t.Fatal("overwrote existing file")
	}
	b, _ := os.ReadFile(path)
	if string(b) != "keep" {
		t.Fatal("existing file changed")
	}
	link := filepath.Join(dir, "link")
	if err := os.Symlink(path, link); err != nil {
		t.Fatal(err)
	}
	if stop, err := Start(link); err == nil {
		stop()
		t.Fatal("accepted symlink")
	}
	if err := os.Chmod(dir, 0755); err != nil {
		t.Fatal(err)
	}
	if stop, err := Start(filepath.Join(dir, "public.sock")); err == nil {
		stop()
		t.Fatal("accepted public directory")
	}
}
