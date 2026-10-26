//go:build unit

package handler

import (
	"context"
	"errors"
	"testing"

	"github.com/DATA-DOG/go-sqlmock"
	dbent "github.com/Wei-Shaw/sub2api/ent"
	"github.com/Wei-Shaw/sub2api/internal/poison"
	"github.com/Wei-Shaw/sub2api/internal/service"
	"github.com/stretchr/testify/require"
)

// Embed the unused repository methods so this fixture exercises the real
// AccountService.Update while keeping database and snapshot I/O local.
type poisonAccountRepoStub struct {
	service.AccountRepository
	t          *testing.T
	mock       sqlmock.Sqlmock
	account    service.Account
	updates    int
	refreshes  int
	refreshErr error
}

func (r *poisonAccountRepoStub) GetByID(ctx context.Context, id int64) (*service.Account, error) {
	require.NotNil(r.t, dbent.TxFromContext(ctx), "account read must join incident transaction")
	require.Equal(r.t, r.account.ID, id)
	account := r.account
	return &account, nil
}

func (r *poisonAccountRepoStub) Update(ctx context.Context, account *service.Account) error {
	require.NotNil(r.t, dbent.TxFromContext(ctx), "account write must join incident transaction")
	r.account = *account
	r.updates++
	return nil
}

func (r *poisonAccountRepoStub) RefreshPoisonGuardSnapshot(ctx context.Context, id int64) error {
	require.Nil(r.t, dbent.TxFromContext(ctx), "snapshot refresh must run outside transaction")
	require.NoError(r.t, r.mock.ExpectationsWereMet(), "transaction must commit before snapshot refresh")
	require.Equal(r.t, r.account.ID, id)
	r.refreshes++
	return r.refreshErr
}

func TestSetupPoisonGuardDisableUsesInactiveAccountStatus(t *testing.T) {
	for _, tc := range []struct {
		name       string
		refreshErr error
	}{
		{name: "snapshot refreshed"},
		{name: "snapshot retry remains asynchronous", refreshErr: errors.New("snapshot unavailable")},
	} {
		t.Run(tc.name, func(t *testing.T) {
			db, mock, err := sqlmock.New()
			require.NoError(t, err)
			t.Cleanup(func() { db.Close() })
			previous := poison.CurrentHandler()
			t.Cleanup(func() { poison.AttachHandler(previous) })

			proxyID := int64(7)
			repo := &poisonAccountRepoStub{
				t: t, mock: mock, refreshErr: tc.refreshErr,
				account: service.Account{ID: 42, Status: "active", Schedulable: true, ProxyID: &proxyID},
			}
			mock.ExpectBegin()
			mock.ExpectExec("SELECT pg_advisory_xact_lock").WithArgs(poison.RotationLockKey).
				WillReturnResult(sqlmock.NewResult(0, 1))
			mock.ExpectQuery("SELECT proxy_id, status, schedulable.*FOR UPDATE").WithArgs(int64(42)).
				WillReturnRows(sqlmock.NewRows([]string{"proxy_id", "status", "schedulable"}).AddRow(proxyID, "active", true))
			mock.ExpectCommit()

			SetupPoisonGuard(db, nil, service.NewAccountService(repo, nil))
			err = poison.CurrentHandler().DisableIncident(context.Background(), poison.Incident{AccountID: 42, ProxyID: &proxyID})
			require.NoError(t, err)
			require.NoError(t, mock.ExpectationsWereMet())
			require.Equal(t, 1, repo.updates)
			require.Equal(t, 1, repo.refreshes)
			require.Equal(t, "inactive", repo.account.Status, "normal account disable must use the admin/UI status")
			require.True(t, repo.account.Schedulable, "normal disable preserves the independent scheduling switch")
			require.False(t, repo.account.IsSchedulable(), "inactive account must not receive traffic")
			require.Equal(t, proxyID, *repo.account.ProxyID, "disable must preserve the proxy binding")
		})
	}
}
