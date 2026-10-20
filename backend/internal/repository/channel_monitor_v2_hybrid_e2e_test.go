//go:build integration

package repository

import (
	"context"
	"database/sql"
	"os"
	"testing"
	"time"

	dbent "github.com/Wei-Shaw/sub2api/ent"
	"github.com/Wei-Shaw/sub2api/internal/service"
	_ "github.com/lib/pq"
	"github.com/stretchr/testify/require"
)

// TestHybridProbeFallbackAgainstDatabase exercises GetMatrix against a real
// Postgres instance that has been seeded with:
//   - one group carrying organic usage_logs traffic (plus one probe-tainted row)
//   - one group with NO organic traffic, only channel_monitor_histories probes
//
// It asserts the two halves of the hybrid contract:
//  1. the traffic group reports real figures and the probe-tainted row is ignored
//  2. the idle group's buckets are filled from probe samples, labelled as probe
//
// Run with:
//
//	E2E_DATABASE_URL=postgres://user:pass@127.0.0.1:port/db?sslmode=disable \
//	  go test -tags integration ./internal/repository/ -run TestHybridProbeFallbackAgainstDatabase -v
func TestHybridProbeFallbackAgainstDatabase(t *testing.T) {
	dsn := os.Getenv("E2E_DATABASE_URL")
	if dsn == "" {
		t.Skip("E2E_DATABASE_URL not set; skipping database-backed hybrid check")
	}
	db, err := sql.Open("postgres", dsn)
	require.NoError(t, err)
	defer func() { _ = db.Close() }()
	require.NoError(t, db.PingContext(context.Background()))

	dbentClient, err := dbent.Open("postgres", dsn)
	require.NoError(t, err)
	monitorRepo := NewChannelMonitorRepository(dbentClient, db)
	repo := NewChannelMonitorV2Repository(db, monitorRepo).(*channelMonitorV2Repository)
	cfg := defaultE2EConfig()

	end := time.Now()
	start := end.Add(-90 * time.Minute)
	filter := service.ChannelMonitorV2Filter{
		Range:  "90m",
		Start:  start,
		End:    end,
		Bucket: 5 * time.Minute,
	}

	matrix, err := repo.GetMatrix(context.Background(), filter, cfg, service.ChannelMonitorV2GroupByPlatformGroup, true)
	require.NoError(t, err)
	byGroup := map[string]service.ChannelMonitorV2MatrixRow{}
	for _, row := range matrix.Items {
		if row.GroupID != nil && *row.GroupID > 0 {
			byGroup[row.GroupName] = row
		}
	}
	t.Logf("matrix groups: %v", keysOf(byGroup))

	real, ok := byGroup["default"]
	require.True(t, ok, "the group with organic traffic must be present")

	probeBuckets, realBuckets := 0, 0
	for _, bucket := range real.Buckets {
		switch bucket.Source {
		case service.ChannelMonitorBucketSourceProbe:
			probeBuckets++
		default:
			realBuckets++
		}
	}
	require.Greater(t, realBuckets, 0, "the traffic group must keep at least one real bucket")
	t.Logf("default: %d real buckets, %d probe buckets, total requests=%d",
		realBuckets, probeBuckets, real.Metrics.RequestCount)

	// 6 organic rows count as successful traffic (the 2 rows seeded with
	// actual_cost=0 are the failures, and one probe-tainted row sits in the same
	// group). Had the probe leaked through, this would be 7.
	require.EqualValues(t, 6, real.Metrics.RequestCount,
		"the probe-marked usage row must not be counted as organic traffic")

	idle, ok := byGroup["hybrid-e2e-group"]
	require.True(t, ok, "the idle group must still appear via probe fallback")

	healthyProbeBuckets, failedProbeBuckets := 0, 0
	for _, bucket := range idle.Buckets {
		require.Equal(t, service.ChannelMonitorBucketSourceProbe, bucket.Source,
			"every bucket on a group with no organic traffic must be probe-sourced")
		require.EqualValues(t, 1, bucket.Metrics.RequestCount,
			"a probe bucket represents exactly one probe request")
		if bucket.Metrics.SuccessRate == 1 {
			healthyProbeBuckets++
			require.Equal(t, "healthy", bucket.Health.Overall,
				"a healthy probe bucket must not be greyed out as low-sample")
			// The rates are derived, not written down: one successful probe is
			// 1/1 requests and 1/1 prompt tokens served from cache.
			require.EqualValues(t, 1, bucket.Metrics.CacheRate,
				"a healthy probe reads as 1/1 = 100%% cache rate")
			require.NotNil(t, bucket.Metrics.TTFT.P50Ms,
				"a healthy probe bucket must carry the measured first token")
			require.EqualValues(t, 180, *bucket.Metrics.TTFT.P50Ms)
			continue
		}
		failedProbeBuckets++
		require.Equal(t, "critical", bucket.Health.Overall,
			"a failed probe must surface as critical, not as unknown")
		require.Zero(t, bucket.Metrics.SuccessRate,
			"a failed probe must read as 0/1 = 0%% availability")
		require.Nil(t, bucket.Metrics.TTFT.P50Ms,
			"a failed probe has no first token; the page must show '-'")
	}
	require.Equal(t, 1, healthyProbeBuckets, "the healthy probe must fill its own bucket")
	require.Equal(t, 1, failedProbeBuckets, "the failed probe must fill its own bucket")
	idleProbeBuckets := healthyProbeBuckets + failedProbeBuckets
	require.Greater(t, idleProbeBuckets, 0,
		"a group with no organic traffic must be filled from probe history")
	t.Logf("hybrid-e2e-group: %d probe buckets", idleProbeBuckets)
}

func defaultE2EConfig() service.ChannelMonitorV2Config {
	return service.ChannelMonitorV2Config{
		Enabled: true,
		Platforms: []service.ChannelMonitorV2PlatformConfig{
			{Platform: "anthropic", Enabled: true},
		},
	}
}

func keysOf(m map[string]service.ChannelMonitorV2MatrixRow) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	return out
}
