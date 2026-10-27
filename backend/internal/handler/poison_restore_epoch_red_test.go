package handler

import (
	"context"
	"database/sql"
	"os"
	"reflect"
	"testing"
	"time"

	"github.com/Wei-Shaw/sub2api/internal/poison"
	_ "github.com/lib/pq"
)

// Baseline-compatible real database probe: no audit row exists for a committed restore.
func TestPoisonRestoreEpochPostgresWithoutAudit(t *testing.T) {
	dsn := os.Getenv("POISON_TEST_POSTGRES_DSN")
	if dsn == "" {
		t.Skip("POISON_TEST_POSTGRES_DSN not configured")
	}
	db, err := sql.Open("postgres", dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	ctx := context.Background()
	conn, err := db.Conn(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	_, err = conn.ExecContext(ctx, `CREATE TEMP TABLE accounts(id bigint,proxy_id bigint,status text,schedulable boolean,deleted_at timestamptz,extra jsonb);
 CREATE TEMP TABLE audit_logs(created_at timestamptz,action text,request_body text,status_code int,extra jsonb);
 INSERT INTO accounts VALUES(42,7,'active',true,NULL,'{"poison_guard_restore_epoch":1}')`)
	if err != nil {
		t.Fatal(err)
	}
	p := int64(7)
	for _, tc := range []struct {
		name  string
		epoch int64
		want  bool
	}{
		{"old request after committed restore", 0, false},
		{"new request after restore", 1, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			inc := poison.Incident{AccountID: 42, ProxyID: &p, RequestStartedAt: time.Now().Add(-time.Minute)}
			field := reflect.ValueOf(&inc).Elem().FieldByName("RestoreEpoch")
			if field.IsValid() {
				field.SetInt(tc.epoch)
			}
			current, err := poisonIncidentCurrent(ctx, conn, inc, false)
			if err != nil {
				t.Fatal(err)
			}
			if current != tc.want {
				t.Fatalf("current=%v want=%v request_epoch=%d persisted_epoch=1 audit_rows=0", current, tc.want, tc.epoch)
			}
		})
	}
}
