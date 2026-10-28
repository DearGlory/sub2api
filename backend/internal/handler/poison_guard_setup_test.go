//go:build unit

package handler

import (
	"context"
	"github.com/DATA-DOG/go-sqlmock"
	"github.com/Wei-Shaw/sub2api/internal/poison"
	"github.com/stretchr/testify/require"
	"testing"
)

func TestSetupPoisonGuardRequiresSharedCoordinator(t *testing.T) {
	db, mock, err := sqlmock.New()
	require.NoError(t, err)
	defer db.Close()
	previous := poison.CurrentHandler()
	defer poison.AttachHandler(previous)
	SetupPoisonGuard(db, nil, nil)
	h := poison.CurrentHandler()
	require.NotNil(t, h)
	var got poison.Disposition
	h.ReportDisposition = func(_ poison.Incident, d poison.Disposition) { got = d }
	h.Handle(context.Background(), poison.Incident{AccountID: 42})
	require.Equal(t, "deferred_shared_unavailable", got.Reason)
	require.NoError(t, mock.ExpectationsWereMet(), "missing coordinator must never fall back to ordinary mode")
}
