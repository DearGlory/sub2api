//go:build unit

package service

import (
	"context"
	"testing"

	"github.com/stretchr/testify/require"
)

// TestListPlazaGroups_UnboundGroupRendersOwnPrices 覆盖本轮修复的核心场景：
// 视频 / Image 这类 composite 分组没有绑定任何渠道，开启 model_plaza_enabled
// 之后必须仍出现在广场上，并且展示的是分组自己的价卡价格。
func TestListPlazaGroups_UnboundGroupRendersOwnPrices(t *testing.T) {
	imagePrice := 0.05
	videoPrice := 0.2
	groups := []Group{{
		ID: 30, Name: "视频分组", Platform: PlatformComposite, RateMultiplier: 1,
		ModelPlazaEnabled: true,
		ModelPricing: []ChannelModelPricing{
			{Platform: "grok", Models: []string{"grok-imagine-video"},
				BillingMode: BillingModePerRequest, PerRequestPrice: &videoPrice},
			{Platform: "grok", Models: []string{"grok-imagine-image"},
				BillingMode: BillingModeImage, PerRequestPrice: &imagePrice},
		},
	}}
	// 关键：没有任何渠道绑定这个分组。
	svc := newPlazaService(nil, groups, nil)
	out, err := svc.ListGroups(context.Background())
	require.NoError(t, err)
	require.Len(t, out, 1, "未绑定渠道但开启独立展示的分组必须出现在广场")

	got := out[0]
	require.Equal(t, int64(30), got.ID)
	require.Len(t, got.Models, 2)

	prices := map[string]*float64{}
	for _, m := range got.Models {
		require.Equal(t, "grok", m.Platform, "composite 分组的模型平台取自价卡")
		require.NotNil(t, m.Pricing)
		prices[m.Name] = m.Pricing.PerRequestPrice
	}
	require.NotNil(t, prices["grok-imagine-video"])
	require.InDelta(t, 0.2, *prices["grok-imagine-video"], 1e-9)
	require.NotNil(t, prices["grok-imagine-image"])
	require.InDelta(t, 0.05, *prices["grok-imagine-image"], 1e-9)
}

// TestListPlazaGroups_UnboundGroupHiddenWhenFlagOff 确认开关关闭时行为完全不变：
// 未绑定渠道的分组依然不出现，避免这次改动改变现有分组的表现。
func TestListPlazaGroups_UnboundGroupHiddenWhenFlagOff(t *testing.T) {
	videoPrice := 0.2
	groups := []Group{{
		ID: 30, Name: "视频分组", Platform: PlatformComposite, RateMultiplier: 1,
		ModelPlazaEnabled: false,
		ModelPricing: []ChannelModelPricing{
			{Platform: "grok", Models: []string{"grok-imagine-video"},
				BillingMode: BillingModePerRequest, PerRequestPrice: &videoPrice},
		},
	}}
	svc := newPlazaService(nil, groups, nil)
	out, err := svc.ListGroups(context.Background())
	require.NoError(t, err)
	require.Empty(t, out, "开关关闭时未绑定渠道的分组保持不可见")
}

// TestListPlazaGroups_BoundGroupOwnPriceBeatsChannel 确认已绑定渠道的分组在开启
// 开关后，展示的是分组自己的价，而不是渠道那套共用价。
func TestListPlazaGroups_BoundGroupOwnPriceBeatsChannel(t *testing.T) {
	channelPrice := 0.2  // 渠道价（7 个分组共用）
	groupPrice := 0.05   // 该分组自己的价
	channels := []Channel{{
		ID: 30, Name: "ch-openai", Status: StatusActive, GroupIDs: []int64{20},
		ModelPricing: []ChannelModelPricing{{
			Platform: "openai", Models: []string{"grok-imagine-image"},
			BillingMode: BillingModeImage, PerRequestPrice: &channelPrice,
		}},
	}}
	groups := []Group{{
		ID: 20, Name: "Image", Platform: "openai", RateMultiplier: 1,
		ModelPlazaEnabled: true,
		ModelPricing: []ChannelModelPricing{{
			Platform: "openai", Models: []string{"grok-imagine-image"},
			BillingMode: BillingModeImage, PerRequestPrice: &groupPrice,
		}},
	}}
	svc := newPlazaService(channels, groups, nil)
	out, err := svc.ListGroups(context.Background())
	require.NoError(t, err)
	require.Len(t, out, 1)

	var found bool
	for _, m := range out[0].Models {
		if m.Name != "grok-imagine-image" {
			continue
		}
		found = true
		require.NotNil(t, m.Pricing)
		require.NotNil(t, m.Pricing.PerRequestPrice)
		require.InDelta(t, 0.05, *m.Pricing.PerRequestPrice, 1e-9,
			"分组价必须覆盖渠道共用价")
	}
	require.True(t, found, "分组自己的模型必须出现在广场上")
}

// TestListPlazaGroups_CompositeCardPlatformKept 确认 composite 价卡把 platform
// 写成 "composite" 时不会被当成"平台不明"丢弃：视频分组正是这种写法，
// 一旦丢弃，视频分组的价一个都显示不出来。
func TestListPlazaGroups_CompositeCardPlatformKept(t *testing.T) {
	videoPrice := 0.25
	groups := []Group{{
		ID: 30, Name: "视频分组", Platform: PlatformComposite, RateMultiplier: 1,
		ModelPlazaEnabled: true,
		ModelPricing: []ChannelModelPricing{
			{Platform: PlatformComposite, Models: []string{"seedance-2.0-0826-480p"},
				BillingMode: BillingModePerRequest, PerRequestPrice: &videoPrice},
			// 具体平台混用也要保留，两者都是合法写法。
			{Platform: "grok", Models: []string{"grok-imagine-video"},
				BillingMode: BillingModePerRequest, PerRequestPrice: &videoPrice},
		},
	}}
	svc := newPlazaService(nil, groups, nil)
	out, err := svc.ListGroups(context.Background())
	require.NoError(t, err)
	require.Len(t, out, 1)

	names := make([]string, 0, len(out[0].Models))
	for _, m := range out[0].Models {
		names = append(names, m.Name)
	}
	require.ElementsMatch(t,
		[]string{"seedance-2.0-0826-480p", "grok-imagine-video"}, names)
}

// TestListPlazaGroups_SelfDeclaredSkipsWrongPlatform 确认平台过滤没有被放松：
// composite 分组只接受具体可请求平台，普通分组只接受与自身平台相同的模型。
func TestListPlazaGroups_SelfDeclaredSkipsWrongPlatform(t *testing.T) {
	price := 0.1
	groups := []Group{{
		ID: 40, Name: "g-openai", Platform: "openai", RateMultiplier: 1,
		ModelPlazaEnabled: true,
		ModelPricing: []ChannelModelPricing{
			{Platform: "openai", Models: []string{"gpt-image-2"},
				BillingMode: BillingModeImage, PerRequestPrice: &price},
			// 平台与分组不符：必须被忽略，否则会把价格挂到错误的平台上。
			{Platform: "grok", Models: []string{"grok-imagine-image"},
				BillingMode: BillingModeImage, PerRequestPrice: &price},
		},
	}}
	svc := newPlazaService(nil, groups, nil)
	out, err := svc.ListGroups(context.Background())
	require.NoError(t, err)
	require.Len(t, out, 1)
	require.Len(t, out[0].Models, 1)
	require.Equal(t, "gpt-image-2", out[0].Models[0].Name)
}
