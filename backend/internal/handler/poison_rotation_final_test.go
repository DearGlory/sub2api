package handler

import (
	"context"
	"testing"

	"github.com/DATA-DOG/go-sqlmock"
)

func TestPoisonRotationRejectsNewlyBlacklistedCandidate(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	mock.ExpectBegin()
	mock.ExpectExec("SELECT pg_advisory_xact_lock").WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectQuery("SELECT host, port FROM proxies").WithArgs(int64(13)).WillReturnRows(sqlmock.NewRows([]string{"host", "port"}).AddRow("192.0.2.13", 1080))
	mock.ExpectQuery("SELECT DISTINCT lower").WillReturnRows(sqlmock.NewRows([]string{"endpoint"}))
	mock.ExpectQuery("SELECT EXISTS.*poison_blocked_egress").WithArgs("192.0.2.13", int64(13)).WillReturnRows(sqlmock.NewRows([]string{"blocked"}).AddRow(true))
	mock.ExpectRollback()
	updated := false
	err = rebindPoisonProxy(context.Background(), db, 42, 13, func(context.Context) error { updated = true; return nil })
	if err == nil || updated {
		t.Fatalf("newly blacklisted endpoint bound: updated=%v err=%v", updated, err)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatal(err)
	}
}
