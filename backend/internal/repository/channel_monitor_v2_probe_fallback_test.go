package repository

import (
	"testing"
	"time"

	"github.com/Wei-Shaw/sub2api/internal/service"
)

func probeEntry(status string, ttft *int, at time.Time) *service.ChannelMonitorHistoryEntry {
	return &service.ChannelMonitorHistoryEntry{Status: status, TtftMs: ttft, CheckedAt: at}
}

func intPtr(v int) *int { return &v }

func TestProbeSamplesToMetricsDeriveRatesFromProbeCounts(t *testing.T) {
	base := time.Date(2026, 10, 20, 10, 0, 0, 0, time.UTC)

	// One successful probe with a real TTFT: cache and availability become 100%
	// because 1/1 requests succeeded, not because anything is hardcoded.
	metrics, ok := probeSamplesToMetrics([]channelMonitorHybridProbeSample{
		{Success: true, TTFTMs: intPtr(180), CheckedAt: base},
	}, 5, false)
	if !ok {
		t.Fatal("one sample must produce metrics")
	}
	if metrics.RequestCount != 1 || metrics.SuccessRequests != 1 {
		t.Fatalf("probe must count as exactly one successful request: %+v", metrics)
	}
	if metrics.SuccessRate != 1 {
		t.Fatalf("success rate must be 1/1 = 100%%, got %v", metrics.SuccessRate)
	}
	if metrics.CacheRateDenominator != 1 || metrics.CacheRateNumerator != 1 {
		t.Fatalf("cache rate must be 1/1 = 100%%, got %d/%d", metrics.CacheRateNumerator, metrics.CacheRateDenominator)
	}
	if metrics.TTFT.P50Ms == nil || *metrics.TTFT.P50Ms != 180 {
		t.Fatalf("probe TTFT must come from the measured first token, got %+v", metrics.TTFT)
	}
}

func TestProbeSamplesToMetricsReportZeroForFailedProbe(t *testing.T) {
	metrics, ok := probeSamplesToMetrics([]channelMonitorHybridProbeSample{
		{Success: false, CheckedAt: time.Now()},
	}, 5, false)
	if !ok {
		t.Fatal("a failed sample must still produce metrics")
	}
	if metrics.SuccessRate != 0 {
		t.Fatalf("a failed probe is 0/1 = 0%%, got %v", metrics.SuccessRate)
	}
	if metrics.CacheRateDenominator != 1 || metrics.CacheRateNumerator != 0 {
		t.Fatalf("a failed probe caches nothing: %d/%d", metrics.CacheRateNumerator, metrics.CacheRateDenominator)
	}
	if metrics.TTFT.P50Ms != nil {
		t.Fatalf("a failed probe has no first token, got %v", *metrics.TTFT.P50Ms)
	}
}

func TestProbeSamplesToMetricsIgnoreMissingTTFT(t *testing.T) {
	metrics, _ := probeSamplesToMetrics([]channelMonitorHybridProbeSample{
		{Success: true, TTFTMs: nil, CheckedAt: time.Now()},
	}, 5, false)
	if metrics.TTFT.P50Ms != nil {
		t.Fatalf("an unmeasured first token must stay absent rather than fall back to latency: %v", *metrics.TTFT.P50Ms)
	}
	if metrics.SuccessRate != 1 {
		t.Fatalf("an unmeasured TTFT must not affect availability: %v", metrics.SuccessRate)
	}
}

func TestBucketProbeSamplesByGroupAlignsToBucketBoundary(t *testing.T) {
	base := time.Date(2026, 10, 20, 10, 7, 30, 0, time.UTC)
	bucketed := bucketProbeSamplesByGroup(map[string][]*service.ChannelMonitorHistoryEntry{
		"claude": {probeEntry(service.MonitorStatusOperational, intPtr(120), base)},
	}, 5)

	buckets := bucketed["claude"]
	if len(buckets) != 1 {
		t.Fatalf("expected one bucket, got %d", len(buckets))
	}
	want := time.Date(2026, 10, 20, 10, 5, 0, 0, time.UTC).Format(time.RFC3339Nano)
	if _, ok := buckets[want]; !ok {
		t.Fatalf("10:07:30 must snap into the 10:05 bucket, got %v", buckets)
	}
}

func TestApplyProbeFallbackKeepsRealTrafficBuckets(t *testing.T) {
	base := time.Date(2026, 10, 20, 10, 0, 0, 0, time.UTC)
	matrix := &service.ChannelMonitorV2Matrix{Items: []service.ChannelMonitorV2MatrixRow{{
		Platform:  "anthropic",
		GroupName: "claude",
		Buckets: []service.ChannelMonitorV2TrendPoint{{
			BucketStart: base,
			Metrics:     service.ChannelMonitorV2Metric{RequestCount: 8, SuccessRequests: 6, CacheRateNumerator: 50, CacheRateDenominator: 200},
		}},
	}}}

	probes := bucketProbeSamplesByGroup(map[string][]*service.ChannelMonitorHistoryEntry{
		"claude": {probeEntry(service.MonitorStatusOperational, intPtr(99), base.Add(time.Minute))},
	}, 5)

	applyProbeFallbackToMatrix(matrix, probes, 5, false)

	got := matrix.Items[0].Buckets[0]
	if got.Metrics.RequestCount != 8 {
		t.Fatalf("real traffic must win over a probe in the same bucket, got %d requests", got.Metrics.RequestCount)
	}
	if got.Source == service.ChannelMonitorBucketSourceProbe {
		t.Fatal("a bucket with traffic must not be labelled as probe-sourced")
	}
}

func TestApplyProbeFallbackAddsProbeBucketsWhenNoTraffic(t *testing.T) {
	base := time.Date(2026, 10, 20, 10, 0, 0, 0, time.UTC)
	matrix := &service.ChannelMonitorV2Matrix{Items: []service.ChannelMonitorV2MatrixRow{{
		Platform:  "anthropic",
		GroupName: "claude",
	}}}
	probes := bucketProbeSamplesByGroup(map[string][]*service.ChannelMonitorHistoryEntry{
		"claude": {probeEntry(service.MonitorStatusOperational, intPtr(140), base.Add(2*time.Minute))},
	}, 5)

	applyProbeFallbackToMatrix(matrix, probes, 5, false)

	if len(matrix.Items[0].Buckets) != 1 {
		t.Fatalf("a probe-only bucket must still produce a column, got %d", len(matrix.Items[0].Buckets))
	}
	bucket := matrix.Items[0].Buckets[0]
	if bucket.Source != service.ChannelMonitorBucketSourceProbe {
		t.Fatalf("bucket must be labelled probe-sourced, got %q", bucket.Source)
	}
	if bucket.Metrics.SuccessRate != 1 {
		t.Fatalf("probe bucket availability must be 1/1 = 100%%, got %v", bucket.Metrics.SuccessRate)
	}
}

func TestApplyProbeFallbackIgnoresGroupsWithoutMonitors(t *testing.T) {
	base := time.Date(2026, 10, 20, 10, 0, 0, 0, time.UTC)
	matrix := &service.ChannelMonitorV2Matrix{Items: []service.ChannelMonitorV2MatrixRow{{
		Platform:  "anthropic",
		GroupName: "claude",
	}}}
	probes := bucketProbeSamplesByGroup(map[string][]*service.ChannelMonitorHistoryEntry{
		"some-other-group": {probeEntry(service.MonitorStatusOperational, intPtr(140), base)},
	}, 5)

	applyProbeFallbackToMatrix(matrix, probes, 5, false)

	if len(matrix.Items[0].Buckets) != 0 {
		t.Fatalf("probes must only fill their own group's rows, got %d buckets", len(matrix.Items[0].Buckets))
	}
}

func TestProbeBucketHealthGradesOnTheProbeOutcome(t *testing.T) {
	// One request is below the default 50-sample floor, so the standard scorer
	// would answer "unknown". A probe bucket must still report what the probe saw,
	// otherwise an idle channel is permanently greyed out and the probe is useless.
	healthy, _ := probeSamplesToMetrics([]channelMonitorHybridProbeSample{
		{Success: true, TTFTMs: intPtr(200), CheckedAt: time.Now()},
	}, 5, false)
	health := probeBucketHealth(healthy)
	if health.Overall != "healthy" {
		t.Fatalf("a successful probe must read as healthy, got %q", health.Overall)
	}
	if health.TTFT != "healthy" {
		t.Fatalf("a measured first token must read as healthy, got %q", health.TTFT)
	}

	failed, _ := probeSamplesToMetrics([]channelMonitorHybridProbeSample{
		{Success: false, CheckedAt: time.Now()},
	}, 5, false)
	failedHealth := probeBucketHealth(failed)
	if failedHealth.Overall != "critical" {
		t.Fatalf("a failed probe must read as critical, got %q", failedHealth.Overall)
	}
	if failedHealth.TTFT != "unknown" {
		t.Fatalf("a failed probe has no first token to grade, got %q", failedHealth.TTFT)
	}
}

func TestProbeBucketHealthLeavesEmptyBucketUnknown(t *testing.T) {
	if got := probeBucketHealth(service.ChannelMonitorV2Metric{}); got.Overall != "unknown" {
		t.Fatalf("a bucket with no probe must stay unknown, got %q", got.Overall)
	}
}
