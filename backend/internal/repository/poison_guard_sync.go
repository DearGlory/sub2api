package repository

import "context"

// RefreshPoisonGuardSnapshot reads after the caller's rotation transaction has
// committed, including the hydrated new proxy, then publishes the normal cache row.
func (r *accountRepository) RefreshPoisonGuardSnapshot(ctx context.Context, accountID int64) error {
	if r.schedulerCache == nil {
		return nil
	}
	account, err := r.GetByID(ctx, accountID)
	if err != nil {
		return err
	}
	return r.schedulerCache.SetAccount(ctx, account)
}
