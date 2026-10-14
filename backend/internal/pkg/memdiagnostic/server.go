// Package memdiagnostic exposes opt-in profiles over a private Unix socket.
// Profiles contain allocation stacks; keep downloaded artifacts private.
package memdiagnostic

import (
	"encoding/json"
	"errors"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"runtime/pprof"
	"sync"
	"time"
)

// Start requires an existing private directory and never replaces an existing
// socket or file. An empty path disables diagnostics. No TCP listener or global
// HTTP mux is used. The returned stop function is safe to call repeatedly.
func Start(path string) (func(), error) {
	if path == "" {
		return func() {}, nil
	}
	if !filepath.IsAbs(path) {
		return nil, errors.New("diagnostic socket path must be absolute")
	}
	dir := filepath.Dir(path)
	resolved, err := filepath.EvalSymlinks(dir)
	if err != nil {
		return nil, err
	}
	if resolved != dir {
		return nil, errors.New("diagnostic directory must not contain symlinks")
	}
	fi, err := os.Stat(dir)
	if err != nil {
		return nil, err
	}
	if !fi.IsDir() || fi.Mode().Perm()&0077 != 0 {
		return nil, errors.New("diagnostic directory must be private (0700)")
	}
	if _, err := os.Lstat(path); err == nil || !os.IsNotExist(err) {
		return nil, errors.New("diagnostic socket path already exists or is inaccessible")
	}
	listener, err := net.ListenUnix("unix", &net.UnixAddr{Name: path, Net: "unix"})
	if err != nil {
		return nil, err
	}
	listener.SetUnlinkOnClose(false)
	owned, err := os.Lstat(path)
	if err != nil {
		_ = listener.Close()
		return nil, err
	}
	cleanup := func() {
		if current, e := os.Lstat(path); e == nil && os.SameFile(owned, current) {
			_ = os.Remove(path)
		}
	}
	if err := os.Chmod(path, 0600); err != nil {
		_ = listener.Close()
		cleanup()
		return nil, err
	}
	busy := make(chan struct{}, 1)
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		if r.Method != http.MethodGet {
			w.Header().Set("Allow", "GET")
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		if r.URL.Path != "/memstats" && r.URL.Path != "/heap" && r.URL.Path != "/allocs" && r.URL.Path != "/goroutine" {
			http.NotFound(w, r)
			return
		}
		q, err := url.ParseQuery(r.URL.RawQuery)
		if err != nil {
			http.Error(w, "invalid query", 400)
			return
		}
		for k, v := range q {
			if k != "gc" || r.URL.Path != "/heap" || len(v) != 1 || v[0] != "1" {
				http.Error(w, "unsupported query", 400)
				return
			}
		}
		select {
		case busy <- struct{}{}:
			defer func() { <-busy }()
		default:
			http.Error(w, "diagnostic busy", http.StatusTooManyRequests)
			return
		}
		if r.URL.Path == "/memstats" {
			var m runtime.MemStats
			runtime.ReadMemStats(&m)
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(struct {
				runtime.MemStats
				Goroutines int
			}{m, runtime.NumGoroutine()})
			return
		}
		if q.Get("gc") == "1" {
			runtime.GC()
		}
		profile := pprof.Lookup(r.URL.Path[1:])
		if profile == nil {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "application/octet-stream")
		if err := profile.WriteTo(w, 0); err != nil {
			return
		}
	})
	server := &http.Server{Handler: handler, ReadHeaderTimeout: 3 * time.Second, WriteTimeout: 30 * time.Second, IdleTimeout: 5 * time.Second, MaxHeaderBytes: 4096}
	go func() { _ = server.Serve(listener) }()
	var once sync.Once
	stop := func() { once.Do(func() { _ = server.Close(); _ = listener.Close(); cleanup() }) }
	return stop, nil
}
