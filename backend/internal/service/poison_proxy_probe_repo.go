package service

import (
	"context"
	"sync"
	"time"

	"github.com/Wei-Shaw/sub2api/internal/pkg/pagination"
)

// probeAccountRepo is the read-only account repository used by a poison probe.
//
// It implements AccountRepository in full instead of embedding the interface:
// embedding would let any write method that is not explicitly overridden fall
// through to the real repository, and a newly added interface method would do so
// silently. With a complete implementation a new method is a compile error, so no
// probe path can mutate an account by accident.
//
// Writes are not merely ignored: they are recorded, and ProbePoisonProxy turns a
// non-empty write log into an inconclusive verdict, so a channel that mutates
// state can never be reported clean.
type probeAccountRepo struct {
	account *Account

	mu     sync.Mutex
	writes []string
}

var _ AccountRepository = (*probeAccountRepo)(nil)

func (r *probeAccountRepo) record(op string) {
	r.mu.Lock()
	r.writes = append(r.writes, op)
	r.mu.Unlock()
}

func (r *probeAccountRepo) writeCount() int {
	r.mu.Lock()
	defer r.mu.Unlock()
	return len(r.writes)
}

// --- reads: the probe only ever sees its own frozen copy ---

func (r *probeAccountRepo) GetByID(_ context.Context, id int64) (*Account, error) {
	// The probe runs against the requested account only; a shadow-parent lookup or
	// any other ID would need another row, which a probe must not read.
	if r.account == nil || r.account.ID != id {
		return nil, ErrAccountNotFound
	}
	return r.account, nil
}

func (r *probeAccountRepo) GetByIDs(_ context.Context, ids []int64) ([]*Account, error) {
	out := make([]*Account, 0, len(ids))
	for _, id := range ids {
		if r.account != nil && r.account.ID == id {
			out = append(out, r.account)
		}
	}
	return out, nil
}

func (r *probeAccountRepo) ExistsByID(_ context.Context, id int64) (bool, error) {
	return r.account != nil && r.account.ID == id, nil
}

func (r *probeAccountRepo) GetByCRSAccountID(context.Context, string) (*Account, error) {
	return nil, nil
}

func (r *probeAccountRepo) FindByExtraField(context.Context, string, any) ([]Account, error) {
	return nil, nil
}

func (r *probeAccountRepo) ListCRSAccountIDs(context.Context) (map[string]int64, error) {
	return nil, nil
}

func (r *probeAccountRepo) List(context.Context, pagination.PaginationParams) ([]Account, *pagination.PaginationResult, error) {
	return nil, nil, nil
}

func (r *probeAccountRepo) ListWithFilters(context.Context, pagination.PaginationParams, string, string, string, string, int64, string) ([]Account, *pagination.PaginationResult, error) {
	return nil, nil, nil
}

func (r *probeAccountRepo) ListAllWithFilters(context.Context, string, string, string, string, int64, string) ([]Account, error) {
	return nil, nil
}

func (r *probeAccountRepo) ListByGroup(context.Context, int64) ([]Account, error) { return nil, nil }

func (r *probeAccountRepo) ListActive(context.Context) ([]Account, error) { return nil, nil }

func (r *probeAccountRepo) ListByPlatform(context.Context, string) ([]Account, error) { return nil, nil }

func (r *probeAccountRepo) ListSchedulable(context.Context) ([]Account, error) { return nil, nil }

func (r *probeAccountRepo) ListSchedulableByGroupID(context.Context, int64) ([]Account, error) {
	return nil, nil
}

func (r *probeAccountRepo) ListSchedulableByPlatform(context.Context, string) ([]Account, error) {
	return nil, nil
}

func (r *probeAccountRepo) ListSchedulableByGroupIDAndPlatform(context.Context, int64, string) ([]Account, error) {
	return nil, nil
}

func (r *probeAccountRepo) ListSchedulableByPlatforms(context.Context, []string) ([]Account, error) {
	return nil, nil
}

func (r *probeAccountRepo) ListSchedulableByGroupIDAndPlatforms(context.Context, int64, []string) ([]Account, error) {
	return nil, nil
}

func (r *probeAccountRepo) ListSchedulableUngroupedByPlatform(context.Context, string) ([]Account, error) {
	return nil, nil
}

func (r *probeAccountRepo) ListSchedulableUngroupedByPlatforms(context.Context, []string) ([]Account, error) {
	return nil, nil
}

func (r *probeAccountRepo) ListModelAvailabilityCandidates(context.Context, *int64, []string, bool) ([]Account, error) {
	return nil, nil
}

func (r *probeAccountRepo) ListShadowsByParent(context.Context, int64) ([]*Account, error) {
	return nil, nil
}

// --- writes: recorded, never executed ---

func (r *probeAccountRepo) Create(context.Context, *Account) error {
	r.record("Create")
	return nil
}

func (r *probeAccountRepo) Update(context.Context, *Account) error {
	r.record("Update")
	return nil
}

func (r *probeAccountRepo) Delete(context.Context, int64) error {
	r.record("Delete")
	return nil
}

func (r *probeAccountRepo) UpdateLastUsed(context.Context, int64) error {
	r.record("UpdateLastUsed")
	return nil
}

func (r *probeAccountRepo) BatchUpdateLastUsed(context.Context, map[int64]time.Time) error {
	r.record("BatchUpdateLastUsed")
	return nil
}

func (r *probeAccountRepo) SetError(context.Context, int64, string) error {
	r.record("SetError")
	return nil
}

func (r *probeAccountRepo) ClearError(context.Context, int64) error {
	r.record("ClearError")
	return nil
}

func (r *probeAccountRepo) SetSchedulable(context.Context, int64, bool) error {
	r.record("SetSchedulable")
	return nil
}

func (r *probeAccountRepo) AutoPauseExpiredAccounts(context.Context, time.Time) (int64, error) {
	r.record("AutoPauseExpiredAccounts")
	return 0, nil
}

func (r *probeAccountRepo) BindGroups(context.Context, int64, []int64) error {
	r.record("BindGroups")
	return nil
}

func (r *probeAccountRepo) SetRateLimited(context.Context, int64, time.Time) error {
	r.record("SetRateLimited")
	return nil
}

func (r *probeAccountRepo) SetModelRateLimit(context.Context, int64, string, time.Time, ...string) error {
	r.record("SetModelRateLimit")
	return nil
}

func (r *probeAccountRepo) SetOverloaded(context.Context, int64, time.Time) error {
	r.record("SetOverloaded")
	return nil
}

func (r *probeAccountRepo) SetTempUnschedulable(context.Context, int64, time.Time, string) error {
	r.record("SetTempUnschedulable")
	return nil
}

func (r *probeAccountRepo) ClearTempUnschedulable(context.Context, int64) error {
	r.record("ClearTempUnschedulable")
	return nil
}

func (r *probeAccountRepo) ClearRateLimit(context.Context, int64) error {
	r.record("ClearRateLimit")
	return nil
}

func (r *probeAccountRepo) ClearAntigravityQuotaScopes(context.Context, int64) error {
	r.record("ClearAntigravityQuotaScopes")
	return nil
}

func (r *probeAccountRepo) ClearModelRateLimits(context.Context, int64) error {
	r.record("ClearModelRateLimits")
	return nil
}

func (r *probeAccountRepo) UpdateSessionWindow(context.Context, int64, *time.Time, *time.Time, string) error {
	r.record("UpdateSessionWindow")
	return nil
}

func (r *probeAccountRepo) UpdateSessionWindowEnd(context.Context, int64, time.Time) error {
	r.record("UpdateSessionWindowEnd")
	return nil
}

func (r *probeAccountRepo) UpdateExtra(context.Context, int64, map[string]any) error {
	r.record("UpdateExtra")
	return nil
}

func (r *probeAccountRepo) BulkUpdate(context.Context, []int64, AccountBulkUpdate) (int64, error) {
	r.record("BulkUpdate")
	return 0, nil
}

func (r *probeAccountRepo) IncrementQuotaUsed(context.Context, int64, float64) error {
	r.record("IncrementQuotaUsed")
	return nil
}

func (r *probeAccountRepo) ResetQuotaUsedAndClearRateLimitCooldown(context.Context, int64) error {
	r.record("ResetQuotaUsedAndClearRateLimitCooldown")
	return nil
}

func (r *probeAccountRepo) RevertProxyFallback(context.Context, int64) error {
	r.record("RevertProxyFallback")
	return nil
}
