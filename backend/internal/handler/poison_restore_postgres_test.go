package handler

import (
	"context"
	"database/sql"
	"os"
	"testing"
	"time"

	"github.com/Wei-Shaw/sub2api/internal/poison"
	_ "github.com/lib/pq"
)

// Uses session-local temporary tables, never existing account/audit data.
func TestPoisonRestoreAuditPostgres(t *testing.T) {
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
	_, err = conn.ExecContext(ctx, `CREATE TEMP TABLE accounts(id bigint,proxy_id bigint,status text,schedulable boolean,deleted_at timestamptz);
 CREATE TEMP TABLE audit_logs(created_at timestamptz,action text,request_body text,status_code int,extra jsonb);
 INSERT INTO accounts VALUES(42,7,'active',true,NULL)`)
	if err != nil {
		t.Fatal(err)
	}
	started := time.Date(2026, 1, 2, 3, 4, 5, 0, time.UTC)
	p := int64(7)
	inc := poison.Incident{AccountID: 42, ProxyID: &p, RequestStartedAt: started}
	for _, tc := range []struct {
		name, action, body, id string
		offset                 time.Duration
		status                 int
		current                bool
	}{
		{"same proxy restore", "admin.accounts.update", `{"status":"active"}`, "42", time.Second, 200, false},
		{"scheduler restore", "admin.accounts.schedulable.create", `{"schedulable":true}`, "42", time.Second, 200, false},
		{"other account", "admin.accounts.update", `{"status":"active"}`, "43", time.Second, 200, true},
		{"before request", "admin.accounts.update", `{"status":"active"}`, "42", -time.Second, 200, true},
		{"failed update", "admin.accounts.update", `{"status":"active"}`, "42", time.Second, 400, true},
		{"test action", "admin.accounts.test.create", `{"status":"active"}`, "42", time.Second, 200, true},
		{"usage action", "admin.accounts.usage.create", `{"status":"active"}`, "42", time.Second, 200, true},
		{"model sync", "admin.accounts.sync_models.create", `{"status":"active"}`, "42", time.Second, 200, true},
		{"ordinary edit", "admin.accounts.update", `{"name":"test"}`, "42", time.Second, 200, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if _, err := conn.ExecContext(ctx, "DELETE FROM audit_logs"); err != nil {
				t.Fatal(err)
			}
			_, err := conn.ExecContext(ctx, `INSERT INTO audit_logs VALUES($1,$2,$3,$4,jsonb_build_object('params',jsonb_build_object('id',$5::text)))`, started.Add(tc.offset), tc.action, tc.body, tc.status, tc.id)
			if err != nil {
				t.Fatal(err)
			}
			current, err := poisonIncidentCurrent(ctx, conn, inc, false)
			if err != nil || current != tc.current {
				t.Fatalf("current=%v want=%v err=%v", current, tc.current, err)
			}
		})
	}
}
