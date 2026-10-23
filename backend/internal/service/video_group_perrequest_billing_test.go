//go:build unit

package service

import (
	"context"
	"testing"

	"github.com/Wei-Shaw/sub2api/internal/config"
)

// 视频计费口径回归：
//   - 分组价卡 per_request → 按次扣费，不乘时长（本次修复要保住的行为）；
//   - 分组没有 per_request 卡、只有 video_model_prices 按秒价 → 仍按秒，不得被压成按次。
//
// 背景：calculateOpenAIVideoCost 早期只认 BillingModeVideo 的分组价卡，
// per_request 卡被静默跳过，落到 CalculateVideoCost 按秒计价，表现为
// 「价卡写 0.2/次，实际按秒扣 0.15/0.25/0.375」。

func newVideoBillingTestService() (*OpenAIGatewayService, *APIKey) {
	bs := NewBillingService(&config.Config{}, nil)
	svc := &OpenAIGatewayService{
		billingService: bs,
		resolver:       NewModelPricingResolver(nil, bs),
	}
	group := &Group{ID: 30, Name: "视频分组", Platform: PlatformComposite}
	return svc, &APIKey{GroupID: &group.ID, Group: group}
}

func TestVideoCost_GroupPerRequestCardIgnoresDuration(t *testing.T) {
	const perRequest = 0.2
	svc, apiKey := newVideoBillingTestService()
	apiKey.Group = &Group{
		ID: 30, Name: "视频分组", Platform: PlatformComposite,
		ModelPricing: []ChannelModelPricing{{
			Platform:        "composite",
			Models:          []string{"grok-imagine-video-1.5"},
			BillingMode:     BillingModePerRequest,
			PerRequestPrice: ptrFloat(perRequest),
		}},
		// 分组旧字段里仍有按秒价，绝不能抢在价卡前面生效。
		VideoModelPrices: map[string]map[string]float64{
			"grok-imagine-video-1.5": {"480p": 0.025, "720p": 0.025, "1080p": 0.025},
		},
	}

	for _, duration := range []int{6, 10, 15} {
		result := &OpenAIForwardResult{
			VideoCount:           1,
			VideoResolution:      VideoBillingResolution720P,
			VideoDurationSeconds: duration,
		}
		cost := svc.calculateOpenAIVideoCost(context.Background(), "grok-imagine-video-1.5", apiKey, result, 1.0)
		if cost == nil {
			t.Fatalf("%ds: cost 为 nil", duration)
		}
		if diff := cost.ActualCost - perRequest; diff > 1e-9 || diff < -1e-9 {
			t.Errorf("%ds: 期望按次 %.4f，实际 %.4f", duration, perRequest, cost.ActualCost)
		}
	}
}

func TestVideoCost_WithoutGroupCardStaysPerSecond(t *testing.T) {
	svc, apiKey := newVideoBillingTestService()
	apiKey.Group = &Group{
		ID: 30, Name: "视频分组", Platform: PlatformComposite,
		VideoModelPrices: map[string]map[string]float64{
			"grok-imagine-video-1.5": {"480p": 0.025, "720p": 0.025, "1080p": 0.025},
		},
	}

	got := make(map[int]float64, 3)
	for _, duration := range []int{6, 10, 15} {
		result := &OpenAIForwardResult{
			VideoCount:           1,
			VideoResolution:      VideoBillingResolution720P,
			VideoDurationSeconds: duration,
		}
		cost := svc.calculateOpenAIVideoCost(context.Background(), "grok-imagine-video-1.5", apiKey, result, 1.0)
		if cost == nil {
			t.Fatalf("%ds: cost 为 nil", duration)
		}
		got[duration] = cost.ActualCost
	}
	// 0.025/秒 → 6s=0.15 10s=0.25 15s=0.375
	for d, want := range map[int]float64{6: 0.15, 10: 0.25, 15: 0.375} {
		if diff := got[d] - want; diff > 1e-9 || diff < -1e-9 {
			t.Errorf("按秒口径被破坏：%ds=%.6f（期望 %.6f）", d, got[d], want)
		}
	}
}
