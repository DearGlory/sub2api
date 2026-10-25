package handler

import (
	"context"
	"testing"

	"github.com/DATA-DOG/go-sqlmock"
	"github.com/Wei-Shaw/sub2api/internal/poison"
)

func TestPoisonDisableRechecksIncidentUnderTransaction(t *testing.T) {
	for _, current := range []bool{false, true} {
		db, mock, err := sqlmock.New()
		if err != nil {
			t.Fatal(err)
		}
		mock.ExpectBegin()
		mock.ExpectExec("SELECT pg_advisory_xact_lock").WillReturnResult(sqlmock.NewResult(0, 1))
		proxyID, actual := int64(7), int64(8)
		if current {
			actual = 7
		}
		mock.ExpectQuery("SELECT proxy_id, status, schedulable.*FOR UPDATE").WithArgs(int64(42)).WillReturnRows(sqlmock.NewRows([]string{"proxy_id", "status", "schedulable"}).AddRow(actual, "active", true))
		if current {
			mock.ExpectCommit()
		} else {
			mock.ExpectRollback()
		}
		updated := false
		err = disablePoisonIncident(context.Background(), db, poison.Incident{AccountID: 42, ProxyID: &proxyID}, func(context.Context) error { updated = true; return nil })
		if updated != current || (err == nil) != current {
			t.Fatalf("current=%v updated=%v err=%v", current, updated, err)
		}
		if err := mock.ExpectationsWereMet(); err != nil {
			t.Fatal(err)
		}
		db.Close()
	}
}
