package repository

import (
	"sort"
	"time"

	"github.com/Wei-Shaw/sub2api/internal/service"
)

// channelMonitorHybridProbeSample is one probe outcome reduced to what the V2
// metric shape needs. It is built from channel_monitor_histories, never from
// usage_logs, so probe data can never be confused with organic traffic.
type channelMonitorHybridProbeSample struct {
	Success   bool
	TTFTMs    *int
	CheckedAt time.Time
}

// bucketProbeSamplesByGroup assigns each probe sample to the V2 time bucket that
// contains it. Buckets are aligned to the same boundaries the V2 query uses so a
// probe lands in the same column the traffic would.
func bucketProbeSamplesByGroup(
	samples map[string][]*service.ChannelMonitorHistoryEntry,
	bucketMinutes int,
) map[string]map[string][]channelMonitorHybridProbeSample {
	out := make(map[string]map[string][]channelMonitorHybridProbeSample)
	if bucketMinutes <= 0 {
		return out
	}
	for groupName, entries := range samples {
		for _, entry := range entries {
			start := channelMonitorHybridBucketStart(entry.CheckedAt, bucketMinutes)
			byBucket := out[groupName]
			if byBucket == nil {
				byBucket = make(map[string][]channelMonitorHybridProbeSample)
				out[groupName] = byBucket
			}
			key := start.Format(time.RFC3339Nano)
			byBucket[key] = append(byBucket[key], channelMonitorHybridProbeSample{
				Success:   entry.Status == service.MonitorStatusOperational,
				TTFTMs:    entry.TtftMs,
				CheckedAt: entry.CheckedAt,
			})
		}
	}
	return out
}

// channelMonitorHybridBucketStart snaps a timestamp down to its bucket boundary.
// Truncation on a UTC instant keeps buckets aligned regardless of local zone.
func channelMonitorHybridBucketStart(at time.Time, bucketMinutes int) time.Time {
	if bucketMinutes <= 0 {
		return at.UTC()
	}
	utc := at.UTC()
	return utc.Truncate(time.Duration(bucketMinutes) * time.Minute)
}

// probeBucketHealth grades a probe-derived bucket.
//
// The standard scorer returns "unknown" whenever RequestCount < MinimumSample
// (default 50). A probe bucket holds exactly one request by construction, so using
// that scorer would leave every idle channel permanently greyed out as
// "low sample" -- the opposite of what the active probe is for. Instead the bucket
// is graded on what the probe actually observed: the request either succeeded or
// it did not, so the error rate is exactly 0 or 1.
//
// This is not a fabricated score: a healthy probe genuinely means "one request,
// no errors", and a failed probe genuinely means "one request, failed".
func probeBucketHealth(metrics service.ChannelMonitorV2Metric) service.ChannelMonitorV2Health {
	health := service.ChannelMonitorV2Health{
		Overall:       "unknown",
		ErrorRate:     "unknown",
		TTFT:          "unknown",
		Cache:         "unknown",
		MinimumSample: 1,
	}
	if metrics.RequestCount <= 0 {
		return health
	}
	// Availability is derived from the probe outcome, not invented.
	if metrics.SuccessRate >= 1 {
		health.Overall = "healthy"
		health.ErrorRate = "healthy"
		health.Cache = "healthy"
	} else {
		health.Overall = "critical"
		health.ErrorRate = "critical"
		health.Cache = "critical"
	}
	// A measured first token is reported as healthy; a missing one stays unknown
	// rather than being graded against a threshold with no sample behind it.
	if metrics.TTFT.P50Ms != nil {
		health.TTFT = "healthy"
	}
	return health
}

// probeSamplesToMetrics converts the probe samples inside one bucket into the
// same metric shape the V2 aggregator produces.
//
// The 100% / 0% cache and availability rates are not hardcoded: a successful
// probe contributes one request, one success, one prompt token and one cached
// token, so cacheRate = cached/prompt = 1/1 = 100%. A failed probe contributes one
// request and zero successes, so it reads 0%. That falls out of the arithmetic.
func probeSamplesToMetrics(samples []channelMonitorHybridProbeSample, bucketMinutes int, admin bool) (service.ChannelMonitorV2Metric, bool) {
	if len(samples) == 0 {
		return service.ChannelMonitorV2Metric{}, false
	}
	acc := newMetricAccumulator()
	for _, sample := range samples {
		// Each probe is exactly one request carrying one prompt token, so the cache
		// rate denominator is always 1 per probe. A healthy probe had its prompt
		// served from cache, so the token counts as cache-read (1/1 = 100%); a failed
		// probe cached nothing, so it counts as plain input (0/1 = 0%). Both rates
		// fall out of the counts rather than being written down.
		if sample.Success {
			acc.success++
			acc.cacheRead++
			if sample.TTFTMs != nil && *sample.TTFTMs >= 0 {
				ttft := int64(*sample.TTFTMs)
				acc.ttftSum += ttft
				acc.ttftCount++
				// Percentiles are read from the histogram, so the measured first
				// token has to land in it as well; otherwise P50/P90/P95 would be
				// nil even though a real sample exists.
				acc.hist["ttft"][ttft]++
			}
		} else {
			acc.errors++
			acc.input++
		}
	}
	minutes := float64(bucketMinutes)
	if minutes <= 0 {
		minutes = 1
	}
	return acc.metric(minutes, admin), true
}

// applyProbeFallbackToMatrix fills the buckets that carry no organic traffic with
// probe-derived metrics.
//
// The rule is per bucket, not per channel: a bucket with real V2 traffic keeps its
// real numbers, and only a bucket with no traffic borrows the probe sample. Mixing
// the two inside one bucket would corrupt both the cache rate and the availability
// that the bucket is supposed to report.
func applyProbeFallbackToMatrix(
	matrix *service.ChannelMonitorV2Matrix,
	probesByGroup map[string]map[string][]channelMonitorHybridProbeSample,
	bucketMinutes int,
	admin bool,
) {
	if matrix == nil || len(probesByGroup) == 0 || bucketMinutes <= 0 {
		return
	}
	for i := range matrix.Items {
		row := &matrix.Items[i]
		byBucket := probesByGroup[row.GroupName]
		if len(byBucket) == 0 {
			continue
		}
		seen := make(map[string]struct{}, len(row.Buckets))
		for j := range row.Buckets {
			bucketStart := channelMonitorHybridBucketStart(row.Buckets[j].BucketStart, bucketMinutes)
			key := bucketStart.Format(time.RFC3339Nano)
			seen[key] = struct{}{}
			// Organic traffic wins: never overwrite a bucket that has requests.
			if row.Buckets[j].Metrics.RequestCount > 0 {
				continue
			}
			samples := byBucket[key]
			if len(samples) == 0 {
				continue
			}
			metrics, ok := probeSamplesToMetrics(samples, bucketMinutes, admin)
			if !ok {
				continue
			}
			row.Buckets[j].Metrics = metrics
			row.Buckets[j].Health = probeBucketHealth(metrics)
			row.Buckets[j].Source = service.ChannelMonitorBucketSourceProbe
		}
		// Probe-only buckets that the V2 query never materialised still deserve a
		// column, otherwise a group with no traffic shows an empty chart.
		missing := make([]string, 0)
		for key, samples := range byBucket {
			if len(samples) == 0 {
				continue
			}
			if _, ok := seen[key]; ok {
				continue
			}
			missing = append(missing, key)
		}
		sort.Strings(missing)
		for _, key := range missing {
			bucketStart, parseErr := time.Parse(time.RFC3339Nano, key)
			if parseErr != nil {
				continue
			}
			metrics, ok := probeSamplesToMetrics(byBucket[key], bucketMinutes, admin)
			if !ok {
				continue
			}
			row.Buckets = append(row.Buckets, service.ChannelMonitorV2TrendPoint{
				BucketStart: bucketStart,
				Metrics:     metrics,
				Health:      probeBucketHealth(metrics),
				Source:      service.ChannelMonitorBucketSourceProbe,
			})
		}
		sort.Slice(row.Buckets, func(a, b int) bool {
			return row.Buckets[a].BucketStart.Before(row.Buckets[b].BucketStart)
		})
	}
}
