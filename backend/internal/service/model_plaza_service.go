package service

import (
	"context"
	"fmt"
	"sort"
	"strings"
)

// PlazaOfficialPricing 模型广场展示用的官方参考价（USD per token），与计费同源：
// LiteLLM → 内置兜底价卡 → 模型策略。字段为 nil 表示该项缺失（0 视为未配置）。
type PlazaOfficialPricing struct {
	InputPrice        *float64
	OutputPrice       *float64
	CacheWritePrice   *float64 // 5m 缓存写入（= LiteLLM cache_creation）
	CacheWrite1hPrice *float64 // 1h 缓存写入，仅计费会区分 5m/1h 时给出
	CacheReadPrice    *float64
	// Intervals 官方长上下文阶梯（多档时给出），不受分组开关影响。
	Intervals []PricingInterval
}

// PlazaModel 模型广场中单个模型条目：按实收口径合成的展示定价 + 官方参考价。
type PlazaModel struct {
	Name            string
	Platform        string
	Pricing         *ChannelModelPricing
	OfficialPricing *PlazaOfficialPricing
	// LongContextBasis 多档时的计价基准（整单 / 仅超出部分），单档为空。
	LongContextBasis ContextPricingBasis
	// TimePricing 计费会生效的分时倍率时段；无分时为 nil。
	TimePricing *TimePricingSchedule
}

// PlazaGroup 模型广场中以分组为顶层的条目。
//
// 与 AvailableGroupRef 相比多了 Description 与 Models；Models 来自该分组关联渠道的
// 支持模型（普通分组按分组平台隔离，Composite 分组展开关联渠道已配置的
// 具体平台），与「可用渠道」页口径一致。
type PlazaGroup struct {
	ID                 int64
	Name               string
	Description        string
	I18n               GroupI18n
	Platform           string
	SubscriptionType   string
	RateMultiplier     float64
	PeakRateEnabled    bool
	PeakStart          string
	PeakEnd            string
	PeakRateMultiplier float64
	IsExclusive        bool
	// 图片按次实付倍率：ImageRateIndependent 为 true 时，图片计费模型的实付
	// = 档位价 × ImageRateMultiplier，不乘分组/用户专属倍率（与计费口径一致）。
	ImageRateIndependent bool
	ImageRateMultiplier  float64
	// 视频独立倍率与图片独立倍率分别配置，开启时覆盖分组/用户专属倍率。
	VideoRateIndependent bool
	VideoRateMultiplier  float64
	// LongContextPricingEnabled 分组是否按上下文长度应用阶梯价；关闭时模型展示的是最低档。
	LongContextPricingEnabled bool
	Models                    []PlazaModel
}

// ModelPlazaService 聚合模型广场数据。
//
// 模型枚举来自渠道配置；token 模型的展示单价与阶梯由 BillingService 的阶梯表
// 查询给出（与扣费走同一条解析链与计费函数），图片/按次模型沿用渠道/分组档位价。
type ModelPlazaService struct {
	channelRepo    ChannelRepository
	groupRepo      GroupRepository
	pricingService *PricingService
	billingService *BillingService
	resolver       *ModelPricingResolver
}

// NewModelPlazaService 创建模型广场服务。
func NewModelPlazaService(
	channelRepo ChannelRepository,
	groupRepo GroupRepository,
	pricingService *PricingService,
	billingService *BillingService,
	resolver *ModelPricingResolver,
) *ModelPlazaService {
	return &ModelPlazaService{
		channelRepo:    channelRepo,
		groupRepo:      groupRepo,
		pricingService: pricingService,
		billingService: billingService,
		resolver:       resolver,
	}
}

// ListGroups 返回模型广场数据：每个活跃分组附带其可用模型与定价。
//
// 模型枚举口径与 ListAvailable 一致（Active 渠道、SupportedModels ∪ 全局定价回落、
// 平台隔离），仅把顶层从渠道换成分组：
//   - 渠道按 lower(name) 排序后遍历，保证同名模型去重结果确定；
//   - 同分组同名模型「先见者胜」，仅当已存条目无定价而新条目有定价时升级替换；
//   - token 模型的单价与阶梯按实收口径合成（见 ResolveContextPricingSchedule），
//     图片计费模型的档位价按实收口径合成（见 plazaImageDisplayPricing）；
//   - 每个模型附带官方参考价（查不到为 nil）；
//   - 只返回 Models 非空的分组；分组按 RateMultiplier 升序（同倍率按名称），
//     组内模型按名称排序。
//
// 可见性过滤（专属分组）不在此层做，由 handler 按登录态裁剪。
func (s *ModelPlazaService) ListGroups(ctx context.Context) ([]PlazaGroup, error) {
	channels, err := s.channelRepo.ListAll(ctx)
	if err != nil {
		return nil, fmt.Errorf("list channels: %w", err)
	}
	groups, err := s.groupRepo.ListActive(ctx)
	if err != nil {
		return nil, fmt.Errorf("list active groups: %w", err)
	}

	sort.SliceStable(channels, func(i, j int) bool {
		return strings.ToLower(channels[i].Name) < strings.ToLower(channels[j].Name)
	})

	byGroup := make(map[int64]*PlazaGroup, len(groups))
	groupEnt := make(map[int64]*Group, len(groups))
	order := make([]int64, 0, len(groups))
	for i := range groups {
		g := &groups[i]
		byGroup[g.ID] = &PlazaGroup{
			ID:                        g.ID,
			Name:                      g.Name,
			Description:               g.Description,
			I18n:                      g.I18n,
			Platform:                  g.Platform,
			SubscriptionType:          g.SubscriptionType,
			RateMultiplier:            g.RateMultiplier,
			PeakRateEnabled:           g.PeakRateEnabled,
			PeakStart:                 g.PeakStart,
			PeakEnd:                   g.PeakEnd,
			PeakRateMultiplier:        g.PeakRateMultiplier,
			IsExclusive:               g.IsExclusive,
			ImageRateIndependent:      g.ImageRateIndependent,
			ImageRateMultiplier:       g.ImageRateMultiplier,
			VideoRateIndependent:      g.VideoRateIndependent,
			VideoRateMultiplier:       g.VideoRateMultiplier,
			LongContextPricingEnabled: g.LongContextPricingEnabled,
		}
		groupEnt[g.ID] = g
		order = append(order, g.ID)
	}

	type modelKey struct {
		platform string
		name     string
	}
	// modelIdx[groupID][platform+modelName] = index into byGroup[groupID].Models
	modelIdx := make(map[int64]map[modelKey]int, len(groups))
	for i := range channels {
		ch := &channels[i]
		if ch.Status != StatusActive {
			continue
		}
		ch.normalizeBillingModelSource()
		supported := ch.SupportedModels()
		fillGlobalPricingFallback(s.pricingService, supported)

		for _, gid := range ch.GroupIDs {
			pg, ok := byGroup[gid]
			if !ok {
				continue
			}
			idx := modelIdx[gid]
			if idx == nil {
				idx = make(map[modelKey]int, len(supported))
				modelIdx[gid] = idx
			}
			for j := range supported {
				m := supported[j]
				if pg.Platform == PlatformComposite {
					if !isConcreteRequestPlatform(m.Platform) {
						continue
					}
				} else if m.Platform != pg.Platform {
					continue
				}
				key := modelKey{platform: m.Platform, name: m.Name}
				if at, seen := idx[key]; seen {
					// 先见者胜；仅当已存条目无定价而新条目有定价时升级。
					if pg.Models[at].Pricing == nil && m.Pricing != nil {
						pg.Models[at].Pricing = m.Pricing
					}
					continue
				}
				idx[key] = len(pg.Models)
				pg.Models = append(pg.Models, PlazaModel{
					Name:     m.Name,
					Platform: m.Platform,
					Pricing:  m.Pricing,
				})
			}
		}
	}

	officialMemo := make(map[string]*PlazaOfficialPricing)
	out := make([]PlazaGroup, 0, len(order))
	for _, gid := range order {
		pg := byGroup[gid]
		// 分组开启「独立展示」后，用分组自身配置确定模型清单：
		//   * 已绑定渠道的分组：模型清单以分组价卡为准，渠道枚举只用来补价格；
		//   * 未绑定任何渠道的分组（视频 / Image 这类 composite 分组）：
		//     模型清单直接来自分组自己的 model_pricing。
		// 两种情况都不再需要渠道级价卡才能显示价格。
		g := groupEnt[gid]
		if g.ModelPlazaEnabled {
			appendSelfDeclaredModels(ctx, pg, g)
		}
		// 关键（无条件生效，不受「独立展示」开关控制）：只要分组有自己的价卡，
		// 模型集就必须收敛到价卡本身。渠道枚举给出的是「渠道支持哪些模型」，
		// 不是「这个分组卖哪些模型」；把两者并集会让绑定了同一渠道的所有分组
		// 都显示该渠道的全部模型（典型：国产之光 混入 gpt-*/grok-*，
		// 视频分组的白名单把整套 claude/gemini 都显示出来）。
		//
		// 这条属于数据归属的不变量，不交给开关决定：否则管理员一旦关掉
		// 「独立展示」，串味立刻复发。开关只影响「没有价卡时是否用白名单兜底」。
		if countGroupCardModels(g) > 0 {
			fromChannels := append([]PlazaModel(nil), pg.Models...)
			pruneToGroupCards(pg, g)
			if len(pg.Models) == 0 && len(fromChannels) > 0 {
				pg.Models = fromChannels
			}
		}
		if len(pg.Models) == 0 {
			continue
		}
		sort.SliceStable(pg.Models, func(i, j int) bool {
			if pg.Models[i].Name != pg.Models[j].Name {
				return pg.Models[i].Name < pg.Models[j].Name
			}
			return pg.Models[i].Platform < pg.Models[j].Platform
		})
		for j := range pg.Models {
			s.fillDisplayPricing(ctx, &pg.Models[j], g)
			pg.Models[j].OfficialPricing = s.lookupOfficialPricing(ctx, pg.Models[j].Name, officialMemo)
		}
		out = append(out, *pg)
	}

	sort.SliceStable(out, func(i, j int) bool {
		if out[i].RateMultiplier != out[j].RateMultiplier {
			return out[i].RateMultiplier < out[j].RateMultiplier
		}
		return out[i].Name < out[j].Name
	})
	return out, nil
}

// countGroupCardModels 返回分组价卡声明的模型名总数（去重后）。
// 大于 0 表示这个分组通过价卡显式声明了自己卖哪些模型，此时广场模型集
// 必须收敛到这份清单，不能掺入渠道额外支持的模型。
func countGroupCardModels(g *Group) int {
	if g == nil || len(g.ModelPricing) == 0 {
		return 0
	}
	seen := make(map[string]struct{})
	for i := range g.ModelPricing {
		for _, name := range g.ModelPricing[i].Models {
			name = strings.ToLower(strings.TrimSpace(name))
			if name != "" {
				seen[name] = struct{}{}
			}
		}
	}
	return len(seen)
}

// pruneToGroupCards 把 pg.Models 收敛到分组价卡声明的模型集合。
//
// 平台维度必须一起考虑：同名模型可能挂在别的平台下（composite 分组尤其如此），
// 因此允许的条件是「名字出现在价卡里」，同时保留原本通过平台过滤的条目——
// 平台过滤在上游 appendSelfDeclaredModels 的 add 里已经做过，这里只按名字裁剪。
func pruneToGroupCards(pg *PlazaGroup, g *Group) {
	if pg == nil || g == nil {
		return
	}
	allowed := make(map[string]struct{})
	for i := range g.ModelPricing {
		for _, name := range g.ModelPricing[i].Models {
			name = strings.ToLower(strings.TrimSpace(name))
			if name != "" {
				allowed[name] = struct{}{}
			}
		}
	}
	if len(allowed) == 0 {
		return
	}
	kept := pg.Models[:0]
	for _, m := range pg.Models {
		if _, ok := allowed[strings.ToLower(strings.TrimSpace(m.Name))]; ok {
			kept = append(kept, m)
		}
	}
	pg.Models = kept
}

// appendSelfDeclaredModels 用分组自身配置确定该分组「拥有」的模型清单。
//
// 口径（重要）：广场展示的是「这个分组对外提供哪些模型」，不是「这个分组
// 允许请求哪些模型」。二者语义不同：
//   * model_pricing 的 models 是本分组真正对外售卖的模型清单 —— 唯一依据；
//   * model_allowlist 只是请求许可（gate），历史上被塞进大量跨分组的
//     「全家桶」条目（例如 Image / 视频分组的白名单里混着一百多个 gpt/
//     claude/grok 文本模型，国产之光的白名单里混着 grok-4.5/4.6/4.7），
//     若把白名单也当作模型清单，广场就会把别的分组的模型显示到这个分组下。
//     因此白名单不再参与广场模型枚举。
//
// 一个分组只有价卡、没有渠道时（视频 / Image 这类 composite 分组）同样
// 由价卡给出模型清单，所以这里不再依赖渠道是否绑定。
//
// 对于还没有价卡、但开启了白名单的分组，白名单是它唯一的模型声明，此时
// 退化为用白名单（这是历史行为，用于尚未定价的分组仍能在广场出现）。
func appendSelfDeclaredModels(ctx context.Context, pg *PlazaGroup, g *Group) {
	if pg == nil || g == nil {
		return
	}
	type selfKey struct {
		platform string
		name     string
	}
	seen := make(map[selfKey]struct{}, len(pg.Models))
	for i := range pg.Models {
		seen[selfKey{platform: pg.Models[i].Platform, name: strings.ToLower(pg.Models[i].Name)}] = struct{}{}
	}

	add := func(platform, name string) {
		platform = strings.TrimSpace(platform)
		name = strings.TrimSpace(name)
		if platform == "" || name == "" {
			return
		}
		// 与渠道枚举的过滤口径保持一致：composite 只接受具体可请求的平台，
		// 普通分组只接受与自身平台相同的模型。
		//
		// composite 价卡的 platform 常常就写成 "composite"（视频分组即如此，
		// 它的价卡不记录目标平台，目标平台在 composite_model_routes 里）。
		// 这种情况不能当作"平台不明"丢弃，否则视频分组的价一个都显示不出来；
		// 保留 composite 原值，让定价解析与计费按 composite 语义处理。
		if pg.Platform == PlatformComposite {
			if platform != PlatformComposite && !isConcreteRequestPlatform(platform) {
				return
			}
		} else if platform != pg.Platform {
			return
		}
		key := selfKey{platform: platform, name: strings.ToLower(name)}
		if _, ok := seen[key]; ok {
			return
		}
		seen[key] = struct{}{}
		pg.Models = append(pg.Models, PlazaModel{Name: name, Platform: platform})
	}

	// platformFor 决定模型归到哪个平台：
	//   * composite 分组：就用价卡自己声明的平台（它的价卡 platform 字段就是
	//     该模型实际请求的平台）；
	//   * 普通分组：价卡没写平台时退回分组平台；写了别的平台则原样返回，
	//     随后被 add 的平台过滤挡掉——否则会把其它平台的价挂到本分组上。
	platformFor := func(cardPlatform string) string {
		if cardPlatform == "" {
			return pg.Platform
		}
		return cardPlatform
	}

	// 1) 分组价卡：本分组对外提供的模型清单（唯一权威来源）。
	hasCards := false
	for i := range g.ModelPricing {
		card := &g.ModelPricing[i]
		for _, name := range card.Models {
			hasCards = true
			add(platformFor(card.Platform), name)
		}
	}

	// 2) 白名单：仅在该分组还没有任何价卡时作为退化的模型声明。
	//    有价卡的分组一律不信白名单——它是请求许可，不是售卖清单。
	if !hasCards && g.ModelAllowlist.Enabled {
		for _, name := range g.ModelAllowlist.Models {
			if strings.Contains(name, "*") {
				continue // 通配条目无法展开成具体模型名，交给价卡覆盖
			}
			add(platformFor(""), name)
		}
	}
}

// fillDisplayPricing 把模型的展示定价换成实收口径：
// token 模型取计费阶梯表（单价与档位均由真实计费函数得出），
// 图片/按次模型（或阶梯表不可用时）沿用渠道定价与分组图片档位价。
func (s *ModelPlazaService) fillDisplayPricing(ctx context.Context, m *PlazaModel, g *Group) {
	if groupPricing := matchGroupModelPricing(g, m.Name); groupPricing != nil {
		m.Pricing = groupPricing
		// 分组模型级固定价就是实收价，不能再被分组图片兜底档位覆盖。
		// 否则模型广场会显示 image_price_1k/2k/4k，而实际按 model_pricing 扣费。
		if groupPricing.BillingMode == BillingModeImage || groupPricing.BillingMode == BillingModePerRequest {
			return
		}
	}
	if s.billingService != nil && s.resolver != nil {
		sched, err := s.billingService.ResolveContextPricingSchedule(ctx, s.resolver, ContextPricingScheduleInput{
			Model:    m.Name,
			Group:    g,
			Platform: m.Platform,
		})
		if err == nil && sched != nil && len(sched.Tiers) > 0 {
			m.Pricing = plazaPricingFromSchedule(m.Pricing, sched)
			if len(sched.Tiers) > 1 {
				m.LongContextBasis = sched.Basis
			}
			m.TimePricing = sched.TimePricing
			return
		}
	}
	m.Pricing = plazaImageDisplayPricing(m.Pricing, g)
}

// plazaPricingFromSchedule 把阶梯表压成展示用的 ChannelModelPricing：
// 平价取首档单价，多档时 Intervals 逐档给出绝对单价；图片/按次字段沿用原始定价。
func plazaPricingFromSchedule(raw *ChannelModelPricing, sched *ContextPricingSchedule) *ChannelModelPricing {
	out := &ChannelModelPricing{BillingMode: BillingModeToken}
	if raw != nil {
		out.ImageInputPrice = raw.ImageInputPrice
		out.ImageOutputPrice = raw.ImageOutputPrice
		out.PerRequestPrice = raw.PerRequestPrice
		out.ReasoningEffortMultipliers = reasoningEffortMultipliersFromPricing(raw)
	}
	first := sched.Tiers[0]
	out.InputPrice = first.Input
	out.OutputPrice = first.Output
	out.CacheWritePrice = first.CacheWrite
	out.CacheWrite1hPrice = first.CacheWrite1h
	out.CacheReadPrice = first.CacheRead
	if len(sched.Tiers) > 1 {
		out.Intervals = plazaIntervalsFromTiers(sched.Tiers)
	}
	return out
}

func plazaIntervalsFromTiers(tiers []ContextPricingTier) []PricingInterval {
	intervals := make([]PricingInterval, 0, len(tiers))
	for i, t := range tiers {
		intervals = append(intervals, PricingInterval{
			MinTokens:         t.MinTokens,
			MaxTokens:         t.MaxTokens,
			TierLabel:         t.Label,
			InputPrice:        t.Input,
			OutputPrice:       t.Output,
			CacheWritePrice:   t.CacheWrite,
			CacheWrite1hPrice: t.CacheWrite1h,
			CacheReadPrice:    t.CacheRead,
			SortOrder:         i,
		})
	}
	return intervals
}

// plazaImageDisplayPricing 为图片计费模型合成展示定价，使档位价与实收口径一致：
// 每档（1K/2K/4K）单价 = 分组图片价 > 渠道同档位价 > 渠道默认按次价，无价的档不展示。
// 分组未配任何图片价、或定价非图片模式时原样返回。返回克隆，不修改入参
// （渠道定价指针指向缓存共享数据）。
func plazaImageDisplayPricing(p *ChannelModelPricing, g *Group) *ChannelModelPricing {
	if p == nil || g == nil || p.BillingMode != BillingModeImage {
		return p
	}
	if g.ImagePrice1K == nil && g.ImagePrice2K == nil && g.ImagePrice4K == nil {
		return p
	}
	channelTierPrice := func(label string) *float64 {
		for i := range p.Intervals {
			if p.Intervals[i].TierLabel == label && p.Intervals[i].PerRequestPrice != nil {
				return p.Intervals[i].PerRequestPrice
			}
		}
		return p.PerRequestPrice
	}
	tiers := []struct {
		label      string
		groupPrice *float64
	}{
		{"1K", g.ImagePrice1K},
		{"2K", g.ImagePrice2K},
		{"4K", g.ImagePrice4K},
	}
	clone := *p
	clone.Intervals = make([]PricingInterval, 0, len(tiers))
	for i, t := range tiers {
		price := t.groupPrice
		if price == nil {
			price = channelTierPrice(t.label)
		}
		if price == nil {
			continue
		}
		v := *price
		clone.Intervals = append(clone.Intervals, PricingInterval{
			TierLabel:       t.label,
			PerRequestPrice: &v,
			SortOrder:       i,
		})
	}
	return &clone
}

// lookupOfficialPricing 查询模型的官方参考价（与计费同源：LiteLLM → 内置兜底 → 模型策略），
// 带 memo 避免同名模型重复解析。官方阶梯按无分组、无渠道的口径查阶梯表。
// billingService 为 nil（测试场景）或查不到时返回 nil。
func (s *ModelPlazaService) lookupOfficialPricing(ctx context.Context, modelName string, memo map[string]*PlazaOfficialPricing) *PlazaOfficialPricing {
	if s.billingService == nil {
		return nil
	}
	if cached, ok := memo[modelName]; ok {
		return cached
	}
	var result *PlazaOfficialPricing
	if mp, err := s.billingService.GetModelPricing(modelName); err == nil && mp != nil {
		result = &PlazaOfficialPricing{
			InputPrice:      nonZeroPtr(mp.InputPricePerToken),
			OutputPrice:     nonZeroPtr(mp.OutputPricePerToken),
			CacheWritePrice: nonZeroPtr(mp.CacheCreationPricePerToken),
			CacheReadPrice:  nonZeroPtr(mp.CacheReadPricePerToken),
		}
		// 计费只在支持 5m/1h 分档时使用 1h 价，其余情况 1h 价对用户无意义。
		if mp.SupportsCacheBreakdown {
			result.CacheWrite1hPrice = nonZeroPtr(mp.CacheCreation1hPrice)
		}
		if s.resolver != nil {
			sched, schedErr := s.billingService.ResolveContextPricingSchedule(ctx, s.resolver, ContextPricingScheduleInput{Model: modelName})
			if schedErr == nil && sched != nil && len(sched.Tiers) > 1 {
				result.Intervals = plazaIntervalsFromTiers(sched.Tiers)
			}
		}
		if result.InputPrice == nil && result.OutputPrice == nil && result.CacheWritePrice == nil &&
			result.CacheWrite1hPrice == nil && result.CacheReadPrice == nil && len(result.Intervals) == 0 {
			result = nil
		}
	}
	memo[modelName] = result
	return result
}
