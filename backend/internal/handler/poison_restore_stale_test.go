package handler

import (
	"context"
	"errors"
	"reflect"
	"testing"
	"time"

	"github.com/DATA-DOG/go-sqlmock"
	"github.com/Wei-Shaw/sub2api/internal/poison"
)

func TestPoisonSameProxyRestorePreventsDisable(t *testing.T) {
	for _, tc := range []struct {
		name, action, body string
		stale, queryError  bool
	}{
		{"status restore", "admin.accounts.update", `{"status":"active"}`, true, false},
		{"scheduler restore", "admin.accounts.schedulable.create", `{"schedulable":true}`, true, false},
		{"ordinary edit", "admin.accounts.update", `{"name":"edited"}`, false, false},
		{"scheduler disable", "admin.accounts.schedulable.create", `{"schedulable":false}`, false, false},
		{"nested status is not restore", "admin.accounts.update", `{"extra":{"status":"active"}}`, false, false},
		{"audit unavailable", "", "", false, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			db, mock, err := sqlmock.New()
			if err != nil {
				t.Fatal(err)
			}
			defer db.Close()
			started := time.Date(2026, 1, 2, 3, 4, 5, 0, time.UTC)
			proxyID := int64(7)
			inc := poison.Incident{AccountID: 42, ProxyID: &proxyID}
			// Reflection keeps this behavioral RED probe runnable on the baseline.
			field := reflect.ValueOf(&inc).Elem().FieldByName("RequestStartedAt")
			if field.IsValid() {
				field.Set(reflect.ValueOf(started))
			}
			mock.ExpectBegin()
			mock.ExpectExec("SELECT pg_advisory_xact_lock").WillReturnResult(sqlmock.NewResult(0, 1))
			mock.ExpectQuery("SELECT proxy_id, status, schedulable.*FOR UPDATE").WithArgs(int64(42)).WillReturnRows(sqlmock.NewRows([]string{"proxy_id", "status", "schedulable"}).AddRow(7, "active", true)).RowsWillBeClosed()
			q := mock.ExpectQuery("SELECT action, request_body FROM audit_logs").WithArgs("42", started)
			if tc.queryError {
				q.WillReturnError(errors.New("audit unavailable"))
			} else {
				q.WillReturnRows(sqlmock.NewRows([]string{"action", "request_body"}).AddRow(tc.action, tc.body)).RowsWillBeClosed()
			}
			if tc.stale || tc.queryError {
				mock.ExpectRollback()
			} else {
				mock.ExpectCommit()
			}
			updated := false
			err = disablePoisonIncident(context.Background(), db, inc, func(context.Context) error { updated = true; return nil })
			wantUpdate := !tc.stale && !tc.queryError
			if updated != wantUpdate {
				t.Fatalf("updated=%v want=%v err=%v", updated, wantUpdate, err)
			}
			if tc.stale && !errors.Is(err, poison.ErrStaleIncident) {
				t.Fatalf("want stale, got %v", err)
			}
			if tc.queryError && err == nil {
				t.Fatal("audit failure must defer")
			}
			if wantUpdate && err != nil {
				t.Fatal(err)
			}
			if err := mock.ExpectationsWereMet(); err != nil {
				t.Fatal(err)
			}
		})
	}
}
