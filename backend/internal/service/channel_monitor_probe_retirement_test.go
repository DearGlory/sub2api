//go:build unit

package service

import (
	"context"
	"testing"

	"github.com/stretchr/testify/require"
)

type channelMonitorRuntimeStub struct {
	rt ChannelMonitorRuntime
}

func (s channelMonitorRuntimeStub) GetChannelMonitorRuntime(context.Context) ChannelMonitorRuntime {
	return s.rt
}

func TestRunCheck_ModeV2NeverProbes(t *testing.T) {
	svc := NewChannelMonitorService(nil, nil)
	svc.SetRuntimeReader(channelMonitorRuntimeStub{rt: ChannelMonitorRuntime{
		Enabled: true,
		Mode:    ChannelMonitorModeV2,
	}})

	results, err := svc.RunCheck(context.Background(), 1)
	require.ErrorIs(t, err, ErrChannelMonitorActiveProbesRetired)
	require.Nil(t, results)
}

func TestRunCheck_DisabledReturnsDisabled(t *testing.T) {
	svc := NewChannelMonitorService(nil, nil)
	svc.SetRuntimeReader(channelMonitorRuntimeStub{rt: ChannelMonitorRuntime{
		Enabled: false,
		Mode:    ChannelMonitorModeV1,
	}})

	_, err := svc.RunCheck(context.Background(), 1)
	require.ErrorIs(t, err, ErrChannelMonitorDisabled)
}

func TestRunCheck_NilRuntimeReaderFailsClosedAsV2(t *testing.T) {
	svc := NewChannelMonitorService(nil, nil)
	// No SetRuntimeReader → probeRuntime defaults to mode=v2 (retired).
	_, err := svc.RunCheck(context.Background(), 1)
	require.ErrorIs(t, err, ErrChannelMonitorActiveProbesRetired)
}

func TestNormalizeChannelMonitorMode(t *testing.T) {
	require.Equal(t, ChannelMonitorModeV1, normalizeChannelMonitorMode(""))
	require.Equal(t, ChannelMonitorModeV1, normalizeChannelMonitorMode("v1"))
	require.Equal(t, ChannelMonitorModeV2, normalizeChannelMonitorMode("v2"))
	require.Equal(t, ChannelMonitorModeV3, normalizeChannelMonitorMode("v3"))
	require.Equal(t, ChannelMonitorModeV1, normalizeChannelMonitorMode("invalid"))
	require.Equal(t, ChannelMonitorModeV1, normalizeChannelMonitorMode(" V1 "))
	require.Equal(t, ChannelMonitorModeV3, normalizeChannelMonitorMode(" V3 "))
}

func TestChannelMonitorRuntimeActiveProbesAllowed(t *testing.T) {
	require.False(t, (ChannelMonitorRuntime{Enabled: false, Mode: ChannelMonitorModeV1}).ActiveProbesAllowed())
	require.True(t, (ChannelMonitorRuntime{Enabled: true, Mode: ChannelMonitorModeV1}).ActiveProbesAllowed())
	require.False(t, (ChannelMonitorRuntime{Enabled: true, Mode: ChannelMonitorModeV2}).ActiveProbesAllowed())
	require.True(t, (ChannelMonitorRuntime{Enabled: true, Mode: ChannelMonitorModeV2}).PassiveAggregationAllowed())
}

// v3 is the hybrid: passive aggregation AND active probes run together, so the
// empty buckets can be filled by probe fallback.
func TestChannelMonitorRuntimeV3HybridRunsBothSources(t *testing.T) {
	hybrid := ChannelMonitorRuntime{Enabled: true, Mode: ChannelMonitorModeV3}
	require.True(t, hybrid.ActiveProbesAllowed(), "v3 must keep probes running")
	require.True(t, hybrid.PassiveAggregationAllowed(), "v3 must keep aggregation running")
	require.True(t, hybrid.PassiveViewAllowed(), "v3 rides the passive view stack")

	// The feature switch still wins over the mode.
	off := ChannelMonitorRuntime{Enabled: false, Mode: ChannelMonitorModeV3}
	require.False(t, off.ActiveProbesAllowed())
	require.False(t, off.PassiveAggregationAllowed())
}

// v1 stays probe-only: aggregation must not silently start there.
func TestChannelMonitorRuntimeV1StaysProbeOnly(t *testing.T) {
	v1 := ChannelMonitorRuntime{Enabled: true, Mode: ChannelMonitorModeV1}
	require.True(t, v1.ActiveProbesAllowed())
	require.False(t, v1.PassiveAggregationAllowed())
	require.False(t, v1.PassiveViewAllowed())
}

// RunCheck's mode gate must not retire probes under v3. The service is built
// without dependencies, so passing the gate means the call proceeds and panics
// further down — the gate is the only thing under test here.
func TestRunCheck_ModeV3DoesNotRetireProbes(t *testing.T) {
	svc := NewChannelMonitorService(nil, nil)
	svc.SetRuntimeReader(channelMonitorRuntimeStub{rt: ChannelMonitorRuntime{
		Enabled: true,
		Mode:    ChannelMonitorModeV3,
	}})

	var err error
	func() {
		defer func() {
			// Reaching the dependency code proves the mode gate let it through.
			_ = recover()
		}()
		_, err = svc.RunCheck(context.Background(), 1)
	}()
	require.NotErrorIs(t, err, ErrChannelMonitorActiveProbesRetired,
		"v3 must not retire active probes")
	require.NotErrorIs(t, err, ErrChannelMonitorDisabled)
}
