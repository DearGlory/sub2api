package handler

import (
	"context"
	"database/sql"

	"github.com/Wei-Shaw/sub2api/internal/poison"
	"github.com/Wei-Shaw/sub2api/internal/service"
)

// SetupPoisonGuard 在服务启动时装配命中后的处置逻辑。
//
// 该函数的全部作用就是给 poison 包注入回调；未调用时检测仍能拦截客户侧内容，
// 只是不会拉黑出口 IP、不会轮换代理、不会停用账号。删除本功能时一并删除本文件。
//
// 传入参数刻意保持在最小集合（db + 两个 service），避免改动 SetupRouter 的
// 既有参数列表。
func SetupPoisonGuard(db *sql.DB, proxyService *service.ProxyService, accountService *service.AccountService) {
	if db == nil {
		return
	}

	egress := poison.NewEgressStore(db)
	prober := poison.DefaultEgressProber()

	rotator := &poison.Rotator{
		ActiveProxies: func(ctx context.Context) ([]poison.RotationCandidate, error) {
			if proxyService == nil {
				return nil, nil
			}
			proxies, err := proxyService.ListActive(ctx)
			if err != nil {
				return nil, err
			}
			out := make([]poison.RotationCandidate, 0, len(proxies))
			for i := range proxies {
				p := &proxies[i]
				out = append(out, poison.RotationCandidate{
					ID:       p.ID,
					Name:     p.Name,
					Host:     p.Host,
					Port:     p.Port,
					Protocol: p.Protocol,
				})
			}
			return out, nil
		},
		Blocked: func(ctx context.Context) (map[int64]struct{}, error) {
			return egress.BlockedProxyIDs(ctx)
		},
		IsEgressBlocked: func(ctx context.Context, ip string) (bool, error) {
			return egress.IsBlocked(ctx, ip)
		},
		Prober: prober,
	}

	poison.AttachHandler(&poison.Handler{
		Egress:  egress,
		Prober:  prober,
		Rotator: rotator,
		DisableAccount: func(ctx context.Context, accountID int64) error {
			// 状态改 disabled，与后台手动停用的语义一致；调度随即失效。
			status := service.StatusDisabled
			_, err := accountService.Update(ctx, accountID, service.UpdateAccountRequest{
				Status: &status,
			})
			return err
		},
		RebindProxy: func(ctx context.Context, accountID int64, proxyID int64) error {
			// 把账号的 proxy_id 换成另一个可用代理。
			id := proxyID
			_, err := accountService.Update(ctx, accountID, service.UpdateAccountRequest{
				ProxyID: &id,
			})
			return err
		},
	})
}
