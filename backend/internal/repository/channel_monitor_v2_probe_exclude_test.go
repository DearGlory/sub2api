package repository

import (
	"strings"
	"testing"

	"github.com/Wei-Shaw/sub2api/internal/service"
)

// The V2 aggregator derives "is this group busy?" from usage_logs. Probes travel
// through the gateway and land in the same table, so the exclusion has to be part
// of the SQL itself; without it a probed group would always look like it has
// organic traffic and the status page would never fall back to active probing.
func TestProbeExcludeFilterMatchesOnlyProbeUserAgent(t *testing.T) {
	filter := usageLogProbeExcludeUL
	if !strings.Contains(filter, service.ProbeUserAgent) {
		t.Fatalf("exclusion filter must reference the probe marker, got %q", filter)
	}
	if !strings.Contains(filter, "user_agent") {
		t.Fatalf("exclusion filter must test usage_logs.user_agent, got %q", filter)
	}
	// A NULL user_agent means the row predates the column or had no UA; those are
	// real traffic and must survive the filter.
	if !strings.Contains(filter, "COALESCE") {
		t.Fatalf("exclusion filter must treat NULL user_agent as real traffic, got %q", filter)
	}
}

func TestUsageLevelAggregationQueriesCarryProbeExclusion(t *testing.T) {
	// These three read usage_logs directly and feed the matrix, so each needs the
	// filter. Missing one would leak a probe into volume, latency or histogram
	// figures respectively.
	//
	// The *_RollupSQL constants are deliberately excluded: they aggregate the 1m
	// tables that these queries already filtered, so a probe cannot reappear there.
	for name, query := range map[string]string{
		"usageMetrics": channelMonitorV2UsageMetricsSQL,
		"userMetrics":  channelMonitorV2UserMetricsSQL,
		"histogram":    channelMonitorV2HistogramSQL,
	} {
		// The constants are already-resolved strings, so assert the interpolated
		// predicate rather than the constant name.
		if !strings.Contains(query, usageLogProbeExcludeUL) {
			t.Fatalf("%s query must apply the probe exclusion", name)
		}
	}
}
