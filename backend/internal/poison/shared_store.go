package poison

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"strings"
	"time"

	"github.com/lib/pq"
)

// sharedQueryer is the subset of *sql.DB / *sql.Tx used by the read helpers.
type sharedQueryer interface {
	ExecContext(context.Context, string, ...any) (sql.Result, error)
	QueryContext(context.Context, string, ...any) (*sql.Rows, error)
	QueryRowContext(context.Context, string, ...any) *sql.Row
}

// sharedAccount is one row of the eligibility query. Only the fields the shared
// coordinator needs are read; credentials never leave the database.
type sharedAccount struct {
	ID           int64
	BaseURL      string
	ProxyID      *int64
	Status       string
	Schedulable  bool
	RestoreEpoch int64
	Generation   int64
	GroupIDs     []int64
}

func (a sharedAccount) hasProxy() bool { return a.ProxyID != nil }

// withState runs fn inside one transaction holding both the rotation advisory
// lock and the state row lock, then persists the document. Every mutation of the
// shared document and of account bindings happens through here, so concurrent
// instances serialize instead of interleaving.
func (s *SharedCoordinator) withState(ctx context.Context, fn func(*sql.Tx, *SharedState) error) error {
	if s == nil || s.db == nil {
		return ErrRotationUnavailable
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	if !s.sharedEnabled() {
		return ErrSharedDisabled
	}
	if _, err := tx.ExecContext(ctx, "SELECT pg_advisory_xact_lock($1)", RotationLockKey); err != nil {
		return err
	}
	var enabled bool
	if err := tx.QueryRowContext(ctx, `SELECT
      COALESCE((SELECT lower(btrim(value)) IN ('true','1') FROM settings WHERE key=$1),false)
      AND COALESCE((SELECT lower(btrim(value)) IN ('true','1') FROM settings WHERE key=$2),false)`, SettingSharedEnabled, SettingEnabled).Scan(&enabled); err != nil {
		return err
	}
	if !enabled {
		return ErrSharedDisabled
	}
	if _, err := tx.ExecContext(ctx, `INSERT INTO settings(key,value) VALUES($1,'{}') ON CONFLICT (key) DO NOTHING`, SettingSharedState); err != nil {
		return err
	}
	var raw string
	if err := tx.QueryRowContext(ctx, `SELECT value FROM settings WHERE key=$1 FOR UPDATE`, SettingSharedState).Scan(&raw); err != nil {
		return err
	}
	st, err := decodeSharedState(raw)
	if err != nil {
		return err
	}
	if err := fn(tx, st); err != nil {
		return err
	}
	encoded, err := encodeSharedState(st)
	if err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `UPDATE settings SET value=$2, updated_at=NOW() WHERE key=$1`, SettingSharedState, encoded); err != nil {
		return err
	}
	return tx.Commit()
}

// readState loads the document without any lock; used by State() and by the
// read-only preflight steps that must stay outside the write transaction.
func (s *SharedCoordinator) readState(ctx context.Context) (*SharedState, error) {
	if s == nil || s.db == nil {
		return &SharedState{}, nil
	}
	var raw string
	err := s.db.QueryRowContext(ctx, `SELECT value FROM settings WHERE key=$1`, SettingSharedState).Scan(&raw)
	if errors.Is(err, sql.ErrNoRows) {
		return &SharedState{}, nil
	}
	if err != nil {
		return nil, err
	}
	return decodeSharedState(raw)
}

func (s *SharedCoordinator) snapshot() *Snapshot {
	if s == nil || s.opts.Snapshot == nil {
		return CurrentSnapshot()
	}
	return s.opts.Snapshot()
}

// sharedEnabled reports whether the parent has switched the shared mode on and
// the guard itself is active. Workers double-check this on every tick so a hot
// reload disables all probing without a restart.
func (s *SharedCoordinator) sharedEnabled() bool {
	snap := s.snapshot()
	return snap != nil && snap.SharedEnabled && snap.Active()
}

// eligibleAccounts returns every admitted account: not deleted, bound to a proxy
// and matching the configured upstream prefixes. Inactive or unschedulable
// accounts are deliberately included — they follow the shared proxy but keep
// their own running state.
func (s *SharedCoordinator) eligibleAccounts(ctx context.Context, q sharedQueryer, lock bool) ([]sharedAccount, error) {
	snap := s.snapshot()
	if snap == nil || snap.Scope == nil {
		return nil, nil
	}
	query := `SELECT id, COALESCE(credentials->>'base_url',''), proxy_id, status, schedulable, extra
        FROM accounts WHERE deleted_at IS NULL AND proxy_id IS NOT NULL
        AND EXISTS (SELECT 1 FROM unnest($1::text[]) AS p(prefix)
          WHERE lower(btrim(credentials->>'base_url'))=p.prefix
          OR left(lower(btrim(credentials->>'base_url')),length(p.prefix)+1)=p.prefix||'/')
        ORDER BY id`
	if lock {
		query += " FOR UPDATE"
	}
	rows, err := q.QueryContext(ctx, query, pq.Array(snap.Scope.prefixes))
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []sharedAccount
	for rows.Next() {
		var acc sharedAccount
		var extraRaw []byte
		if err := rows.Scan(&acc.ID, &acc.BaseURL, &acc.ProxyID, &acc.Status, &acc.Schedulable, &extraRaw); err != nil {
			return nil, err
		}
		extra := map[string]any{}
		if len(extraRaw) > 0 {
			dec := json.NewDecoder(strings.NewReader(string(extraRaw)))
			dec.UseNumber()
			_ = dec.Decode(&extra)
		}
		acc.RestoreEpoch = RestoreEpoch(extra)
		acc.Generation = sharedGeneration(extra)
		if !snap.Scope.Match(acc.BaseURL, acc.hasProxy()) {
			continue
		}
		out = append(out, acc)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if len(out) == 0 {
		return out, nil
	}
	ids := make([]int64, len(out))
	for i := range out {
		ids[i] = out[i].ID
	}
	groups, err := accountGroups(ctx, q, ids)
	if err != nil {
		return nil, err
	}
	for i := range out {
		out[i].GroupIDs = groups[out[i].ID]
	}
	return out, nil
}

// lockAccounts re-reads and locks exactly the given accounts in ID order, which
// keeps the lock order deterministic across instances.
func lockAccounts(ctx context.Context, tx *sql.Tx, ids []int64) (map[int64]sharedAccount, error) {
	out := map[int64]sharedAccount{}
	if len(ids) == 0 {
		return out, nil
	}
	rows, err := tx.QueryContext(ctx, `SELECT id, proxy_id, status, schedulable, extra
		FROM accounts WHERE id = ANY($1::bigint[]) AND deleted_at IS NULL ORDER BY id FOR UPDATE`, pq.Array(ids))
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var acc sharedAccount
		var extraRaw []byte
		if err := rows.Scan(&acc.ID, &acc.ProxyID, &acc.Status, &acc.Schedulable, &extraRaw); err != nil {
			return nil, err
		}
		extra := map[string]any{}
		if len(extraRaw) > 0 {
			dec := json.NewDecoder(strings.NewReader(string(extraRaw)))
			dec.UseNumber()
			_ = dec.Decode(&extra)
		}
		acc.RestoreEpoch = RestoreEpoch(extra)
		acc.Generation = sharedGeneration(extra)
		out[acc.ID] = acc
	}
	return out, rows.Err()
}

func sharedGeneration(extra map[string]any) int64 { return SharedGeneration(extra) }

func accountGroups(ctx context.Context, q sharedQueryer, ids []int64) (map[int64][]int64, error) {
	out := map[int64][]int64{}
	if len(ids) == 0 {
		return out, nil
	}
	rows, err := q.QueryContext(ctx, `SELECT account_id, group_id FROM account_groups WHERE account_id = ANY($1::bigint[]) ORDER BY account_id, group_id`, pq.Array(ids))
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var accountID, groupID int64
		if err := rows.Scan(&accountID, &groupID); err != nil {
			return nil, err
		}
		out[accountID] = append(out[accountID], groupID)
	}
	return out, rows.Err()
}

// proxyRow is the full proxy configuration; credentials stay in memory only.
type proxyRow struct {
	Candidate RotationCandidate
	Status    string
	Deleted   bool
}

func (s *SharedCoordinator) loadProxy(ctx context.Context, q sharedQueryer, id int64) (proxyRow, error) {
	var p proxyRow
	var username, password sql.NullString
	err := q.QueryRowContext(ctx, `SELECT id, name, protocol, host, port, username, password, status, deleted_at IS NOT NULL
		FROM proxies WHERE id=$1`, id).Scan(&p.Candidate.ID, &p.Candidate.Name, &p.Candidate.Protocol, &p.Candidate.Host,
		&p.Candidate.Port, &username, &password, &p.Status, &p.Deleted)
	if err != nil {
		return p, err
	}
	p.Candidate.Username = username.String
	p.Candidate.Password = password.String
	return p, nil
}

// activeProxies lists selectable targets: status=active and not soft-deleted.
// Occupancy is intentionally ignored — sharing is the point.
func (s *SharedCoordinator) activeProxies(ctx context.Context, q sharedQueryer) ([]RotationCandidate, error) {
	rows, err := q.QueryContext(ctx, `SELECT id, name, protocol, host, port, COALESCE(username,''), COALESCE(password,'')
		FROM proxies WHERE deleted_at IS NULL AND status='active' ORDER BY id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []RotationCandidate
	for rows.Next() {
		var c RotationCandidate
		if err := rows.Scan(&c.ID, &c.Name, &c.Protocol, &c.Host, &c.Port, &c.Username, &c.Password); err != nil {
			return nil, err
		}
		out = append(out, c)
	}
	return out, rows.Err()
}

// blockedSets returns the blocked egress IPs and the proxy rows that are wholly
// blacklisted (dynamic proxies are excluded from the row-level set on purpose).
func (s *SharedCoordinator) blockedSets(ctx context.Context, q sharedQueryer) (map[string]struct{}, map[int64]struct{}, error) {
	ips := map[string]struct{}{}
	proxies := map[int64]struct{}{}
	rows, err := q.QueryContext(ctx, `SELECT outbound_ip, proxy_id, is_dynamic FROM poison_blocked_egress`)
	if err != nil {
		return nil, nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var ip string
		var proxyID sql.NullInt64
		var dynamic bool
		if err := rows.Scan(&ip, &proxyID, &dynamic); err != nil {
			return nil, nil, err
		}
		ips[strings.TrimSpace(ip)] = struct{}{}
		if proxyID.Valid && !dynamic {
			proxies[proxyID.Int64] = struct{}{}
		}
	}
	return ips, proxies, rows.Err()
}

// candidateRing orders candidates after the current proxy id with wrap-around and
// drops the current proxy, proxies sharing its endpoint, and blocked entries.
func candidateRing(cands []RotationCandidate, current *int64, currentEndpoint string, blockedIPs map[string]struct{}, blockedProxies map[int64]struct{}) []RotationCandidate {
	ring := make([]RotationCandidate, 0, len(cands))
	for _, c := range cands {
		if current != nil && c.ID == *current {
			continue
		}
		if currentEndpoint != "" && c.endpoint() == currentEndpoint {
			continue
		}
		if _, bad := blockedProxies[c.ID]; bad {
			continue
		}
		if ip := strings.TrimSpace(c.Host); net.ParseIP(ip) != nil {
			if _, dirty := blockedIPs[ip]; dirty {
				continue
			}
		}
		ring = append(ring, c)
	}
	if len(ring) == 0 {
		return nil
	}
	// Rotate the ID-ordered list so the scan starts right after the current proxy.
	start := 0
	if current != nil {
		for i := range ring {
			if ring[i].ID > *current {
				start = i
				break
			}
		}
	}
	ordered := append(append([]RotationCandidate(nil), ring[start:]...), ring[:start]...)
	return ordered
}

// pickInitial chooses the proxy used by the most admitted accounts among the
// usable, unblocked candidates; ties break on the smaller proxy id.
func pickInitial(accounts []sharedAccount, cands []RotationCandidate, blockedIPs map[string]struct{}, blockedProxies map[int64]struct{}) *RotationCandidate {
	usable := map[int64]RotationCandidate{}
	for _, c := range cands {
		if _, bad := blockedProxies[c.ID]; bad {
			continue
		}
		if ip := strings.TrimSpace(c.Host); net.ParseIP(ip) != nil {
			if _, dirty := blockedIPs[ip]; dirty {
				continue
			}
		}
		usable[c.ID] = c
	}
	if len(usable) == 0 {
		return nil
	}
	usage := map[int64]int{}
	for _, acc := range accounts {
		if acc.ProxyID == nil {
			continue
		}
		if _, ok := usable[*acc.ProxyID]; ok {
			usage[*acc.ProxyID]++
		}
	}
	var bestID int64
	bestCount := -1
	for id := range usable {
		count := usage[id]
		if count > bestCount || (count == bestCount && (bestID == 0 || id < bestID)) {
			best := usable[id]
			bestID = id
			bestCount = count
			_ = best
		}
	}
	if bestCount <= 0 {
		// No account is on a usable proxy: fall back to the smallest usable id.
		for id := range usable {
			if bestID == 0 || id < bestID {
				bestID = id
			}
		}
	}
	c := usable[bestID]
	return &c
}

// writeAccounts rewrites only proxy_id and the shared generation marker, merging
// the extra document instead of replacing it. Running state, credentials and all
// unrelated extra keys are untouched.
func writeAccounts(ctx context.Context, tx *sql.Tx, ids []int64, proxyID int64, generation int64) (int, error) {
	if len(ids) == 0 {
		return 0, nil
	}
	res, err := tx.ExecContext(ctx, `UPDATE accounts SET
			proxy_id = $2,
			extra = jsonb_set(COALESCE(extra,'{}'::jsonb), ARRAY[$3]::text[], to_jsonb($4::bigint), true),
			updated_at = NOW()
		WHERE id = ANY($1::bigint[])`, pq.Array(ids), proxyID, SharedGenerationKey, generation)
	if err != nil {
		return 0, err
	}
	n, err := res.RowsAffected()
	return int(n), err
}

// enqueueBulkChange publishes the existing account_bulk_changed outbox event so
// the scheduler reloads the affected accounts after commit.
func enqueueBulkChange(ctx context.Context, tx *sql.Tx, accounts []sharedAccount) error {
	if len(accounts) == 0 {
		return nil
	}
	ids := make([]int64, 0, len(accounts))
	groupSet := map[int64]struct{}{}
	for _, acc := range accounts {
		ids = append(ids, acc.ID)
		for _, g := range acc.GroupIDs {
			groupSet[g] = struct{}{}
		}
	}
	groups := make([]int64, 0, len(groupSet))
	for g := range groupSet {
		groups = append(groups, g)
	}
	sortInt64(groups)
	payload, err := json.Marshal(map[string]any{"account_ids": ids, "group_ids": groups})
	if err != nil {
		return err
	}
	_, err = tx.ExecContext(ctx, `INSERT INTO scheduler_outbox(event_type, account_id, group_id, payload)
		VALUES('account_bulk_changed', NULL, NULL, $1)`, payload)
	return err
}

func sortInt64(v []int64) {
	for i := 1; i < len(v); i++ {
		for j := i; j > 0 && v[j] < v[j-1]; j-- {
			v[j], v[j-1] = v[j-1], v[j]
		}
	}
}

// captureBeforeImage records the blacklist row exactly as it was before this hit,
// so a later release can delete only that observation.
func captureBeforeImage(ctx context.Context, tx *sql.Tx, ip string) (*SharedBlockedBeforeImage, error) {
	if strings.TrimSpace(ip) == "" {
		return nil, nil
	}
	img := &SharedBlockedBeforeImage{}
	var proxyID, accountID sql.NullInt64
	err := tx.QueryRowContext(ctx, `SELECT id, outbound_ip, proxy_id, account_id, is_dynamic, reason, hit_count, first_hit_at, last_hit_at
		FROM poison_blocked_egress WHERE outbound_ip=$1`, ip).
		Scan(&img.ID, &img.OutboundIP, &proxyID, &accountID, &img.IsDynamic, &img.Reason, &img.HitCount, &img.FirstHitAt, &img.LastHitAt)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	if proxyID.Valid {
		id := proxyID.Int64
		img.ProxyID = &id
	}
	if accountID.Valid {
		id := accountID.Int64
		img.AccountID = &id
	}
	return img, nil
}

// hitBlacklist performs the existing permanent upsert, in the same transaction as
// the switch, so a hit is never recorded without the fleet moving.
func hitBlacklist(ctx context.Context, tx *sql.Tx, ip string, proxyID *int64, accountID int64, dynamic bool, reason string) error {
	ip = strings.TrimSpace(ip)
	if ip == "" {
		return nil
	}
	if net.ParseIP(ip) == nil {
		return rotationError("invalid_egress", ErrRotationUnavailable)
	}
	if len(reason) > 255 {
		reason = reason[:255]
	}
	_, err := tx.ExecContext(ctx, `INSERT INTO poison_blocked_egress (outbound_ip, proxy_id, account_id, is_dynamic, reason)
		VALUES ($1, $2, $3, $4, $5)
		ON CONFLICT (outbound_ip) DO UPDATE SET
			hit_count   = poison_blocked_egress.hit_count + 1,
			last_hit_at = NOW(),
			is_dynamic  = poison_blocked_egress.is_dynamic OR EXCLUDED.is_dynamic`,
		ip, proxyID, accountID, dynamic, reason)
	return err
}

// releaseBlacklist deletes the exact row captured earlier. Any newer hit bumps
// hit_count (or replaces the id), so the delete matches nothing and the entry
// stays: a clean round from an older observation must never clear a fresh hit.
func releaseBlacklist(ctx context.Context, tx *sql.Tx, before *SharedBlockedBeforeImage) (bool, error) {
	if before == nil || strings.TrimSpace(before.OutboundIP) == "" {
		return false, nil
	}
	res, err := tx.ExecContext(ctx, `DELETE FROM poison_blocked_egress
		WHERE outbound_ip=$1 AND id=$2 AND hit_count=$3`, before.OutboundIP, before.ID, before.HitCount)
	if err != nil {
		return false, err
	}
	n, err := res.RowsAffected()
	if err != nil {
		return false, err
	}
	return n == 1, nil
}

func blockedRowCount(ctx context.Context, q sharedQueryer) (int, error) {
	var n int
	err := q.QueryRowContext(ctx, `SELECT count(*) FROM poison_blocked_egress`).Scan(&n)
	return n, err
}

// sharedLeaseOwner builds a per-instance token so two processes cannot both drive
// the same run or cell.
func sharedLeaseOwner() string {
	return fmt.Sprintf("%s-%d-%d", sharedHostname(), sharedPID(), time.Now().UnixNano())
}
