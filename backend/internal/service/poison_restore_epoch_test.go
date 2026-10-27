//go:build unit

package service

import (
	"context"
	"github.com/Wei-Shaw/sub2api/internal/poison"
	"github.com/stretchr/testify/require"
	"testing"
)

type epochAdminRepo struct {
	AccountRepository
	account *Account
	marked  []bool
}

func (r *epochAdminRepo) GetByID(context.Context, int64) (*Account, error) { return r.account, nil }
func (r *epochAdminRepo) Update(ctx context.Context, a *Account) error {
	r.marked = append(r.marked, poison.IsAdminRestore(ctx))
	r.account = a
	return nil
}
func (r *epochAdminRepo) SetSchedulable(ctx context.Context, id int64, s bool) error {
	r.marked = append(r.marked, poison.IsAdminRestore(ctx))
	r.account.Schedulable = s
	return nil
}
func (r *epochAdminRepo) BulkUpdate(ctx context.Context, ids []int64, u AccountBulkUpdate) (int64, error) {
	r.marked = append(r.marked, poison.IsAdminRestore(ctx))
	return int64(len(ids)), nil
}

func (r *epochAdminRepo) ClearError(ctx context.Context, id int64) error {
	r.marked = append(r.marked, poison.IsAdminRestore(ctx))
	return nil
}
func (r *epochAdminRepo) ClearRateLimit(context.Context, int64) error              { return nil }
func (r *epochAdminRepo) ClearAntigravityQuotaScopes(context.Context, int64) error { return nil }
func (r *epochAdminRepo) ClearModelRateLimits(context.Context, int64) error        { return nil }
func (r *epochAdminRepo) ClearTempUnschedulable(context.Context, int64) error      { return nil }

func TestPoisonRestoreEpochAdminWriteWiring(t *testing.T) {
	for _, tc := range []struct {
		name string
		want bool
		call func(*adminServiceImpl) error
	}{
		{"clear error restore", true, func(s *adminServiceImpl) error { _, err := s.ClearAccountError(context.Background(), 42); return err }},
		{"single restore", true, func(s *adminServiceImpl) error {
			_, err := s.UpdateAccount(context.Background(), 42, &UpdateAccountInput{Status: StatusActive})
			return err
		}},
		{"ordinary edit", false, func(s *adminServiceImpl) error {
			_, err := s.UpdateAccount(context.Background(), 42, &UpdateAccountInput{Name: "edited"})
			return err
		}},
		{"single inactive", false, func(s *adminServiceImpl) error {
			_, err := s.UpdateAccount(context.Background(), 42, &UpdateAccountInput{Status: "inactive"})
			return err
		}},
		{"schedule restore", true, func(s *adminServiceImpl) error {
			_, err := s.SetAccountSchedulable(context.Background(), 42, true)
			return err
		}},
		{"schedule pause", false, func(s *adminServiceImpl) error {
			_, err := s.SetAccountSchedulable(context.Background(), 42, false)
			return err
		}},
		{"bulk active", true, func(s *adminServiceImpl) error {
			_, err := s.BulkUpdateAccounts(context.Background(), &BulkUpdateAccountsInput{AccountIDs: []int64{42}, Status: StatusActive})
			return err
		}},
		{"bulk schedulable", true, func(s *adminServiceImpl) error {
			yes := true
			_, err := s.BulkUpdateAccounts(context.Background(), &BulkUpdateAccountsInput{AccountIDs: []int64{42}, Schedulable: &yes})
			return err
		}},
		{"bulk ordinary", false, func(s *adminServiceImpl) error {
			_, err := s.BulkUpdateAccounts(context.Background(), &BulkUpdateAccountsInput{AccountIDs: []int64{42}, Name: "edited"})
			return err
		}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			repo := &epochAdminRepo{account: &Account{ID: 42, Name: "account", Platform: PlatformAnthropic, Type: AccountTypeAPIKey, Status: StatusActive, Credentials: map[string]any{"api_key": "synthetic"}, Schedulable: true}}
			svc := &adminServiceImpl{accountRepo: repo}
			require.NoError(t, tc.call(svc))
			require.Equal(t, []bool{tc.want}, repo.marked)
		})
	}
}
