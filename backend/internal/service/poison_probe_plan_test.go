//go:build unit

package service

import (
	"context"
	"database/sql"
	"os"
	"testing"

	"github.com/Wei-Shaw/sub2api/internal/poison"
	_ "github.com/lib/pq"
	"github.com/stretchr/testify/require"
)

func planPostgres(t *testing.T) *sql.DB {
	t.Helper()
	dsn := os.Getenv("POISON_TEST_POSTGRES_DSN")
	if dsn == "" {
		t.Skip("POISON_TEST_POSTGRES_DSN not configured")
	}
	db, err := sql.Open("postgres", dsn)
	require.NoError(t, err)
	db.SetMaxOpenConns(1)
	db.SetMaxIdleConns(1)
	t.Cleanup(func() { db.Close() })
	ctx := context.Background()
	var database string
	require.NoError(t, db.QueryRow("SELECT current_database()").Scan(&database))
	require.Equal(t, "poison_accept", database, "requires isolated test database")
	_, err = db.ExecContext(ctx, `
DROP TABLE IF EXISTS usage_logs, account_groups, accounts CASCADE;
CREATE TABLE accounts(
  id bigserial PRIMARY KEY,
  name text NOT NULL DEFAULT 'fixture',
  platform text NOT NULL DEFAULT 'openai',
  type text NOT NULL DEFAULT 'api_key',
  credentials jsonb NOT NULL DEFAULT '{}'::jsonb,
  extra jsonb NOT NULL DEFAULT '{}'::jsonb,
  proxy_id bigint NULL,
  status text NOT NULL DEFAULT 'active',
  schedulable boolean NOT NULL DEFAULT true,
  deleted_at timestamptz NULL
);
CREATE TABLE account_groups(
  account_id bigint NOT NULL,
  group_id bigint NOT NULL,
  priority int NOT NULL DEFAULT 50,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE usage_logs(
  id bigserial PRIMARY KEY,
  account_id bigint NOT NULL,
  group_id bigint NOT NULL,
  requested_model text NULL,
  model text NULL,
  input_tokens bigint NOT NULL DEFAULT 0,
  output_tokens bigint NOT NULL DEFAULT 0,
  total_cost numeric(20,8) NOT NULL DEFAULT 0
);`)
	require.NoError(t, err)
	t.Cleanup(func() {
		_, _ = db.ExecContext(context.Background(), `DROP TABLE IF EXISTS usage_logs, account_groups, accounts CASCADE`)
	})
	return db
}

type planAccount struct {
	baseURL     string
	proxyID     *int64
	status      string
	schedulable bool
	extra       string // raw jsonb
	deleted     bool
}

func (a planAccount) seed(t *testing.T, db *sql.DB) int64 {
	t.Helper()
	if a.status == "" {
		a.status = "active"
	}
	if a.extra == "" {
		a.extra = "{}"
	}
	var id int64
	require.NoError(t, db.QueryRow(`
INSERT INTO accounts(credentials, extra, proxy_id, status, schedulable, deleted_at)
VALUES (jsonb_build_object('api_key','synthetic','base_url',$1::text), $2::jsonb, $3, $4, $5,
        CASE WHEN $6 THEN now() ELSE NULL END)
RETURNING id`, a.baseURL, a.extra, a.proxyID, a.status, a.schedulable, a.deleted).Scan(&id))
	return id
}

func planProxy(id int64) *int64 { return &id }

func seedGroup(t *testing.T, db *sql.DB, accountID, groupID int64) {
	t.Helper()
	_, err := db.Exec(`INSERT INTO account_groups(account_id, group_id) VALUES ($1,$2)`, accountID, groupID)
	require.NoError(t, err)
}

func seedUsage(t *testing.T, db *sql.DB, accountID, groupID int64, requested, model string, tokens int64, cost float64) {
	t.Helper()
	_, err := db.Exec(`INSERT INTO usage_logs(account_id, group_id, requested_model, model, input_tokens, output_tokens, total_cost)
VALUES ($1,$2,NULLIF($3,'')::text,NULLIF($4,'')::text,$5,$5,$6)`, accountID, groupID, requested, model, tokens, cost)
	require.NoError(t, err)
}

func planScope() *poison.Snapshot {
	return &poison.Snapshot{Enabled: true, Scope: poison.NewScope([]string{"https://Shared.Example.com/"}, true)}
}

func byID(t *testing.T, got []poison.SharedAccount, id int64) poison.SharedAccount {
	t.Helper()
	for _, a := range got {
		if a.ID == id {
			return a
		}
	}
	t.Fatalf("account %d missing from plan", id)
	return poison.SharedAccount{}
}

func ids(got []poison.SharedAccount) []int64 {
	out := make([]int64, 0, len(got))
	for _, a := range got {
		out = append(out, a.ID)
	}
	return out
}

// TestPoisonProbePlanPostgres covers admission equivalence, multi-group merge,
// COUNT-not-tokens, zero-cost rows, inactive inclusion, distinct groups and ID order.
func TestPoisonProbePlanPostgres(t *testing.T) {
	db := planPostgres(t)
	ctx := context.Background()
	svc := NewPoisonProbePlanService(db)

	accA := planAccount{baseURL: "https://shared.example.com/v1", proxyID: planProxy(7), status: "active", schedulable: true,
		extra: `{"poison_guard_restore_epoch":5,"poison_guard_shared_generation":3}`}.seed(t, db)
	seedGroup(t, db, accA, 10)
	seedGroup(t, db, accA, 20)
	seedUsage(t, db, accA, 10, "model-b", "model-b", 1000000, 1.5)
	seedUsage(t, db, accA, 10, "  model-a  ", "model-a", 10, 0.25)
	seedUsage(t, db, accA, 10, "model-b", "model-b", 5, 0.5)
	seedUsage(t, db, accA, 20, "", "model-a", 3, 0)      // empty requested_model falls back to model, cost 0 kept
	seedUsage(t, db, accA, 20, "model-a", "other", 3, 0) // requested_model wins over executed model
	seedUsage(t, db, accA, 20, "model-a", "model-a", 1, 0)

	// inactive + unschedulable account must stay in the plan.
	accB := planAccount{baseURL: "https://shared.example.com", proxyID: planProxy(8), status: "disabled", schedulable: false, extra: "{}"}.seed(t, db)
	seedGroup(t, db, accB, 10)
	for i := 0; i < 5; i++ {
		seedUsage(t, db, accB, 10, "shared-model", "shared-model", 1, 0.1)
	}

	// case/whitespace padded base_url still matches.
	accC := planAccount{baseURL: "  HTTPS://SHARED.EXAMPLE.COM/v1  ", proxyID: planProxy(9)}.seed(t, db)

	// excluded: no proxy, prefix boundary, deleted, other host.
	accNoProxy := planAccount{baseURL: "https://shared.example.com/v1"}.seed(t, db)
	seedGroup(t, db, accNoProxy, 10)
	seedUsage(t, db, accNoProxy, 10, "ghost", "ghost", 99, 9)
	accSuffix := planAccount{baseURL: "https://shared.example.com.evil.net/v1", proxyID: planProxy(10)}.seed(t, db)
	accDeleted := planAccount{baseURL: "https://shared.example.com/v1", proxyID: planProxy(11), deleted: true}.seed(t, db)
	accOther := planAccount{baseURL: "https://other.example.com/v1", proxyID: planProxy(12)}.seed(t, db)

	// groups without usage stay in the plan with a plan error.
	accNoUsage := planAccount{baseURL: "https://shared.example.com/v1", proxyID: planProxy(13)}.seed(t, db)
	seedGroup(t, db, accNoUsage, 30)

	// duplicated account_groups row must not double count usage.
	accDup := planAccount{baseURL: "https://shared.example.com/v1", proxyID: planProxy(14)}.seed(t, db)
	seedGroup(t, db, accDup, 10)
	seedGroup(t, db, accDup, 10)
	seedUsage(t, db, accDup, 10, "dup-model", "dup-model", 7, 0.7)
	seedUsage(t, db, accDup, 10, "dup-model", "dup-model", 7, 0.7)

	got, err := svc.Plan(ctx, planScope())
	require.NoError(t, err)
	require.Equal(t, []int64{accA, accB, accC, accNoUsage, accDup}, ids(got), "admitted accounts in ID order")
	for _, excluded := range []int64{accNoProxy, accSuffix, accDeleted, accOther} {
		require.NotContains(t, ids(got), excluded, "not admitted")
	}

	a := byID(t, got, accA)
	require.Equal(t, "model-a", a.Model)
	require.Equal(t, int64(4), a.ModelRequests, "merged across groups, count rows not tokens")
	require.Equal(t, []int64{10, 20}, a.GroupIDs)
	require.Equal(t, int64(5), a.RestoreEpoch)
	require.Equal(t, int64(3), a.SharedGeneration)
	require.Equal(t, "https://shared.example.com/v1", a.BaseURL)
	require.Equal(t, "active", a.Status)
	require.True(t, a.Schedulable)
	require.Empty(t, a.PlanError)

	b := byID(t, got, accB)
	require.Equal(t, "shared-model", b.Model)
	require.Equal(t, int64(5), b.ModelRequests)
	require.Equal(t, "disabled", b.Status)
	require.False(t, b.Schedulable)
	require.Equal(t, int64(0), b.RestoreEpoch)
	require.Equal(t, int64(0), b.SharedGeneration)
	require.Empty(t, b.PlanError)

	c := byID(t, got, accC)
	require.Empty(t, c.GroupIDs)
	require.Empty(t, c.Model)
	require.Equal(t, int64(0), c.ModelRequests)
	require.Equal(t, "no_groups", c.PlanError)

	d := byID(t, got, accNoUsage)
	require.Equal(t, []int64{30}, d.GroupIDs)
	require.Empty(t, d.Model)
	require.Equal(t, "no_usage", d.PlanError)

	e := byID(t, got, accDup)
	require.Equal(t, []int64{10}, e.GroupIDs, "distinct group ids")
	require.Equal(t, int64(2), e.ModelRequests, "duplicate account_groups rows do not duplicate counts")
	require.Equal(t, "dup-model", e.Model)
}

// TestPoisonProbePlanTieBreakPostgres prefers the lexicographically smaller model on a tie.
func TestPoisonProbePlanTieBreakPostgres(t *testing.T) {
	db := planPostgres(t)
	ctx := context.Background()
	svc := NewPoisonProbePlanService(db)

	acc := planAccount{baseURL: "https://shared.example.com/v1", proxyID: planProxy(20)}.seed(t, db)
	seedGroup(t, db, acc, 1)
	seedGroup(t, db, acc, 2)
	seedUsage(t, db, acc, 1, "zeta-model", "zeta-model", 1, 1)
	seedUsage(t, db, acc, 1, "zeta-model", "zeta-model", 1, 1)
	seedUsage(t, db, acc, 2, "alpha-model", "alpha-model", 1, 1)
	seedUsage(t, db, acc, 2, "alpha-model", "alpha-model", 1, 1)

	got, err := svc.Plan(ctx, planScope())
	require.NoError(t, err)
	require.Len(t, got, 1)
	require.Equal(t, "alpha-model", got[0].Model)
	require.Equal(t, int64(2), got[0].ModelRequests)
}

// TestPoisonProbePlanInactiveSnapshotPostgres returns no work when the snapshot is inactive.
func TestPoisonProbePlanInactiveSnapshotPostgres(t *testing.T) {
	db := planPostgres(t)
	svc := NewPoisonProbePlanService(db)
	planAccount{baseURL: "https://shared.example.com/v1", proxyID: planProxy(30)}.seed(t, db)

	for name, snap := range map[string]*poison.Snapshot{
		"nil":      nil,
		"no_scope": {Enabled: true},
		"disabled": {Enabled: true, Scope: poison.NewScope([]string{"https://shared.example.com"}, false)},
	} {
		got, err := svc.Plan(context.Background(), snap)
		require.NoError(t, err, name)
		require.Empty(t, got, name)
	}
}
