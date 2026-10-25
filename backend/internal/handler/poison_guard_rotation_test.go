package handler

import (
	"context"
	"errors"
	"testing"

	"github.com/DATA-DOG/go-sqlmock"
	dbent "github.com/Wei-Shaw/sub2api/ent"
)

func TestPoisonRotationRebindTransaction(t *testing.T) {
	for _, mode := range []string{"free", "duplicate-endpoint", "lookup-error", "update-error", "lock-error", "commit-error"} {
		t.Run(mode, func(t *testing.T) {
			db, mock, err := sqlmock.New()
			if err != nil {
				t.Fatal(err)
			}
			defer db.Close()
			mock.ExpectBegin()
			lock := mock.ExpectExec("SELECT pg_advisory_xact_lock").WithArgs(int64(0x706f69736f6e))
			if mode == "lock-error" {
				lock.WillReturnError(errors.New("lock unavailable"))
			} else {
				lock.WillReturnResult(sqlmock.NewResult(0, 1))
				mock.ExpectQuery("SELECT host, port FROM proxies").WithArgs(int64(13)).WillReturnRows(sqlmock.NewRows([]string{"host", "port"}).AddRow("PROXY.EXAMPLE ", 1080))
				q := mock.ExpectQuery("SELECT DISTINCT lower")
				switch mode {
				case "lookup-error":
					q.WillReturnError(errors.New("lookup unavailable"))
				case "duplicate-endpoint":
					q.WillReturnRows(sqlmock.NewRows([]string{"endpoint"}).AddRow("proxy.example:1080"))
				default:
					q.WillReturnRows(sqlmock.NewRows([]string{"endpoint"}))
				}
			}
			if mode == "free" || mode == "update-error" || mode == "commit-error" {
				mock.ExpectQuery("SELECT EXISTS.*poison_blocked_egress").WithArgs("PROXY.EXAMPLE", int64(13)).WillReturnRows(sqlmock.NewRows([]string{"blocked"}).AddRow(false))
			}
			if mode == "free" {
				mock.ExpectCommit()
			} else if mode == "commit-error" {
				mock.ExpectCommit().WillReturnError(errors.New("commit failed"))
			} else {
				mock.ExpectRollback()
			}
			called := false
			err = rebindPoisonProxy(context.Background(), db, 42, 13, func(ctx context.Context) error {
				called = true
				if dbent.TxFromContext(ctx) == nil {
					t.Error("update must join transaction")
				}
				if mode == "update-error" {
					return errors.New("write failed")
				}
				return nil
			})
			if (err == nil) != (mode == "free") {
				t.Fatalf("mode=%s err=%v", mode, err)
			}
			wantCalled := mode == "free" || mode == "update-error" || mode == "commit-error"
			if called != wantCalled {
				t.Fatalf("update called=%v want %v", called, wantCalled)
			}
			if err := mock.ExpectationsWereMet(); err != nil {
				t.Fatal(err)
			}
		})
	}
}
