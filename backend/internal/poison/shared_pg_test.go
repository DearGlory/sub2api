//go:build unit

package poison

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"net/url"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	_ "github.com/lib/pq"
)

// sharedTestDB is an isolated PostgreSQL schema per test so concurrent packages
// and parallel tests never share the shared-proxy state document.
type sharedTestDB struct {
	t      *testing.T
	db     *sql.DB
	schema string
}

func newSharedTestDB(t *testing.T) *sharedTestDB {
	t.Helper()
	dsn := os.Getenv("POISON_TEST_POSTGRES_DSN")
	if dsn == "" {
		t.Skip("POISON_TEST_POSTGRES_DSN not configured")
	}
	base, err := sql.Open("postgres", dsn)
	if err != nil {
		t.Fatalf("open base: %v", err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	var database string
	if err := base.QueryRowContext(ctx, "SELECT current_database()").Scan(&database); err != nil {
		t.Fatalf("database: %v", err)
	}
	if database != "poison_accept" {
		t.Fatalf("requires isolated poison_accept database, got %q", database)
	}
	schema := fmt.Sprintf("shared_%d", time.Now().UnixNano())
	if _, err := base.ExecContext(ctx, "CREATE SCHEMA "+schema); err != nil {
		t.Fatalf("create schema: %v", err)
	}
	base.Close()
	scoped := dsn
	sep := "?"
	if strings.Contains(scoped, "?") {
		sep = "&"
	}
	scoped += sep + "search_path=" + url.QueryEscape(schema)
	db, err := sql.Open("postgres", scoped)
	if err != nil {
		t.Fatalf("open scoped: %v", err)
	}
	db.SetMaxOpenConns(12)
	h := &sharedTestDB{t: t, db: db, schema: schema}
	t.Cleanup(func() {
		db.Close()
		admin, err := sql.Open("postgres", dsn)
		if err == nil {
			_, _ = admin.Exec("DROP SCHEMA IF EXISTS " + schema + " CASCADE")
			admin.Close()
		}
	})
	h.exec(`
CREATE TABLE settings(id bigserial primary key, key text unique not null, value text not null, updated_at timestamptz not null default now());
CREATE TABLE proxies(id bigserial primary key, name text not null default '', protocol text not null default 'http', host text not null, port int not null, username text, password text, status text not null default 'active', created_at timestamptz default now(), updated_at timestamptz default now(), deleted_at timestamptz);
CREATE TABLE accounts(id bigserial primary key, name text not null default '', platform text not null default 'anthropic', type text not null default 'apikey', credentials jsonb not null default '{}', extra jsonb not null default '{}', proxy_id bigint references proxies(id) on delete set null, concurrency int not null default 3, priority int not null default 50, status text not null default 'active', schedulable boolean not null default true, error_message text, last_used_at timestamptz, created_at timestamptz default now(), updated_at timestamptz default now(), deleted_at timestamptz);
CREATE TABLE account_groups(account_id bigint not null, group_id bigint not null, priority int not null default 50);
CREATE TABLE scheduler_outbox(id bigserial primary key, event_type text not null, account_id bigint, group_id bigint, payload jsonb, created_at timestamptz default now());
CREATE TABLE poison_blocked_egress(id bigserial primary key, outbound_ip varchar(64) not null, proxy_id bigint, account_id bigint, is_dynamic boolean not null default false, reason varchar(255) not null default '', hit_count int not null default 1, first_hit_at timestamptz not null default now(), last_hit_at timestamptz not null default now());
CREATE UNIQUE INDEX ux_blocked_ip ON poison_blocked_egress(outbound_ip);
INSERT INTO settings(key,value) VALUES('poison_guard_enabled','true'),('poison_guard_shared_enabled','true');
`)
	return h
}

func (h *sharedTestDB) exec(query string, args ...any) {
	h.t.Helper()
	if _, err := h.db.Exec(query, args...); err != nil {
		h.t.Fatalf("exec %q: %v", query, err)
	}
}

func (h *sharedTestDB) one(query string, args ...any) string {
	h.t.Helper()
	var out string
	if err := h.db.QueryRow(query, args...).Scan(&out); err != nil {
		h.t.Fatalf("query %q: %v", query, err)
	}
	return out
}

func (h *sharedTestDB) count(query string, args ...any) int {
	h.t.Helper()
	var n int
	if err := h.db.QueryRow(query, args...).Scan(&n); err != nil {
		h.t.Fatalf("count %q: %v", query, err)
	}
	return n
}

// addProxy inserts a proxy row and returns its id.
func (h *sharedTestDB) addProxy(host string, port int, status string, deleted bool) int64 {
	h.t.Helper()
	var id int64
	err := h.db.QueryRow(`INSERT INTO proxies(name,protocol,host,port,username,password,status,deleted_at)
		VALUES($1,'http',$2,$3,'user','pa55',$4, CASE WHEN $5 THEN NOW() ELSE NULL END) RETURNING id`,
		"p-"+host, host, port, status, deleted).Scan(&id)
	if err != nil {
		h.t.Fatalf("insert proxy: %v", err)
	}
	return id
}

type sharedAcct struct {
	ID         int64
	BaseURL    string
	ProxyID    *int64
	Status     string
	Unschedule bool
	Deleted    bool
	Extra      map[string]any
}

func (h *sharedTestDB) addAccount(a sharedAcct) int64 {
	h.t.Helper()
	extra := a.Extra
	if extra == nil {
		extra = map[string]any{"keep_me": "yes"}
	}
	raw, err := json.Marshal(extra)
	if err != nil {
		h.t.Fatalf("marshal extra: %v", err)
	}
	creds, _ := json.Marshal(map[string]any{"base_url": a.BaseURL, "api_key": "sk-secret-must-not-leak"})
	status := a.Status
	if status == "" {
		status = "active"
	}
	var id int64
	err = h.db.QueryRow(`INSERT INTO accounts(name,platform,type,credentials,extra,proxy_id,status,schedulable,deleted_at)
		VALUES($1,'anthropic','apikey',$2,$3,$4,$5,$6, CASE WHEN $7 THEN NOW() ELSE NULL END) RETURNING id`,
		"防投毒acct", creds, raw, a.ProxyID, status, !a.Unschedule, a.Deleted).Scan(&id)
	if err != nil {
		h.t.Fatalf("insert account: %v", err)
	}
	return id
}

func (h *sharedTestDB) accountProxy(id int64) *int64 {
	h.t.Helper()
	var p *int64
	if err := h.db.QueryRow(`SELECT proxy_id FROM accounts WHERE id=$1`, id).Scan(&p); err != nil {
		h.t.Fatalf("account proxy: %v", err)
	}
	return p
}

func (h *sharedTestDB) accountGeneration(id int64) int64 {
	h.t.Helper()
	var raw []byte
	if err := h.db.QueryRow(`SELECT extra FROM accounts WHERE id=$1`, id).Scan(&raw); err != nil {
		h.t.Fatalf("account extra: %v", err)
	}
	extra := map[string]any{}
	if err := json.Unmarshal(raw, &extra); err != nil {
		h.t.Fatalf("decode extra: %v", err)
	}
	v, ok := extra[SharedGenerationKey]
	if !ok {
		return -1
	}
	switch n := v.(type) {
	case float64:
		return int64(n)
	case int64:
		return n
	case int:
		return int64(n)
	case json.Number:
		parsed, err := n.Int64()
		if err != nil {
			return -1
		}
		return parsed
	}
	return -1
}

func (h *sharedTestDB) outboxBulk() []int64 {
	h.t.Helper()
	rows, err := h.db.Query(`SELECT payload FROM scheduler_outbox WHERE event_type='account_bulk_changed' ORDER BY id`)
	if err != nil {
		h.t.Fatalf("outbox: %v", err)
	}
	defer rows.Close()
	var out []int64
	for rows.Next() {
		var raw []byte
		if err := rows.Scan(&raw); err != nil {
			h.t.Fatalf("scan outbox: %v", err)
		}
		var payload struct {
			AccountIDs []int64 `json:"account_ids"`
		}
		if err := json.Unmarshal(raw, &payload); err != nil {
			h.t.Fatalf("decode outbox: %v", err)
		}
		for _, id := range payload.AccountIDs {
			out = append(out, id)
		}
	}
	return out
}

// lastOutboxBulk returns the account ids of the newest burst only; reconciliation
// and switching legitimately publish separate bursts.
func (h *sharedTestDB) lastOutboxBulk() []int64 {
	h.t.Helper()
	var raw []byte
	err := h.db.QueryRow(`SELECT payload FROM scheduler_outbox WHERE event_type='account_bulk_changed' ORDER BY id DESC LIMIT 1`).Scan(&raw)
	if err != nil {
		h.t.Fatalf("last outbox: %v", err)
	}
	var payload struct {
		AccountIDs []int64 `json:"account_ids"`
	}
	if err := json.Unmarshal(raw, &payload); err != nil {
		h.t.Fatalf("decode outbox: %v", err)
	}
	return payload.AccountIDs
}

// patchState rewrites the persisted coordination document under the same lock the
// coordinator uses, so tests can simulate crashes, peer leases and stale cells.
func (h *sharedTestDB) patchState(mutate func(*SharedState)) {
	h.t.Helper()
	ctx := context.Background()
	tx, err := h.db.BeginTx(ctx, nil)
	if err != nil {
		h.t.Fatalf("begin: %v", err)
	}
	defer tx.Rollback()
	if _, err := tx.ExecContext(ctx, "SELECT pg_advisory_xact_lock($1)", RotationLockKey); err != nil {
		h.t.Fatalf("lock: %v", err)
	}
	var raw string
	if err := tx.QueryRowContext(ctx, `SELECT value FROM settings WHERE key=$1 FOR UPDATE`, SettingSharedState).Scan(&raw); err != nil {
		h.t.Fatalf("state row: %v", err)
	}
	st, err := decodeSharedState(raw)
	if err != nil {
		h.t.Fatalf("decode: %v", err)
	}
	mutate(st)
	encoded, err := encodeSharedState(st)
	if err != nil {
		h.t.Fatalf("encode: %v", err)
	}
	if _, err := tx.ExecContext(ctx, `UPDATE settings SET value=$2 WHERE key=$1`, SettingSharedState, encoded); err != nil {
		h.t.Fatalf("save: %v", err)
	}
	if err := tx.Commit(); err != nil {
		h.t.Fatalf("commit: %v", err)
	}
}

func (h *sharedTestDB) setRestoreEpoch(id int64, epoch int64) {
	h.t.Helper()
	if _, err := h.db.Exec(`UPDATE accounts SET extra = jsonb_set(COALESCE(extra,'{}'::jsonb), ARRAY[$2]::text[], to_jsonb($3::bigint), true) WHERE id=$1`,
		id, RestoreEpochKey, epoch); err != nil {
		h.t.Fatalf("set epoch: %v", err)
	}
}

func (h *sharedTestDB) blockedIPs() map[string]int {
	h.t.Helper()
	rows, err := h.db.Query(`SELECT outbound_ip, hit_count FROM poison_blocked_egress ORDER BY outbound_ip`)
	if err != nil {
		h.t.Fatalf("blocked: %v", err)
	}
	defer rows.Close()
	out := map[string]int{}
	for rows.Next() {
		var ip string
		var hits int
		if err := rows.Scan(&ip, &hits); err != nil {
			h.t.Fatalf("scan blocked: %v", err)
		}
		out[ip] = hits
	}
	return out
}

// probeScript records every probe invocation and answers from a programmable map
// or a per-call behaviour function.
type probeScript struct {
	mu     sync.Mutex
	calls  []probeCall
	count  map[string]int
	script map[string]SharedProbeResult // key: accountID|proxyID
	behave func(call probeCall, nth int) SharedProbeResult
	delay  time.Duration
}

type probeCall struct {
	AccountID int64
	ProxyID   int64
	Model     string
}

func (p *probeScript) fn(_ context.Context, req SharedProbeRequest) (SharedProbeResult, error) {
	p.mu.Lock()
	call := probeCall{AccountID: req.AccountID, ProxyID: req.Proxy.ID, Model: req.Model}
	p.calls = append(p.calls, call)
	if p.count == nil {
		p.count = map[string]int{}
	}
	key := fmt.Sprintf("%d|%d", req.AccountID, req.Proxy.ID)
	p.count[key]++
	nth := p.count[key]
	behave := p.behave
	res, ok := p.script[key]
	delay := p.delay
	p.mu.Unlock()
	if behave != nil {
		res = behave(call, nth)
		res.Model = req.Model
		return res, nil
	}
	if delay > 0 {
		time.Sleep(delay)
	}
	if !ok {
		res = SharedProbeResult{Verdict: "clean", Model: req.Model}
	}
	res.Model = req.Model
	return res, nil
}

func (p *probeScript) snapshot() []probeCall {
	p.mu.Lock()
	defer p.mu.Unlock()
	return append([]probeCall(nil), p.calls...)
}

func (p *probeScript) callsFor(accountID, proxyID int64) int {
	n := 0
	for _, c := range p.snapshot() {
		if c.AccountID == accountID && c.ProxyID == proxyID {
			n++
		}
	}
	return n
}

func sharedTestScope() *Scope {
	return NewScope([]string{"https://kedaya.ai"}, true)
}

func sharedTestSnapshot() *Snapshot {
	return &Snapshot{
		Enabled:       true,
		SharedEnabled: true,
		RotateMax:     3,
		Scope:         sharedTestScope(),
		Detector: NewDetector(Config{
			Veto:      DefaultVetoKeywords(),
			Strong:    DefaultStrongKeywords(),
			Weak:      DefaultWeakKeywords(),
			Threshold: 2,
		}),
	}
}
