package handler

import (
	"context"
	"errors"
	"testing"

	"github.com/DATA-DOG/go-sqlmock"
	"github.com/Wei-Shaw/sub2api/internal/poison"
)

func TestPoisonSameProxyRestorePreventsDisable(t *testing.T) {
	for _, tc := range []struct {
		name       string
		stored     any
		request    int64
		stale, bad bool
	}{
		{"same proxy restored", []byte(`1`), 0, true, false},
		{"second restore", []byte(`2`), 1, true, false},
		{"new snapshot", []byte(`2`), 2, false, false},
		{"ordinary edit", []byte(`2`), 2, false, false},
		{"unmarked legacy account", nil, 0, false, false},
		{"unreadable metadata", []byte(`"bad"`), 0, false, true},
		{"explicit null is invalid", []byte(`null`), 0, false, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			db, mock, err := sqlmock.New()
			if err != nil {
				t.Fatal(err)
			}
			defer db.Close()
			p := int64(7)
			inc := poison.Incident{AccountID: 42, ProxyID: &p, RestoreEpoch: tc.request}
			mock.ExpectBegin()
			mock.ExpectExec("SELECT pg_advisory_xact_lock").WillReturnResult(sqlmock.NewResult(0, 1))
			mock.ExpectQuery("SELECT proxy_id, status, schedulable.*FOR UPDATE").WithArgs(int64(42)).WillReturnRows(sqlmock.NewRows([]string{"proxy_id", "status", "schedulable", "epoch"}).AddRow(7, "active", true, tc.stored)).RowsWillBeClosed()
			if tc.stale || tc.bad {
				mock.ExpectRollback()
			} else {
				mock.ExpectCommit()
			}
			updated := false
			err = disablePoisonIncident(context.Background(), db, inc, func(context.Context) error { updated = true; return nil })
			if updated != (!tc.stale && !tc.bad) {
				t.Fatalf("updated=%v stale=%v bad=%v err=%v", updated, tc.stale, tc.bad, err)
			}
			if tc.stale && !errors.Is(err, poison.ErrStaleIncident) {
				t.Fatalf("expected stale, got %v", err)
			}
			if tc.bad && err == nil {
				t.Fatal("invalid epoch must defer")
			}
			if !tc.stale && !tc.bad && err != nil {
				t.Fatal(err)
			}
			if err := mock.ExpectationsWereMet(); err != nil {
				t.Fatal(err)
			}
		})
	}
}
