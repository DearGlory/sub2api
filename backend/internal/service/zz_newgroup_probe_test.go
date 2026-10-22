//go:build unit

package service

import (
	"context"
	"encoding/json"
	"os"
	"testing"
)

// 临时探针：用生产真实行验证新分组「Claude_Max「0注稳定」」为何不在广场。
// 跑完即删。

type ngCard struct {
	Platform string   `json:"platform"`
	Models   []string `json:"models"`
}

type ngAllowlist struct {
	Enabled bool     `json:"enabled"`
	Models  []string `json:"models"`
}

type ngGroup struct {
	ID                        int64       `json:"id"`
	Name                      string      `json:"name"`
	Description               string      `json:"description"`
	Platform                  string      `json:"platform"`
	SubscriptionType          string      `json:"subscription_type"`
	RateMultiplier            float64     `json:"rate_multiplier"`
	IsExclusive               bool        `json:"is_exclusive"`
	ModelPlazaEnabled         bool        `json:"model_plaza_enabled"`
	ImageRateIndependent      bool        `json:"image_rate_independent"`
	ImageRateMultiplier       *float64    `json:"image_rate_multiplier"`
	VideoRateIndependent      bool        `json:"video_rate_independent"`
	VideoRateMultiplier       *float64    `json:"video_rate_multiplier"`
	LongContextPricingEnabled bool        `json:"long_context_pricing_enabled"`
	PeakRateEnabled           bool        `json:"peak_rate_enabled"`
	PeakStart                 string      `json:"peak_start"`
	PeakEnd                   string      `json:"peak_end"`
	PeakRateMultiplier        *float64    `json:"peak_rate_multiplier"`
	ModelPricing              []ngCard    `json:"model_pricing"`
	ModelAllowlist            ngAllowlist `json:"model_allowlist"`
}

type ngChannel struct {
	ID                 int64                    `json:"id"`
	Name               string                   `json:"name"`
	Status             string                   `json:"status"`
	ModelMapping       map[string]map[string]string `json:"model_mapping"`
	BillingModelSource string                   `json:"billing_model_source"`
	GroupIDs           []int64                  `json:"group_ids"`
}

type ngFile struct {
	Groups   []ngGroup   `json:"groups"`
	Channels []ngChannel `json:"channels"`
}

func ngDeref(p *float64) float64 {
	if p == nil {
		return 0
	}
	return *p
}

func TestDiagNewGroupPlaza(t *testing.T) {
	path := os.Getenv("NG_FIXTURE")
	if path == "" {
		t.Skip("NG_FIXTURE not set")
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	var f ngFile
	if err := json.Unmarshal(raw, &f); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}

	groups := make([]Group, 0, len(f.Groups))
	for _, g := range f.Groups {
		gg := Group{
			ID: g.ID, Name: g.Name, Description: g.Description,
			Platform: g.Platform, SubscriptionType: g.SubscriptionType,
			RateMultiplier: g.RateMultiplier, IsExclusive: g.IsExclusive,
			ModelPlazaEnabled: g.ModelPlazaEnabled,
			ImageRateIndependent: g.ImageRateIndependent,
			ImageRateMultiplier: ngDeref(g.ImageRateMultiplier),
			VideoRateIndependent: g.VideoRateIndependent,
			VideoRateMultiplier: ngDeref(g.VideoRateMultiplier),
			LongContextPricingEnabled: g.LongContextPricingEnabled,
			PeakRateEnabled: g.PeakRateEnabled, PeakStart: g.PeakStart,
			PeakEnd: g.PeakEnd, PeakRateMultiplier: ngDeref(g.PeakRateMultiplier),
		}
		gg.ModelAllowlist.Enabled = g.ModelAllowlist.Enabled
		gg.ModelAllowlist.Models = g.ModelAllowlist.Models
		for _, c := range g.ModelPricing {
			gg.ModelPricing = append(gg.ModelPricing, ChannelModelPricing{
				Platform: c.Platform, Models: c.Models,
			})
		}
		groups = append(groups, gg)
	}
	channels := make([]Channel, 0, len(f.Channels))
	for _, c := range f.Channels {
		channels = append(channels, Channel{
			ID: c.ID, Name: c.Name, Status: c.Status,
			ModelMapping: c.ModelMapping, GroupIDs: c.GroupIDs,
			BillingModelSource: c.BillingModelSource,
		})
	}

	repo := &mockChannelRepository{
		listAllFn: func(ctx context.Context) ([]Channel, error) { return channels, nil },
	}
	svc := NewModelPlazaService(repo, &stubGroupRepoForAvailable{activeGroups: groups}, nil, nil, nil)
	out, err := svc.ListGroups(context.Background())
	if err != nil {
		t.Fatalf("ListGroups: %v", err)
	}

	t.Logf("广场返回分组数=%d", len(out))
	seen := false
	for _, pg := range out {
		if pg.ID == 129 {
			seen = true
			t.Logf("  >>> id=129 %q 出现，模型数=%d", pg.Name, len(pg.Models))
		}
	}
	if !seen {
		t.Logf("  >>> id=129 %q 未出现在广场输出中", "Claude_Max「0注稳定」")
	}
	for _, pg := range out {
		if pg.ID == 5 {
			t.Logf("  对照 id=5 %q 模型数=%d", pg.Name, len(pg.Models))
		}
	}
}
