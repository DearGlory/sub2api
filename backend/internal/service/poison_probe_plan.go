package service

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"sort"

	"github.com/Wei-Shaw/sub2api/internal/poison"
	"github.com/lib/pq"
)

// PlanError categories for admitted accounts that cannot be probed yet.
// They stay in the plan so the coordinator keeps a stable account set.
const (
	planErrorNoGroups = "no_groups"
	planErrorNoUsage  = "no_usage"
)

// PoisonProbePlanService freezes the shared proxy verification plan.
//
// It is read-only: it never writes accounts, groups or usage rows, and it only
// reads credentials->>'base_url' so no secret leaves the database.
type PoisonProbePlanService struct {
	db *sql.DB
}

// NewPoisonProbePlanService builds the read-only plan service.
func NewPoisonProbePlanService(db *sql.DB) *PoisonProbePlanService {
	return &PoisonProbePlanService{db: db}
}

type admittedAccount struct {
	id        int64
	baseURL   string
	proxyID   sql.NullInt64
	status    string
	schedul   bool
	extra     []byte
	groupIDs  []int64
	model     string
	requests  int64
	planError string
}

// Plan returns every admitted, non-deleted account ordered by ID, in-scope for
// the current snapshot, with the most requested model merged across all of the
// account's groups. Inactive and unschedulable accounts are included: the
// shared switch never changes business state.
func (s *PoisonProbePlanService) Plan(ctx context.Context, snap *poison.Snapshot) ([]poison.SharedAccount, error) {
	if s == nil || s.db == nil {
		return nil, fmt.Errorf("poison probe plan: database not configured")
	}
	if snap == nil || snap.Scope == nil {
		return []poison.SharedAccount{}, nil
	}
	accounts, err := s.admittedAccounts(ctx, snap.Scope)
	if err != nil {
		return nil, err
	}
	if len(accounts) == 0 {
		return []poison.SharedAccount{}, nil
	}
	ids := make([]int64, 0, len(accounts))
	for _, a := range accounts {
		ids = append(ids, a.id)
	}
	byAccount := make(map[int64]*admittedAccount, len(accounts))
	for i := range accounts {
		byAccount[accounts[i].id] = &accounts[i]
	}
	if err := s.loadGroups(ctx, ids, byAccount); err != nil {
		return nil, err
	}
	if err := s.loadModelCounts(ctx, ids, byAccount); err != nil {
		return nil, err
	}

	out := make([]poison.SharedAccount, 0, len(accounts))
	for i := range accounts {
		a := &accounts[i]
		extra := map[string]any{}
		if len(a.extra) > 0 {
			if err := json.Unmarshal(a.extra, &extra); err != nil {
				return nil, fmt.Errorf("poison probe plan: account %d extra: %w", a.id, err)
			}
		}
		item := poison.SharedAccount{
			ID:               a.id,
			BaseURL:          a.baseURL,
			Status:           a.status,
			Schedulable:      a.schedul,
			RestoreEpoch:     poison.RestoreEpoch(extra),
			SharedGeneration: sharedGeneration(extra),
			GroupIDs:         a.groupIDs,
			Model:            a.model,
			ModelRequests:    a.requests,
			PlanError:        a.planError,
		}
		if a.proxyID.Valid {
			proxyID := a.proxyID.Int64
			item.ProxyID = &proxyID
		}
		out = append(out, item)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ID < out[j].ID })
	return out, nil
}

// sharedGeneration reads the core-owned generation with the same strict parsing
// as the restore epoch; a missing key means generation 0, invalid values mean -1.
func sharedGeneration(extra map[string]any) int64 {
	value, exists := extra[poison.SharedGenerationKey]
	if !exists {
		return 0
	}
	return poison.RestoreEpoch(map[string]any{poison.RestoreEpochKey: value})
}

func (s *PoisonProbePlanService) admittedAccounts(ctx context.Context, scope *poison.Scope) ([]admittedAccount, error) {
	rows, err := s.db.QueryContext(ctx, `
SELECT id, COALESCE(credentials->>'base_url', ''), proxy_id, status, schedulable, COALESCE(extra, '{}'::jsonb)
FROM accounts
WHERE deleted_at IS NULL
ORDER BY id`)
	if err != nil {
		return nil, fmt.Errorf("poison probe plan: query accounts: %w", err)
	}
	defer rows.Close()
	out := make([]admittedAccount, 0, 64)
	for rows.Next() {
		var a admittedAccount
		if err := rows.Scan(&a.id, &a.baseURL, &a.proxyID, &a.status, &a.schedul, &a.extra); err != nil {
			return nil, fmt.Errorf("poison probe plan: scan account: %w", err)
		}
		// Scope.Match normalizes case/whitespace and enforces the host prefix
		// boundary; a proxy binding is required too.
		if !scope.Match(a.baseURL, a.proxyID.Valid) {
			continue
		}
		out = append(out, a)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("poison probe plan: iterate accounts: %w", err)
	}
	return out, nil
}

// loadGroups attaches the DISTINCT group ids of each admitted account.
func (s *PoisonProbePlanService) loadGroups(ctx context.Context, ids []int64, into map[int64]*admittedAccount) error {
	rows, err := s.db.QueryContext(ctx, `
SELECT DISTINCT account_id, group_id
FROM account_groups
WHERE account_id = ANY($1::bigint[])
ORDER BY account_id, group_id`, pq.Array(ids))
	if err != nil {
		return fmt.Errorf("poison probe plan: query groups: %w", err)
	}
	defer rows.Close()
	for rows.Next() {
		var accountID, groupID int64
		if err := rows.Scan(&accountID, &groupID); err != nil {
			return fmt.Errorf("poison probe plan: scan group: %w", err)
		}
		if a, ok := into[accountID]; ok {
			a.groupIDs = append(a.groupIDs, groupID)
		}
	}
	if err := rows.Err(); err != nil {
		return fmt.Errorf("poison probe plan: iterate groups: %w", err)
	}
	return nil
}

// loadModelCounts aggregates usage_logs once per (account, group, model) and
// merges the per-group counts of every group the account belongs to. The merge
// uses COUNT(*) of retained usage rows, never tokens or cost: a zero-cost row
// still happened.
func (s *PoisonProbePlanService) loadModelCounts(ctx context.Context, ids []int64, into map[int64]*admittedAccount) error {
	rows, err := s.db.QueryContext(ctx, `
SELECT ag.account_id,
       COALESCE(NULLIF(BTRIM(u.requested_model), ''), u.model) AS model_name,
       COUNT(*) AS requests
FROM (SELECT DISTINCT account_id, group_id FROM account_groups) ag
JOIN usage_logs u ON u.account_id = ag.account_id AND u.group_id = ag.group_id
WHERE ag.account_id = ANY($1::bigint[])
GROUP BY ag.account_id, model_name
ORDER BY ag.account_id, model_name`, pq.Array(ids))
	if err != nil {
		return fmt.Errorf("poison probe plan: query usage: %w", err)
	}
	defer rows.Close()
	totals := make(map[int64]map[string]int64, len(ids))
	for rows.Next() {
		var accountID, count int64
		var model sql.NullString
		if err := rows.Scan(&accountID, &model, &count); err != nil {
			return fmt.Errorf("poison probe plan: scan usage: %w", err)
		}
		if !model.Valid || model.String == "" {
			continue
		}
		if totals[accountID] == nil {
			totals[accountID] = map[string]int64{}
		}
		totals[accountID][model.String] += count
	}
	if err := rows.Err(); err != nil {
		return fmt.Errorf("poison probe plan: iterate usage: %w", err)
	}

	for accountID, counts := range totals {
		a, ok := into[accountID]
		if !ok {
			continue
		}
		best, bestCount := "", int64(0)
		for model, count := range counts {
			if count > bestCount || (count == bestCount && model < best) {
				best, bestCount = model, count
			}
		}
		a.model, a.requests = best, bestCount
	}
	for _, a := range into {
		switch {
		case len(a.groupIDs) == 0:
			a.planError = planErrorNoGroups
		case a.model == "":
			a.planError = planErrorNoUsage
		}
	}
	return nil
}
